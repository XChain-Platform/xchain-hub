/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - State Anchor Publisher (the ANCHOR action pipeline)
 *
 * Publishes the protocol's on-chain commitments on DOGE (and ONLY on DOGE,
 * so BTC/LTC carry zero anchor bytes; spec: protocol/actions/ANCHOR.md):
 *
 *   ANCHOR v0: the latest quorum-signed state checkpoint per chain (signatures
 *               come straight from state_checkpoints; no new signing round).
 *   ANCHOR v1: a checkpoint + a compressed archive of full cross_chain_matches
 *               rows (incl. their validator_signatures + the cross_chain
 *               capability_snapshots needed to re-verify them). This is what
 *               makes cross-chain match data recoverable from a full chain
 *               parse with no surviving hub DB.
 *   ANCHOR v2: continuation chunks when a v1 archive exceeds the per-action
 *               data budget.
 *
 * The v1 canonical covers the archive structure (batch_seq, count, crc32 of the
 * UNCOMPRESSED JSON, total_chunks), so stored checkpoint signatures cannot
 * authenticate an archive. The publisher therefore runs a fresh signing round
 * (XANC_SIGN_REQ / XANC_SIGN) in which every follower verifies the proposed
 * archive AGAINST ITS OWN cross_chain_matches + capability_snapshots before
 * co-signing (a Byzantine elected publisher cannot collect a quorum for
 * fabricated matches or fabricated snapshots). After on-chain publication the
 * leader broadcasts XANC_FINALIZED so every hub back-fills batch_seq /
 * archived_status (audit metadata; harmless if missed, re-archival is
 * deduplicated by recovery's latest-status-wins).
 *
 * Re-archival rule: a match is pending when batch_seq IS NULL (never archived)
 * OR archived_status <> status (retracted after being archived as finalized).
 *
 * Election (attestation-style hash-ordering, spec §8.2 idiom): each pending
 * checkpoint elects its OWN publisher (oracle_publish validators at the
 * checkpoint's snapshot_block ordered by SHA256(election key ‖ pubkey)
 * ascending, where the key binds chain/network/seq/snapshot_block). Rank 0
 * publishes; if it hasn't after ANCHOR_ELECTION_TOLERANCE_BLOCKS BTC blocks,
 * rank 1 also qualifies, and so on (the DB row's anchor_txid IS NULL is the
 * shared "still pending" signal, so a late rank-0 and an early rank-1 can both
 * publish). The on-chain state never diverges: both build byte-identical
 * commitments, and the anchor-reward rail does NOT inflate: recordAnchorReward
 * deterministically keeps a single reward per (checkpoint_seq, reward_type)
 * across distinct publisher pubkeys (see below), so the only residual cost of
 * the race is the duplicate DOGE tx fee. A different
 * validator therefore publishes each chain's anchor in a cycle, FROM ITS OWN
 * DOGE WALLET (no UTXO contention between the per-chain anchors, per-chain
 * fault isolation, and publish work plus its DOGE cost spreads across the
 * federation). Each successful publish records an `anchor_<chain>` /
 * `anchor_archive` reward on the validator_rewards rail (oracle-round
 * pattern; recordAnchorReward collapses failover-race duplicates to a single
 * deterministic per-(round,type) winner, best-effort push to the BTC indexer
 * for COLLECT). The v1 archive round elects a single leader the same way with a
 * per-election-block key. Signer resolution, balance checks and the DOGE
 * broadcast pipeline mirror OraclePublisher (the DB is
 * the durable queue: pending checkpoints are rows with anchor_txid IS NULL,
 * pending matches per the rule above; crash-safe with no separate WAL file).
 * The degenerate single-validator federation keeps today's behavior: one
 * publisher, serialized spends from one wallet. Supersedes the legacy
 * XDEXANCHOR raw payload (CrossChainDexAnchor, retired 2026-06-11 after
 * ANCHOR verified end-to-end on mainnet).
 *
 ********************************************************************/

const zlib              = require('zlib');
const crypto            = require('crypto');
const axios             = require('axios');
const coins             = require('./coins');
const EncoderClient     = require('./EncoderClient.js');
const SpendGuard        = require('./lib/spend_guard.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('./lib/quorum_network.js');
const { isAmbiguousSendError } = require('./lib/idempotent_broadcast.js');
const { sumUtxosCoins, summarizeUtxoConfirmations } = require('./lib/utxo_balance.js');
const { forwardableUtxos } = require('./lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('./lib/two_phase_guard.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const StateCheckpointEngine = require('./StateCheckpointEngine.js');
const swq                   = require('./stake_weighted_quorum.js');
const eq                    = require('./equivocation_header.js');
const ckpt                  = require('./checkpoint_commitment_activation.js');
const ccr                   = require('./cross_chain_royalty_activation.js');
const ar                    = require('./anchor_reward_activation.js');

const XANC_SIGN_REQ  = 'XANC_SIGN_REQ';
const XANC_SIGN      = 'XANC_SIGN';
const XANC_FINALIZED = 'XANC_FINALIZED';
const XANC_V0_DONE   = 'XANC_V0_DONE';
// Publisher-attestation round (anchor-reward re-derivation flag-day): the elected
// checkpoint publisher collects a 2f+1 oracle_publish quorum ATTESTING that it is the
// legitimate reward earner, carried on-chain in ANCHOR v4/v5 so the indexer DERIVES the
// reward instead of trusting the forgeable push. Mirrors XANC_SIGN_REQ/SIGN.
const XANCPUB_SIGN_REQ = 'XANCPUB_SIGN_REQ';
const XANCPUB_SIGN     = 'XANCPUB_SIGN';

// Archive publisher-attestation round (archive-reward re-derivation flag-day):
// the elected ARCHIVE leader collects a 2f+1 oracle_publish quorum attesting that it is
// the anchor_archive reward earner, carried on-chain in ANCHOR v6 so the indexer DERIVES
// the archive reward and the last key-authenticated push is retired. Mirrors
// XANCPUB_SIGN_REQ/SIGN for the archive leg.
const XANCARCHPUB_SIGN_REQ = 'XANCARCHPUB_SIGN_REQ';
const XANCARCHPUB_SIGN     = 'XANCARCHPUB_SIGN';

// Reward-attestation federation (derive-relocation flag-day). The
// anchor_reward_attestations row is written ONLY by the elected publisher, and hub_db_sync
// carries it to that hub's OWN indexer subscribers and nowhere else, so a federation whose
// publisher rotates per checkpoint leaves every hub holding a disjoint subset and every
// indexer deriving only what its own hub happened to publish. This message closes that: the
// publisher broadcasts the confirmed row, and every receiver re-verifies the XANCPUB quorum
// against its OWN oracle_publish set at snapshot_block and re-proves the DOGE anchor mined
// before writing its copy. The wire is TRANSPORT, never trust: nothing a receiver writes is
// taken from the message except the tuple identity it independently re-derives the canonical
// from, and the frozen reward amount is never read off the wire at all.
const XANCREWARD = 'XANCREWARD';

// Default retention window for anchor_published_checkpoints and
// anchor_published_archives, mirroring OraclePublisher's ~90-day
// oracle_published_rounds window.
const DEFAULT_ANCHOR_MARKER_RETENTION_MS = 7776000000;   // 90 days
// Multiple of anchorIntentTtlMs the effective window is FLOORED at. The TTL is the
// exact horizon past which _anchorIntentHolds already answers false, so the multiple
// is pure margin over a re-armed intent, not the safety property itself.
const ANCHOR_MARKER_RETENTION_TTL_SAFETY = 8;

// Fixed serialization order for an archived match row (the crc32 and the
// follower byte-comparison depend on this exact order). Spec §Archive JSON.
// `id` (the hub-assigned mirror cursor) is archived for per-hub provenance
// only; settlement order is (snapshot_block, match_id), never `id`, because a
// per-hub AUTO_INCREMENT must not order consensus state (xchain-indexer
// db.js getEffectiveUnsettledMatches). Recovery rebuilds the row under its
// original id to preserve archive byte-parity, not to fix a settlement order
// (xchain-indexer recovery.js). Archives published before this field exist
// without it; recovery tolerates both shapes.
const MATCH_KEYS = ['id', 'match_id', 'snapshot_block', 'network',
    'a_chain', 'a_action_index', 'a_kind', 'a_tick', 'a_amount', 'a_filled_before', 'a_ownership', 'a_payout_addr', 'a_payout_legs',
    'b_chain', 'b_action_index', 'b_kind', 'b_tick', 'b_amount', 'b_filled_before', 'b_ownership', 'b_payout_addr', 'b_payout_legs',
    'effective_time', 'finalizing_view', 'validator_signatures', 'status'];

// Fixed serialization order for an archived cross-chain CALL relay row (XCALL
// dispatch/result phases); same crc32/byte-comparison rules as MATCH_KEYS.
// Without these in the archive, a full-chain-parse recovery could not rebuild
// the injected executions/callbacks and would diverge from live nodes.
// `id` (the hub-assigned AUTO_INCREMENT primary key) IS archived for per-hub
// provenance only; injection order is determined by (snapshot_block, call_id),
// not by `id`. Recovery must preserve the original id so the indexer mirror
// cursor stays consistent, but consensus ordering never uses it.
const CALL_KEYS = ['id', 'call_id', 'phase', 'snapshot_block', 'network',
    'source_chain', 'source_action_index', 'source_contract_index',
    'target_chain', 'target_contract_index', 'method', 'params_json',
    'gas_limit', 'cross_hops', 'effective_time', 'finalizing_view', 'result_status',
    'return_payload_b64', 'validator_signatures', 'status'];

class StateAnchorPublisher {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub.db;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        this.network     = (hub && hub.network) ? hub.network : '';   // STAKE_WEIGHTED_QUORUM gate

        let cfg = hub.p2pConfig || {};
        // Derivation of the ANCHOR sizing/timing magnitudes.
        // Read this before retuning any of them. What is load-bearing is the
        // RELATIONSHIP each number encodes, not the round figure; none of these is
        // consensus data (they are per-hub operator knobs), but two of them have a
        // hard on-chain ceiling behind them. The arithmetic below is pinned by
        // test/unit/StateAnchorPublisher.constant-derivations.test.js, so a retune
        // that breaks a bound fails there instead of on-chain.
        //
        // ANCHOR_CHUNK_MAX_BYTES = 6000 (base64url chars per archive chunk).
        //   Hard ceiling: MAX_ACTION_DATA_LENGTH = 8192 compiled bytes
        //   (xchain-documentation/protocol/constants.js). The DECODER is the
        //   arbiter and silently DROPS a larger action, so an oversize anchor is
        //   lost fleet-wide, not rejected loudly. Chunk 0 does not travel alone: it
        //   rides inside the v1/v6 HEAD next to the checkpoint prefix (four 64-hex
        //   hashes plus the chain/network/seq/index fields, ~322 B at mainnet
        //   heights) and the signature lists, at 194 B per (PUBKEY,SIG) pair; a v6
        //   adds ~67 B for PUBLISHER + ATTEST_SIG_COUNT plus another 194 B per
        //   attesting signer. So 8192 - 6000 - 322 leaves ~1870 B of head budget:
        //   about nine signature pairs on a v1, or four wrapper + four attestation
        //   pairs on a v6. THAT RESERVE is why the value is 6000 and not something
        //   nearer 8000. It binds chunk 0 only (a v2 continuation carries ~30 B of
        //   overhead), but one uniform slice keeps _splitChunks trivial.
        //   Tuner rule: this is the knob to LOWER when the federation grows. A v6
        //   with a 5+5 quorum needs chunkMaxBytes <= ~5860, a 7+7 quorum <= ~5080.
        //   Raising it costs fewer v2 txs but overflows the head first.
        //
        // ANCHOR_MATCH_BATCH_SIZE = 200 is a LATENCY trigger, not a size cap: 200
        //   pending rows flush an archive early rather than waiting out
        //   ANCHOR_INTERVAL_MS (24h), bounding how much settled cross-chain state
        //   exists only in hub DBs. ANCHOR_MAX_BATCH = 1000 is the per-cycle SQL
        //   LIMIT and therefore the DOGE SPEND bound: archived rows are dominated
        //   by validator signatures and do not compress (~0.55 KB of gzip+base64
        //   per settled match), so 1000 rows is ~550 KB, ~93 chunks, ~93 DOGE
        //   transactions in one cycle; 200 rows is ~19. Both trade cost against
        //   archive latency and neither affects what the archive MEANS: too large
        //   spends more DOGE per cycle, too small drains the backlog more slowly.
        this.enabled       = String(process.env.ANCHOR_ENABLED || cfg.ANCHOR_ENABLED || 'true') !== 'false';
        this.intervalMs    = parseInt(process.env.ANCHOR_INTERVAL_MS      || cfg.ANCHOR_INTERVAL_MS      || '86400000'); // daily
        this.batchSize     = parseInt(process.env.ANCHOR_MATCH_BATCH_SIZE || cfg.ANCHOR_MATCH_BATCH_SIZE || '200');
        this.maxBatch      = parseInt(process.env.ANCHOR_MAX_BATCH        || cfg.ANCHOR_MAX_BATCH        || '1000');
        this.chunkMaxBytes = parseInt(process.env.ANCHOR_CHUNK_MAX_BYTES  || cfg.ANCHOR_CHUNK_MAX_BYTES  || '6000');
        this.roundTimeoutMs = parseInt(process.env.ANCHOR_ROUND_TIMEOUT_MS || cfg.ANCHOR_ROUND_TIMEOUT_MS || '120000');
        this.chunkRetryDelayMs = parseInt(process.env.ANCHOR_CHUNK_RETRY_MS || cfg.ANCHOR_CHUNK_RETRY_MS || '2500');
        // Ambiguous-send existence poll: how long to wait for a maybe-
        // accepted anchor to reach the indexer's mined view before deferring.
        this.ambiguousPollAttempts = parseInt(process.env.ANCHOR_AMBIGUOUS_POLL_ATTEMPTS || cfg.ANCHOR_AMBIGUOUS_POLL_ATTEMPTS || '3');
        this.ambiguousPollDelayMs  = parseInt(process.env.ANCHOR_AMBIGUOUS_POLL_MS       || cfg.ANCHOR_AMBIGUOUS_POLL_MS       || '5000');
        // Failover-ladder step (see the derivation above; the ladder itself is in
        // _rankUnlocked). The unit is BTC BLOCKS, not wall clock, precisely so
        // every hub computes the same rank unlock without clock sync; 36 blocks is
        // ~6h at the 10-minute target. The ORDERING is the load-bearing part:
        //   round timeout (120s) + DOGE burial (60 confs, ~1h)
        //     <<  36 blocks (~6h)  <<  ANCHOR_INTERVAL_MS (24h)
        // Left inequality: a healthy but slow leader is never overtaken, so the
        // federation does not pay DOGE twice for the same checkpoint (it also keeps
        // the on-chain verification wait in _handleV0Done well inside one rank).
        // Right inequality: ranks 1-3 unlock at ~6/12/18h, so up to three backups
        // still get a slot inside one publishing cycle and a dead rank 0 cannot
        // cost the federation a whole day of anchoring. Anything in ~6..144 blocks
        // (1h..24h) preserves both bounds; below the DOGE burial window it burns
        // DOGE on duplicate anchors, above ~144 a dead leader stalls a cycle.
        // Never a divergence risk in either direction: concurrent unlocked
        // publishers build byte-identical archives (see _rankUnlocked).
        // The same value also bounds how far a peer's claimed election_block may
        // sit from our own BTC tip in _handleSignReq (anti-spam only; the security
        // property there is the DB byte-match).
        this.electionToleranceBlocks = parseInt(process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS || cfg.ANCHOR_ELECTION_TOLERANCE_BLOCKS || '36');
        // Failover wake. The ladder above only unlocks a rank when
        // something RE-EVALUATES it, and rank is evaluated only inside flush(); with
        // flush on the 24h interval plus size triggers, the "ranks 1-3 get a slot
        // inside one publishing cycle" bound was unreachable except by phase luck, so
        // a dead rank 0 stranded v0/archive work for a whole cycle exactly as the
        // right inequality above says it must not. This is the cadence at which a
        // BACKUP re-checks whether its rank has come up. It sits inside the ordering
        // rather than beside it:
        //   round timeout (120s)  <<  15 min  <<  36 blocks (~6h)
        // Left: a wake never fires inside a leader's own publish attempt. Right: the
        // wake is a fraction of a ladder step, so it costs at most that much latency
        // on top of the unlock it is watching for. It does NOT change how often a
        // healthy leader anchors: a wake flush runs in failover-only mode, which
        // skips every election this hub leads (see flush / _publishPendingCheckpoints
        // / _startArchiveRound), so rank-0 publishing keeps its interval and size
        // triggers and the federation still pays for one anchor per checkpoint.
        this.rankWakeMs = parseInt(process.env.ANCHOR_RANK_WAKE_MS || cfg.ANCHOR_RANK_WAKE_MS || '900000');  // 15 min
        // Startup catch-up flush. The interval timer fires first after a FULL
        // ANCHOR_INTERVAL_MS, and the rank wake runs failover-only, so a hub that was
        // recreated more often than once per interval never ran a leader flush at
        // all: the five testnet validators cut checkpoints every 6 BTC blocks for
        // weeks and anchored none of them, with no log line saying so.
        // One normal flush shortly after start closes that hole. It is idempotent
        // by construction (a row already anchored carries anchor_txid, and a peer's
        // anchor is stamped by the V0_DONE drain that runs first inside flush), so
        // a rolling restart of the whole federation still pays for one anchor per
        // checkpoint. The delay lets the signer hooks, the BTC tip and the DOGE
        // balance source settle first; flush is fail-closed on all three anyway.
        // 0 disables (tests, and operators who want the interval to be the only
        // leader cadence); garbage or a negative value falls back to the default.
        this.startupFlushMs = parseInt(process.env.ANCHOR_STARTUP_FLUSH_MS || cfg.ANCHOR_STARTUP_FLUSH_MS, 10);
        if(!Number.isFinite(this.startupFlushMs) || this.startupFlushMs < 0) this.startupFlushMs = 60000;
        this._startupTimer = null;
        // CONFIRMED INPUTS ONLY, the same rule the PRICE rail adopted.
        // Spending our own unconfirmed change chains every anchor onto the one
        // before it. Dogecoin Core 1.14 miners score each transaction on its OWN
        // fee rate, not the ancestor package, so a well-paid child never lifts a
        // cheap or stuck parent: one anchor that does not mine then strands every
        // anchor built on its change until an operator clears the mempool. Each
        // anchor must stand alone and be judged on its own rate; the encoder's
        // package uplift stays as the safety net on chains that do score by package.
        // The escape hatch is for venues that mine on demand (regtest), where
        // chaining costs nothing and waiting for a confirmation would stall a harness.
        // Archive CHUNKS are the one designed exception: they descend from the head
        // on purpose and are always allowed to spend it (see _publishArchive).
        this.allowUnconfirmedInputs =
            String(process.env.ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS ||
                   cfg.ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS || 'false') === 'true';
        // Set by a flush that had to stand down for want of a confirmed input while
        // it (probably) led a pending row. The next rank wake then runs a NORMAL
        // flush instead of failover-only, so the deferral costs one wake period
        // (15 min) rather than one ANCHOR_INTERVAL_MS (24 h). Cleared at the start
        // of every normal flush; re-set only by another deferral, so a wallet that
        // has confirmed outputs again returns the wake to failover-only the first
        // time it runs. This is the one case where the wake may publish a led row.
        this._leaderRetryDue = false;
        this.noConfirmedUtxoDeferrals = 0;
        this.lastNoConfirmedUtxoAt    = null;
        this.lastUtxoReserve          = null;   // { total, confirmed, unconfirmed, known, at }
        // Confirmation watchdog over this hub's OWN anchor broadcasts (checkpoint
        // anchors, archive heads and chunks). Without it an anchor that never mines
        // leaves getanchorstatus reporting a healthy last publish while the wallet's
        // whole balance sits as change behind the stuck transaction. Same design as
        // the PRICE rail's watchdog: in-memory, fail-soft, never re-broadcasts or
        // fee-bumps.
        this._pendingConfirmations   = new Map();   // txid -> { txid, kind, ref, sentAt }
        this.pendingConfirmationsMax = 200;
        this.confirmCheckIntervalMs  = parseInt(process.env.ANCHOR_CONFIRM_CHECK_MS || cfg.ANCHOR_CONFIRM_CHECK_MS, 10);
        if(!Number.isFinite(this.confirmCheckIntervalMs) || this.confirmCheckIntervalMs < 0) this.confirmCheckIntervalMs = 300000;   // 5 min
        this.confirmStaleMs = parseInt(process.env.ANCHOR_CONFIRM_STALE_MS || cfg.ANCHOR_CONFIRM_STALE_MS, 10);
        if(!Number.isFinite(this.confirmStaleMs) || this.confirmStaleMs < 0) this.confirmStaleMs = 1800000;   // 30 min
        this._confirmTimer            = null;
        this.confirmedPublishes       = 0;
        this.confirmationCheckFailures = 0;
        this.lastConfirmationCheckAt  = null;
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
        // Shared SpendGuard for the on-chain anchor spend path. Adds the
        // per-window spend ceiling (count + $2000-clamped USD budget, default-ON) and
        // a per-capability runtime pause on top of the existing balance floor, so an
        // operator can halt anchor DOGE spend at runtime and a fee-runaway is bounded.
        // Its balance floor mirrors lowBalanceThreshold (the flush already gates on it).
        this.spendGuard = new SpendGuard('ANCHOR', cfg, 'StateAnchorPublisher');
        this.spendGuard.minBalance = this.lowBalanceThreshold;
        // Decouple on-chain anchoring from checkpoint production: checkpoints are
        // free (off-chain hub-DB mirror, good for light-client verify) but each
        // on-chain v0 anchor spends real DOGE on 3 chains. Only anchor checkpoints
        // whose checkpoint_seq is a multiple of N (recovery needs just the LATEST
        // anchored checkpoint per chain, so the skipped seqs stay off-chain). N=1
        // keeps the original anchor-every-checkpoint behaviour. checkpoint_seq
        // is now the round's BTC snapshot_block (deriveCheckpointSeq), still consensus
        // data (identical on every hub) so `seq % N` stays deterministic fleet-wide;
        // with the default N=1 (MOD(seq,1)=0 for all) this is unchanged, and an
        // operator setting N>1 now sub-samples by snapshot_block divisibility rather
        // than by a dense per-chain counter.
        this.anchorEveryNCheckpoints = Math.max(1,
            parseInt(process.env.ANCHOR_CHECKPOINT_EVERY_N || cfg.ANCHOR_CHECKPOINT_EVERY_N || '1') || 1);

        this.dogeAddress   = process.env.DOGE_ADDRESS    || cfg.DOGE_ADDRESS    || '';
        this.dogePubkeyHex = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks; unset -> borrow the price publisher's DOGE signer.
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        this._archiveRound     = null;  // leader-side archive signing round (one at a time)
        this._attestRound        = null;  // leader-side publisher-attestation round (one at a time)
        this._archiveAttestRound = null;  // leader-side ARCHIVE publisher-attestation round (one at a time)
        this._pendingMatches   = 0;     // size trigger; DB is the source of truth
        this._callHandler      = null;
        this._flushing         = false;
        this._timer            = null;
        this._messageHandler   = null;
        this._matchHandler     = null;
        this._loggedNoPipeline = false;
        // Cumulative count of archive chunks that failed all broadcast retries.
        // A lost chunk is a durability failure (recovery needs every chunk), so
        // a pattern of losses is surfaced here for operator visibility rather
        // than requiring a log-grep.
        this._archiveChunkLosses = 0;
        // Cumulative count of v0/v3 anchors successfully published on-chain.
        this._anchorsPublished = 0;
        // Split of that count by the rank this hub held for the row it anchored.
        // A backup-rank publish means the elected rank-0 publisher did NOT anchor
        // within its ladder step, so the federation is running on failover with
        // reduced anchor redundancy. Undifferentiated, that is invisible: the
        // checkpoints still land on cadence and every staleness/balance term stays
        // green until the backups fail too. Same idea as OraclePublisher's
        // _leaderRounds/_followerRounds on the PRICE rail.
        this._anchorsAsLeader  = 0;
        this._anchorsAsBackup  = 0;
        // Rank state of the most recent successful anchor, surfaced via
        // getAnchorStats so an operator sees the CURRENT posture, not only a
        // lifetime tally that a long healthy history would dilute.
        this._lastAnchorRank   = null;   // { chain, network, blockIndex, myRank, publisherCount, isLeader, at }
        // Cumulative count of candidate checkpoints a flush looked at and stood
        // down from, split by why. Both skips are correct behavior and were silent,
        // which made a federation with ZERO anchors ever published indistinguishable
        // from one with nothing to anchor: every wake walked the same rows and
        // logged nothing. Exposed via getAnchorStats so getanchorstatus answers
        // "is anyone even being asked to publish this?" without a code read.
        //   notOurElection: another hub is the unlocked publisher for the row (or
        //                   this hub's backup rank has not unlocked yet)
        //   leaderOnWake:   this hub leads the row but the flush was the failover-
        //                   only wake, which never publishes a led election
        this._skippedNotOurElection = 0;
        this._skippedLeaderOnWake   = 0;
        // Last DOGE balance observed by _checkBalance (refreshed each flush) and
        // when, surfaced via getAnchorStats so an operator/monitor can watch the
        // publisher wallet's runway (it spends real DOGE on every anchor cycle)
        // without log-grepping the low-balance warning. null until the first
        // balance read (no pipeline / before first flush).
        this._lastBalance   = null;
        this._lastBalanceAt = null;
        // Locally-observed archive-round leaders: batch_seq -> Set(elected leader
        // pubkeys). Populated in _handleSignReq once a SIGN_REQ sender has validated
        // as the (rank-unlocked) elected archive leader for that batch_seq AND its
        // signature over the archive canonical verifies (the rank ladder alone is
        // wire-keyed, so the signature is what proves the sender holds the key it
        // names), and consulted in _handleFinalized to authenticate the
        // FINALIZED sender. The archive election is keyed on election_block (the
        // BTC tip at archive time), which the FINALIZED canonical does NOT carry,
        // so it cannot be re-derived at finalize time; this binds it from the
        // round we actually observed. Bounded (batch_seq is monotonic, evict the
        // smallest keys) so a long-lived hub never grows this without limit.
        this._observedArchiveLeaders = new Map();
        this._observedArchiveLeadersCap = 256;
        // Checkpoint IDENTITY observed per batch_seq (from the SIGN_REQ, recorded
        // alongside the leader). FINALIZED carries only batch_seq, not the
        // checkpoint identity getanchoraction needs, so _handleFinalized reads this
        // to verify the batch's archive checkpoint landed on DOGE before mirroring
        // the anchor_archive reward (mirrored below the archive-reward
        // flag-day; derived on-chain from ANCHOR v6 at/above it). Identity only,
        // re-SELECTed against our own rows, and evicted in lockstep with the leader map.
        this._observedArchiveCheckpoints = new Map();

        // Per-coin indexer JSON-RPC clients (same env -> p2pConfig surface as
        // ReorgHandler / CrossChainCallEngine). Used ONLY for on-chain ANCHOR
        // verification, which always queries the DOGE indexer: every ANCHOR (for a
        // BTC/LTC/DOGE checkpoint) is a DOGE transaction, and only the DOGE
        // decoder+indexer decode the P2SH anchor payload (a raw getrawtransaction
        // cannot bind the tx to the checkpoint). Unset -> _verifyAnchorOnChain
        // returns 'no-indexer' and the receiver paths abstain (fail closed); wire
        // DOGE_INDEXER_URL fleet-wide before deploy.
        this.indexers = {};
        for(let coin of coins.ALLOWED_COINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }
        // Confirmation depth an ANCHOR must reach on DOGE before a peer's
        // announcement is trusted for stamp/reward (operator decision: reject
        // 0-conf, depth = XCHAIN_CONFIRMATIONS_DOGE). Same env -> p2pConfig ->
        // per-coin default idiom the cross-chain engines use (mainnet
        // floor-clamped, see coins.resolveConfirmations).
        this.dogeConfirmations = coins.resolveConfirmations(cfg, this.network).DOGE;

        // XANC_V0_DONE is broadcast the instant _broadcastWithRetry
        // returns a txid, i.e. while the DOGE anchor is still in the mempool, but the
        // receiver only stamps once that anchor is buried dogeConfirmations deep (60 on
        // DOGE, ~1 hour). The announcement is one-shot, so at announce time every peer
        // saw 'absent' and returned early, leaving anchor_txid NULL forever: the
        // duplicate-anchor suppression the whole `anchor_txid IS NULL` selector depends
        // on could never engage, and each hub re-anchored (real DOGE) as its failover
        // rank unlocked. Receivers therefore QUEUE an announcement that is authentic but
        // not yet buried and re-run the on-chain verification on a timer. Bounded by
        // size and TTL so a never-mined (evicted or replaced) tx cannot suppress a
        // needed re-anchor indefinitely.
        this._deferredV0Done      = new Map();
        // Fabricated-txid half: the SAME queue shape for XANC_FINALIZED. The
        // announcement rides at 0 confirmations too, so the archive head is normally
        // 'absent' at receipt; the entry is re-verified here until the head is buried
        // (then it stamps) or the TTL clears it. Bounded by the same size + TTL knobs.
        this._deferredFinalized   = new Map();
        // The PUBLISHER's own half of the same 0-confirmation problem. This
        // hub used to write its anchor_reward_attestations row the instant
        // _broadcastWithRetry returned a txid, i.e. on mempool acceptance, and that row
        // is append-only and never retracted (hub_db_sync HUB_STATE_TABLES) while the
        // BTC indexer derives a COLLECT-spendable validator_rewards row from it. An
        // evicted or reorged anchor therefore minted a permanent reward for a
        // transaction the chain never carried. Confirm THEN write: the attestation is
        // queued here and only written by _drainDeferredRewardAttest, on the same size +
        // TTL knobs as the two announcement queues.
        this._deferredRewardAttest = new Map();
        this.announceRetryMs      = parseInt(process.env.ANCHOR_ANNOUNCE_RETRY_MS      || cfg.ANCHOR_ANNOUNCE_RETRY_MS      || '300000');    // 5 min
        this.announceRetryTtlMs   = parseInt(process.env.ANCHOR_ANNOUNCE_RETRY_TTL_MS  || cfg.ANCHOR_ANNOUNCE_RETRY_TTL_MS  || '21600000');  // 6 h, ~6x the 60-conf DOGE window
        this.announceQueueMax     = parseInt(process.env.ANCHOR_ANNOUNCE_QUEUE_MAX     || cfg.ANCHOR_ANNOUNCE_QUEUE_MAX     || '500');
        this._deferTimer          = null;
        this._rankWakeTimer       = null;   // failover wake, see rankWakeMs
        // How long a durable broadcast intent with no mined anchor HOLDS its
        // checkpoint (see the anchor_published_checkpoints block below). Same bound and
        // same reasoning as announceRetryTtlMs above: ~6x the 60-conf DOGE window, past
        // which a send that never relayed is not coming back and holding the row costs
        // more than re-broadcasting it.
        this.anchorIntentTtlMs    = parseInt(process.env.ANCHOR_INTENT_TTL_MS || cfg.ANCHOR_INTENT_TTL_MS || '21600000');   // 6 h
        // Retention window for the two durable anchor marker tables. Both appended one
        // row per DOGE-spending broadcast and never removed one, so they grew for the
        // life of the deployment while their oracle_published_rounds sibling was swept.
        // Only CONFIRMED rows are pruned, and only past a floor derived from
        // anchorIntentTtlMs; see _pruneAnchorMarkers for both invariants. 0 disables
        // pruning; garbage or a negative value falls back to the default.
        this.anchorMarkerRetentionMs = parseInt(process.env.ANCHOR_MARKER_RETENTION_MS ||
                                                cfg.ANCHOR_MARKER_RETENTION_MS, 10);
        if(!Number.isFinite(this.anchorMarkerRetentionMs) || this.anchorMarkerRetentionMs < 0)
            this.anchorMarkerRetentionMs = DEFAULT_ANCHOR_MARKER_RETENTION_MS;
        // Lifetime count of confirmed anchor marker rows the retention sweep deleted,
        // and the in-flight sweep handle. The sweep is fire-and-forget on the flush
        // path (retention must never stall an anchor), so the handle is what makes it
        // awaitable in tests.
        this.anchorMarkersPruned = 0;
        this._retentionSweep     = null;
    }

    setBroadcastHook(fn){ this.broadcastFn = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){ this.getBalanceFn = fn; }

    // Operator-facing stats. Exposed here so callers (hub RPC, status routes)
    // can surface cumulative archive health without grepping logs.
    getAnchorStats(){
        return {
            enabled:            this.enabled,
            anchorsPublished:   this._anchorsPublished,
            // Leader-vs-failover split of anchorsPublished plus the last anchor's
            // rank posture. anchorsAsBackup climbing (or lastAnchorRank.isLeader
            // false) is the only signal that the elected rank-0 publisher is dead
            // and the ladder is absorbing its work.
            anchorsAsLeader:    this._anchorsAsLeader,
            anchorsAsBackup:    this._anchorsAsBackup,
            lastAnchorRank:     this._lastAnchorRank,
            skippedNotOurElection: this._skippedNotOurElection,
            skippedLeaderOnWake:   this._skippedLeaderOnWake,
            startupFlushMs:        this.startupFlushMs,
            // Landing health. unconfirmedPublishes with an oldestUnconfirmedAgeMs in
            // the hours is a stuck anchor; noConfirmedUtxoDeferrals climbing while
            // unconfirmedUtxos is non-zero is the wallet trapped behind it.
            allowUnconfirmedInputs:   this.allowUnconfirmedInputs,
            leaderRetryDue:           this._leaderRetryDue,
            noConfirmedUtxoDeferrals: this.noConfirmedUtxoDeferrals,
            lastNoConfirmedUtxoAt:    this.lastNoConfirmedUtxoAt,
            confirmedUtxos:           this.lastUtxoReserve ? this.lastUtxoReserve.confirmed   : null,
            unconfirmedUtxos:         this.lastUtxoReserve ? this.lastUtxoReserve.unconfirmed : null,
            unconfirmedPublishes:     this._pendingConfirmations.size,
            oldestUnconfirmedPublish: this.oldestUnconfirmedPublish(),
            confirmedPublishes:       this.confirmedPublishes,
            confirmationCheckFailures: this.confirmationCheckFailures,
            lastConfirmationCheckAt:  this.lastConfirmationCheckAt,
            archiveChunkLosses: this._archiveChunkLosses,
            anchorMarkerRetentionMs: this.anchorMarkerRetentionMs,
            anchorMarkersPruned:     this.anchorMarkersPruned,
            // Publisher-wallet runway: last-observed DOGE balance, its age, and the
            // low-balance threshold the publisher already warns at. dogeBalance is
            // null until the first flush reads it (or when no DOGE pipeline is set).
            dogeAddress:        this.dogeAddress || null,
            dogeBalance:        this._lastBalance,
            dogeBalanceAt:      this._lastBalanceAt,
            lowBalanceThreshold: this.lowBalanceThreshold,
            spendGuard:         this.spendGuard.stats()
        };
    }

    async start(){
        if(!this.enabled){ console.log('StateAnchorPublisher: disabled (ANCHOR_ENABLED=false)'); return; }
        // The per-window spend ceilings were memory-only, so every restart
        // restored a full allowance. Reload the saved window before anything anchors.
        this.spendGuard.persistTo();
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, so anchor on-chain verification reaches the
        // indexer instead of returning 'no-indexer' on a standard hub.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
        if(this.hub.crossChainDex){
            this._matchHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => console.error('StateAnchorPublisher: size-trigger flush error:', err && err.message));
            };
            // Engine-level event; fires after the match row is written (the archive
            // round reads cross_chain_matches), unlike the consensus-level event.
            this.hub.crossChainDex.on('match:finalized', this._matchHandler);
        }
        if(this.hub.crossChainCalls){
            // XCALL relay rows share the size trigger: they ride the same archive.
            this._callHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => console.error('StateAnchorPublisher: size-trigger flush error:', err && err.message));
            };
            this.hub.crossChainCalls.on('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.on('call:result',   this._callHandler);
        }
        this._timer = setInterval(() => {
            this.flush().catch(err => console.error('StateAnchorPublisher: interval flush error:', err && err.message));
        }, this.intervalMs);
        if(this._timer.unref) this._timer.unref();
        // Separate, much shorter cadence than the (daily by default) flush: a queued
        // V0_DONE has to be re-checked on the order of the DOGE confirmation window,
        // not the anchor publishing window.
        this._deferTimer = setInterval(() => {
            this._drainDeferredV0Done().catch(err => console.error('StateAnchorPublisher: deferred V0_DONE drain error:', err && err.message));
            this._drainDeferredFinalized().catch(err => console.error('StateAnchorPublisher: deferred FINALIZED drain error:', err && err.message));
            this._drainDeferredRewardAttest().catch(err => console.error('StateAnchorPublisher: deferred reward-attestation drain error:', err && err.message));
        }, this.announceRetryMs);
        if(this._deferTimer.unref) this._deferTimer.unref();
        // The failover wake. Re-runs flush in failover-only mode so a
        // backup notices its rank unlocking between the (daily by default) ticks
        // instead of leaving a dead leader's work stranded for a whole cycle.
        this._rankWakeTimer = setInterval(() => {
            this.flush(this._wakeFlushOpts())
                .catch(err => console.error('StateAnchorPublisher: failover-wake flush error:', err && err.message));
        }, this.rankWakeMs);
        if(this._rankWakeTimer.unref) this._rankWakeTimer.unref();
        this._startConfirmationWatchdog();
        // The startup catch-up flush (see startupFlushMs). A NORMAL flush, not a
        // wake: the point is to run the one leader pass a restart otherwise defers
        // by a whole interval.
        if(this.startupFlushMs > 0){
            this._startupTimer = setTimeout(() => {
                this._startupTimer = null;
                this.flush().catch(err => console.error('StateAnchorPublisher: startup flush error:', err && err.message));
            }, this.startupFlushMs);
            if(this._startupTimer.unref) this._startupTimer.unref();
        }
        console.log('StateAnchorPublisher started (interval ' + this.intervalMs + 'ms, startup flush ' +
                    (this.startupFlushMs > 0 ? 'in ' + this.startupFlushMs + 'ms' : 'off') +
                    ', batch ' + this.batchSize + ', address ' + (this.dogeAddress || '<unset>') + ')');
    }

    async stop(){
        if(this._timer){ clearInterval(this._timer); this._timer = null; }
        if(this._deferTimer){ clearInterval(this._deferTimer); this._deferTimer = null; }
        if(this._rankWakeTimer){ clearInterval(this._rankWakeTimer); this._rankWakeTimer = null; }
        if(this._startupTimer){ clearTimeout(this._startupTimer); this._startupTimer = null; }
        if(this._confirmTimer){ clearInterval(this._confirmTimer); this._confirmTimer = null; }
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if(this._matchHandler && this.hub.crossChainDex){
            this.hub.crossChainDex.removeListener('match:finalized', this._matchHandler);
            this._matchHandler = null;
        }
        if(this._callHandler && this.hub.crossChainCalls){
            this.hub.crossChainCalls.removeListener('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.removeListener('call:result',   this._callHandler);
            this._callHandler = null;
        }
        if(this._archiveRound && this._archiveRound.timer) clearTimeout(this._archiveRound.timer);
        this._archiveRound = null;
        if(this._attestRound && this._attestRound.timer) clearTimeout(this._attestRound.timer);
        if(this._attestRound && !this._attestRound.done && this._attestRound.resolve)
            this._attestRound.resolve({ met: false, sigs: [] });   // unblock any awaiting publish
        this._attestRound = null;
        // Mirror the _attestRound teardown for its archive twin: _runArchiveAttestationRound
        // is an awaited promise settled only by an unref'd timer, so without this a stop()
        // mid-round leaves _publishArchive hung during shutdown.
        if(this._archiveAttestRound && this._archiveAttestRound.timer) clearTimeout(this._archiveAttestRound.timer);
        if(this._archiveAttestRound && !this._archiveAttestRound.done && this._archiveAttestRound.resolve)
            this._archiveAttestRound.resolve({ met: false, sigs: [] });   // unblock any awaiting _publishArchive
        this._archiveAttestRound = null;
    }

    // Flush: publish pending v0 checkpoints + the pending archive batch.
    // Returns a summary (also served by the hub's `anchorflush` RPC):
    // { anchored: [{chain, network, block_index, txid}], archive: 'published'|
    //   'round_started'|'none', skipped: 'already_flushing'|'no_pipeline'? }
    // opts.failoverOnly: publish only what this hub is a BACKUP for,
    // i.e. elections it does not lead but whose failover rank has unlocked. The
    // failover wake passes it so re-checking the ladder between interval ticks
    // cannot turn into a higher anchoring cadence for a healthy leader; every
    // other caller (interval, size triggers, tests) leaves it off and behaves
    // exactly as before.
    // What the rank wake should run this tick. Failover-only in the steady state;
    // a normal flush exactly while a confirmed-input deferral is outstanding, so
    // the led row it stood down from is retried in minutes rather than a day.
    _wakeFlushOpts(){
        return { failoverOnly: !this._leaderRetryDue };
    }

    // Record a stand-down for want of a confirmed input. Counted, timestamped,
    // and armed for the next wake; never thrown past the flush.
    _noteNoConfirmedUtxo(what){
        this.noConfirmedUtxoDeferrals++;
        this.lastNoConfirmedUtxoAt = Date.now();
        this._leaderRetryDue = true;
        let seen = this.lastUtxoReserve || { unconfirmed: 0 };
        console.warn('StateAnchorPublisher: NO_CONFIRMED_UTXO - every one of the ' + seen.unconfirmed +
                     ' spendable output(s) at ' + this.dogeAddress + ' is unconfirmed (change trapped behind ' +
                     'an unconfirmed chain); deferring ' + what + ', retried on the next rank wake once an output confirms');
    }

    // Read the publisher address's UTXO set and summarize it, or null when the set
    // cannot be read. FAIL SOFT, unlike the balance gate: this reading only ever
    // withholds a broadcast, so an unreachable encoder must leave the decision to the
    // guards that already fail closed rather than add a second way to stall publishing.
    async _readUtxoReserve(signer){
        signer = signer || this._resolveSigner();
        if(!signer.encoder || !this.dogeAddress) return null;
        let utxos;
        try { utxos = await signer.encoder.getUtxos(this.dogeAddress); }
        catch(err){
            console.warn('StateAnchorPublisher: UTXO reserve check failed (confirmation state unknown this pass; ' +
                         'publishing is not blocked on it): ' + (err && err.message));
            return null;
        }
        if(!Array.isArray(utxos)) return null;
        let summary = summarizeUtxoConfirmations(utxos, 1);
        this.lastUtxoReserve = { total: summary.total, confirmed: summary.confirmed,
                                 unconfirmed: summary.unconfirmed, known: summary.known, at: summary.at };
        return summary;
    }

    // May a flush build a wire right now? False only for the one provable
    // condition: the address holds outputs, their confirmation state is known, and
    // NOT ONE of them is confirmed. Under confirmed-inputs-only that wallet cannot
    // fund anything; under the escape hatch it is not our call.
    async _confirmedUtxoAvailable(signer){
        if(this.allowUnconfirmedInputs) return true;
        let summary = await this._readUtxoReserve(signer);
        if(!summary)             return true;   // unreadable: not our call to block
        if(!summary.known)       return true;   // no confirmations field served
        if(summary.total === 0)  return true;   // empty wallet is the balance gate's call
        return summary.confirmed > 0;
    }

    async flush(opts){
        let failoverOnly = !!(opts && opts.failoverOnly);
        if(this._flushing) return { anchored: [], archive: 'none', skipped: 'already_flushing' };
        this._flushing = true;
        // A normal flush is the retry a deferral was waiting for; it re-arms below
        // only if it defers again.
        if(!failoverOnly) this._leaderRetryDue = false;
        try {
            // Drain queued peer announcements FIRST, so a checkpoint another hub already
            // anchored is stamped before this flush's failover-rank check would re-anchor
            // it (the whole point of the suppression signal). Never let a drain error
            // abort the flush: the queue is bookkeeping, publishing is the job.
            await this._drainDeferredV0Done()
                .catch(err => console.warn('StateAnchorPublisher: deferred V0_DONE drain error: ' + (err && err.message)));
            await this._drainDeferredFinalized()
                .catch(err => console.warn('StateAnchorPublisher: deferred FINALIZED drain error: ' + (err && err.message)));
            await this._drainDeferredRewardAttest()
                .catch(err => console.warn('StateAnchorPublisher: deferred reward-attestation drain error: ' + (err && err.message)));
            let btcBlock = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;

            let signer = this._resolveSigner();
            if(!signer.broadcastFn && !(signer.encoder && signer.walletSignFn)){
                if(!this._loggedNoPipeline){
                    console.warn('StateAnchorPublisher: no DOGE broadcast pipeline configured; anchors deferred (set DOGE_ENCODER_URL + a wallet-sign hook)');
                    this._loggedNoPipeline = true;
                }
                return { anchored: [], archive: 'none', skipped: 'no_pipeline' };
            }
            // Hard pre-send balance gate. Previously the return value was
            // discarded and a low balance only WARNed, so a fee-estimation bug or a
            // stuck-tx retry loop could drain the wallet with nothing but a log line.
            // Now a balance below the floor, or an unreadable balance (null; fail-closed),
            // skips this flush's publishing. The scheduler keeps running and retries on
            // the next flush once the wallet is topped up / the balance source recovers.
            let balance = await this._checkBalance(signer);
            // The gate is only meaningful when a balance source is actually wired
            // (a getBalanceFn hook, or an encoder + address to sum UTXOs). With no
            // source, balance is always null and there is nothing to enforce, so we
            // preserve prior behavior rather than disable publishing outright.
            let hasBalanceSource = !!(signer.getBalanceFn || (signer.encoder && this.dogeAddress));
            if(hasBalanceSource){
                if(balance === null){
                    console.warn('StateAnchorPublisher: DOGE balance unreadable; skipping this flush (fail-closed)');
                    return { anchored: [], archive: 'none', skipped: 'balance_unreadable' };
                }
                if(balance < this.lowBalanceThreshold){
                    console.warn('StateAnchorPublisher: DOGE balance ' + Number(balance).toFixed(4) + ' below floor ' +
                                 this.lowBalanceThreshold + '; skipping publish this flush (fail-closed)');
                    return { anchored: [], archive: 'none', skipped: 'below_balance_floor' };
                }
            }
            // Confirmed-UTXO reserve. A balance above the floor says nothing about
            // whether it can be SPENT INTO A MINEABLE WIRE: after an anchor that never
            // confirms, the whole balance is change sitting unconfirmed behind it.
            // Defer the flush instead of building on it; rows stay pending, no marker
            // is armed, no intent is recorded, and the next wake retries as a normal
            // flush. Fail soft, see _confirmedUtxoAvailable.
            if(!(await this._confirmedUtxoAvailable(signer))){
                this._noteNoConfirmedUtxo('this flush');
                return { anchored: [], archive: 'none', skipped: 'no_confirmed_utxo' };
            }

            // Shared SpendGuard gate on the PRIMARY anchor path. A runtime
            // pause (per-capability) or an exhausted per-window spend ceiling skips
            // this flush's on-chain publishing entirely; the scheduler retries next
            // flush. Placed after the balance gate so a paused publisher never spends
            // on the leader path (the fe3aedbf kill-switch was inert on the primary
            // path; this closes it).
            if(this.spendGuard.isPaused()){
                console.warn(this.spendGuard.noteBlocked() + '; skipping this flush');
                return { anchored: [], archive: 'none', skipped: 'paused' };
            }
            if(!this.spendGuard.allow()){
                console.warn(this.spendGuard.noteBlocked() + '; skipping this flush');
                return { anchored: [], archive: 'none', skipped: 'spend_ceiling' };
            }

            let anchored = await this._publishPendingCheckpoints(signer, btcBlock, failoverOnly);
            let archive  = await this._startArchiveRound(signer, btcBlock, failoverOnly);
            // Bound the durable marker tables. Runs at the end of a flush that actually
            // reached the publishing stage, so it never fires on a hub that is paused,
            // out of balance or without a pipeline, and never before the intents this
            // flush armed are settled.
            this._sweepAnchorMarkerRetention();
            return { anchored: anchored, archive: archive };
        } catch(e){
            console.error('StateAnchorPublisher: flush failed:', e && e.message);
            return { anchored: [], archive: 'none', error: e && e.message };
        } finally {
            this._flushing = false;
        }
    }

    // Deterministic publisher ordering (AttestationRound's responsible-set
    // idiom): sort the eligible set by SHA256(key ‖ pubkey) ascending. Every
    // hub computes the identical order from the block-boundary snapshot.
    static hashOrder(key, pubkeys){
        return (pubkeys || []).map(pk => {
            let p = String(pk).toLowerCase();
            return { pubkey: p, hash: crypto.createHash('sha256').update(key, 'utf8').update(p, 'utf8').digest('hex') };
        }).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map(e => e.pubkey);
    }

    _v0ElectionKey(row){
        return 'XANCV0|' + row.chain + '|' + row.network + '|' + String(row.checkpoint_seq) + '|' + String(row.snapshot_block);
    }

    // May THIS hub publish for `order` right now? Rank 0 always may; each
    // additional rank unlocks after ANCHOR_ELECTION_TOLERANCE_BLOCKS more BTC
    // blocks past the election anchor point (deterministic failover ladder).
    // A hub outside a non-empty eligible set never publishes, and an empty
    // (unresolved/unavailable) set means abstain (fail closed), never a
    // free-for-all where every hub double-anchors the same checkpoint.
    _mayPublish(order, sinceBlocks){
        // Single source of truth for the v0 failover ladder: delegate to _rankUnlocked
        // over our own pubkey so the leader-election path and its follower verifiers can
        // never drift. Behaviour is identical to the prior inline form: an empty order or
        // a pubkey absent from it -> rank < 0 -> false; rank 0 (incl. the order.length===1
        // case) -> true; otherwise rank <= unlocked.
        if(!this.identity) return false;
        return this._rankUnlocked(order, String(this.identity.getPubkeyHex()).toLowerCase(), sinceBlocks);
    }

    // Does this hub LEAD `order` (rank 0)? The failover wake's whole job is to act
    // only where this is false, so the leader's publishing cadence is untouched.
    _isRankZero(order){
        if(!this.identity || !order || order.length === 0) return false;
        return order[0] === String(this.identity.getPubkeyHex()).toLowerCase();
    }

    // This hub's position in `order`, or -1 when it is absent (or has no identity).
    // Read-only: telemetry only, never a gate. _mayPublish stays the single
    // publish decision so a reporting bug can never authorize a spend.
    _myRank(order){
        if(!this.identity || !order || order.length === 0) return -1;
        return order.indexOf(String(this.identity.getPubkeyHex()).toLowerCase());
    }

    // v0: one per chain/network (the LATEST checkpoint that has no anchor yet).
    // Older unanchored checkpoints are superseded (the chained hashes commit to
    // all prior history), so only the newest per chain costs DOGE bytes.
    // Each row elects its own publisher (hash-order at its snapshot_block).
    async _publishPendingCheckpoints(signer, btcBlock, failoverOnly){
        // Pick, per chain, the latest ANCHOR-ELIGIBLE checkpoint (seq divisible by
        // anchorEveryNCheckpoints) that is not yet on-chain. Selecting the max
        // eligible seq rather than the absolute max means accumulated
        // non-multiple seqs never block: they simply stay off-chain. With N=1
        // (MOD(seq,1)=0 for all) this is identical to anchoring every checkpoint.
        // Scoped to this.network when one is configured (matching
        // StateCheckpointEngine's latch loader): a hub DB carrying rows from a
        // prior network deployment must never re-elect publishers for (or spend
        // a real DOGE anchor on) a dead network's perpetually-unanchored
        // checkpoints. A hub with no configured network keeps the legacy
        // unscoped behavior rather than filtering everything out.
        let pendingSql =
            'SELECT sc.* FROM state_checkpoints sc JOIN (' +
            '  SELECT chain, network, MAX(checkpoint_seq) AS max_seq FROM state_checkpoints' +
            '  WHERE MOD(checkpoint_seq, ?) = 0 GROUP BY chain, network' +
            ') t ON sc.chain = t.chain AND sc.network = t.network AND sc.checkpoint_seq = t.max_seq ' +
            'WHERE sc.anchor_txid IS NULL';
        let pendingParams = [this.anchorEveryNCheckpoints];
        if(this.network){ pendingSql += ' AND sc.network = ?'; pendingParams.push(this.network); }
        let rows = await this.db.doQuery(pendingSql, pendingParams);
        let anchored = [];
        let skippedRows = 0;
        for(let row of (rows || [])){
            try {
                let eligible = await this._getActiveOraclePublishPubkeys(Number(row.snapshot_block));
                // Fail closed: an empty/unresolved oracle_publish set is NOT a
                // licence for every hub to anchor independently (a guaranteed
                // N-way double-anchor + DOGE burn). Skip until the set resolves.
                if(eligible.length === 0){
                    console.warn('StateAnchorPublisher: v0 anchor for ' + row.chain + '/' + row.network +
                                 ' @ ' + row.block_index + ' deferred: empty oracle_publish set (fail closed)');
                    continue;
                }
                let order = StateAnchorPublisher.hashOrder(this._v0ElectionKey(row), eligible);
                let since = Number.isFinite(btcBlock) ? btcBlock - Number(row.snapshot_block) : null;
                if(!this._mayPublish(order, since)){ this._skippedNotOurElection++; skippedRows++; continue; }   // someone else's anchor (or not unlocked yet)
                // On a failover wake, publish only as a BACKUP. Rank 0 is
                // always unlocked, so without this the 15-minute wake would replace the
                // leader's ANCHOR_INTERVAL_MS cadence and it would anchor a fresh
                // checkpoint every wake instead of one per cycle (each superseding the
                // last, all real DOGE). A row this hub leads keeps its normal cadence.
                if(failoverOnly && this._isRankZero(order)){ this._skippedLeaderOnWake++; skippedRows++; continue; }
                // SPV Phase 2: emit ANCHOR v3 (carries + signs the light-client roots) when the
                // checkpoint was signed post-flag-day AND actually carries the roots; otherwise the
                // legacy v0. The roots-present check keeps a legacy/null-root row (signed over the
                // rootless canonical) on v0 so its sigs still verify, mirroring the canonical suffix
                // gating in StateCheckpointEngine._checkpointRootSuffix.
                let useV3 = ckpt.isCheckpointCommitmentActive(Number(row.snapshot_block), row.network) &&
                            row.state_root != null && row.block_merkle_root != null &&
                            row.state_root_version != null && row.block_merkle_version != null;
                // Consult the durable at-most-once marker BEFORE building a
                // fresh PSBT, and before the publisher-attestation round below solicits a
                // peer quorum. The existence check reads mined state only, so it cannot see
                // a send this hub made and then crashed on; the marker can. A surviving
                // intent means DOGE may already have paid for this exact checkpoint, so hold
                // the row (bounded by anchorIntentTtlMs) unless the anchor has since mined,
                // in which case fall through and let the retry loop adopt it on attempt 0
                // exactly as it does for a peer's anchor.
                //
                // Ordered ahead of the attestation block for the reason _publishArchive
                // states for its own twin ("Checked ahead of the publisher-attestation round
                // so a held publish does not burn a peer quorum either"): the round takes the
                // single _attestRound slot for up to roundTimeoutMs and makes every peer
                // re-derive the election and byte-match its state_checkpoints row, all for a
                // publish this branch then declines. A held row must cost one DB read.
                let intent = await this._getAnchorIntent(row);
                if(this._anchorIntentHolds(intent)){
                    let mined = null;
                    try { mined = await this._findExistingCheckpointAnchor(row); }
                    catch(_e){ mined = null; }        // undetermined indexer: hold, never spend
                    if(!(mined && mined.exists)){
                        console.warn('StateAnchorPublisher: v0 anchor for ' + row.chain + '/' + row.network +
                                     ' @ ' + row.block_index + ' held: a broadcast intent recorded at ' +
                                     String(intent.intent_at) + (intent.txid ? ' (txid ' + intent.txid + ')' : '') +
                                     ' has no mined anchor yet; not rebuilding a second transaction until it ' +
                                     'mines or the intent ages past ' + this.anchorIntentTtlMs + 'ms');
                        continue;
                    }
                }
                // Anchor-reward re-derivation flag-day: at/above it, run the publisher-
                // attestation round (2f+1 oracle_publish quorum over XANCPUB binding THIS
                // hub as the earner) and emit ANCHOR v4 (rootless) / v5 (root-bearing),
                // which carries the attestation so the indexer DERIVES the reward and the
                // forgeable hub push is retired. LIVENESS-SAFE: a degraded round
                // (timeout / short quorum / not a snapshot member) FALLS BACK to legacy
                // v0/v3, so the anchor always lands; only reward issuance gains the quorum
                // dependency. A failed reward attestation must NEVER block the anchor.
                let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
                let payload;
                let attested = false;   // a v4/v5 (reward-derivable) payload was actually built
                let attestSigs = [];    // hoisted so the post-publish attestation-mirror INSERT can carry them
                if(me && ar.isAnchorRewardActive(Number(row.snapshot_block), row.network)){
                    let attest = await this._runPublisherAttestationRound(this._cpFromRow(row), me);
                    if(attest && attest.met && attest.sigs.length >= 1){
                        payload = useV3 ? this._buildV5Payload(row, me, attest.sigs)
                                        : this._buildV4Payload(row, me, attest.sigs);
                        attested = true;
                        attestSigs = attest.sigs;
                    } else {
                        console.warn('StateAnchorPublisher: publisher-attestation quorum not reached for ' +
                                     row.chain + '/' + row.network + ' @ ' + row.block_index +
                                     '; publishing legacy v' + (useV3 ? '3' : '0') + ' (anchor lands, no reward)');
                        payload = useV3 ? this._buildV3Payload(row) : this._buildV0Payload(row);
                    }
                } else {
                    payload = useV3 ? this._buildV3Payload(row) : this._buildV0Payload(row);
                }
                let broadcaster = signer.broadcastFn || ((p) => this._defaultBroadcast(p, signer));
                await this._recordAnchorIntent(row);
                // Multiple chains' v0 anchors go out back-to-back from the same
                // wallet; without the retry, every cycle lands only the first
                // and the rest stagger one chain per 30-min flush (live prod
                // finding, first post-deploy cycle).
                // The existence check makes a lost ACK (this flush OR a
                // previous one) adopt the already-mined anchor instead of paying
                // for a second one.
                let result;
                try {
                    result = await this._broadcastWithRetry(broadcaster, payload, undefined,
                        () => this._findExistingCheckpointAnchor(row));
                } catch(e){
                    // A definitive failure means nothing reached the DOGE node
                    // (pre-send build/sign errors, a spend-ceiling refusal, an RPC
                    // rejection), so withdraw the intent rather than hold the checkpoint
                    // for the TTL over a send that never happened. An AMBIGUOUS send keeps
                    // its intent: that case is exactly what the marker is for.
                    if(!(e && e.anchorAmbiguousSend)) await this._withdrawAnchorIntent(row);
                    throw e;
                }
                let txid = result && result.txid ? result.txid : null;
                if(txid && !(result && result.exists)) this._notePendingConfirmation('anchor_' + row.chain, txid, String(row.checkpoint_seq));
                if(!txid){
                    // A confirmed DOGE broadcast always returns a txid; a null txid
                    // is a false/incomplete success (broadcastTx returned empty
                    // instead of throwing). Treat it as a failed publish: leave the
                    // row pending (anchor_txid stays NULL) and do NOT stamp the row,
                    // record a reward, or announce XANC_V0_DONE. Stamping NULL keeps
                    // the row matching the `WHERE sc.anchor_txid IS NULL` selector so
                    // it re-anchors and re-burns DOGE every flush, and peers ignore a
                    // null-txid announcement anyway (_handleV0Done early-returns on
                    // !d.txid). A later flush retries the publish cleanly.
                    // The intent is NOT withdrawn here. An empty return from
                    // broadcast_tx is not proof nothing was sent, so the marker holds the
                    // row for the TTL and the "later flush retries cleanly" above now
                    // means after that bound rather than immediately.
                    console.error('StateAnchorPublisher: v0 broadcast returned no txid for ' +
                                  row.chain + '/' + row.network + ' @ ' + row.block_index +
                                  '; treating as failed publish (row stays pending)');
                    continue;
                }
                await this._markAnchorSent(row, txid);
                // First-writer-wins, exactly like the peer path in _handleV0Done
                // (`... AND anchor_txid IS NULL`). In the documented failover race
                // (a late rank-0 and an early rank-1 both publish because the
                // shared pending signal is `anchor_txid IS NULL`) a hub may have
                // already stamped a peer's txid via V0_DONE; without this guard,
                // completing our own in-flight publish would overwrite it and
                // leave the fleet holding divergent anchor_txid bytes for the row.
                await this.db.doQuery(
                    'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL',
                    [txid, row.chain, row.network, row.block_index, row.checkpoint_seq]);
                // Name the rank this anchor was published at. A backup-rank publish is
                // otherwise byte-identical to a healthy leader publish in every observable
                // signal, so a dead rank-0 stays invisible while the ladder absorbs its
                // work. Computed from the SAME `order` _mayPublish decided on, so the
                // label can never disagree with the decision that produced the spend.
                let myRank = this._myRank(order);
                this._lastAnchorRank = { chain: row.chain, network: row.network,
                                         blockIndex: Number(row.block_index), myRank: myRank,
                                         publisherCount: order.length, isLeader: myRank === 0,
                                         at: Date.now() };
                if(myRank > 0) this._anchorsAsBackup++; else this._anchorsAsLeader++;
                console.log('StateAnchorPublisher: anchored checkpoint ' + row.chain + '/' + row.network +
                            ' @ ' + row.block_index + ' (txid ' + txid + ')' +
                            (myRank > 0
                                ? ' [FAILOVER: published at backup rank ' + myRank + ' of ' + order.length +
                                  '; the rank-0 publisher did not anchor this checkpoint]'
                                : ''));
                anchored.push({ chain: row.chain, network: row.network, block_index: Number(row.block_index), txid: txid });
                this._anchorsPublished++;
                // At/above the anchor-reward flag-day the per-chain reward is DERIVED
                // on-chain from the v4/v5 publisher attestation (the hub push is
                // retired), and the indexer credits NOTHING for a legacy v0/v3.
                // Recording the reward on the degraded fallback would strand it in
                // hub-local + archive bookkeeping only: no live indexer credits it,
                // but a recovering node restores the archived row, forking the
                // COLLECT-spendable ledger live-vs-recovered. Record only when the
                // published payload actually carries the attestation, or below the
                // flag-day (where the legacy push path credits live indexers).
                if(result && result.exists){
                    // Adoption path: we did not pay for THIS anchor in this
                    // call (a prior lost-ACK broadcast or a peer did). The on-chain
                    // payload, not the one we just built, names the earner; a v4/v5
                    // is derived by the indexer, and a legacy push here could
                    // credit the wrong pubkey. Stamp + announce, but never push.
                    console.log('StateAnchorPublisher: adopted existing anchor for ' + row.chain + '/' +
                                row.network + ' @ ' + row.block_index + '; reward push skipped');
                } else if(attested || !ar.isAnchorRewardActive(Number(row.snapshot_block), row.network)){
                    this._recordReward('anchor_' + row.chain, Number(row.checkpoint_seq),
                                       this.identity ? this.identity.getPubkeyHex() : null,
                                       Number(row.snapshot_block), row.network);
                    // Option C: at/above the derive-relocation flag-day, publish the
                    // XANCPUB quorum to the append-only anchor_reward_attestations mirror so the
                    // BTC indexer (where the stake source resolves) derives the reward. Only when
                    // the v4/v5 attestation actually landed on-chain, so reward <=> anchor published.
                    // "landed" now means MINED, not broadcast. `txid` above is a mempool
                    // txid, so the row is queued and written by _drainDeferredRewardAttest once
                    // this exact txid is buried at this exact ANCHOR version; an evicted or
                    // reorged anchor never produces one.
                    if(attested)
                        this._deferRewardAttestation({
                            chain: row.chain, network: row.network,
                            blockIndex: Number(row.block_index), checkpointSeq: Number(row.checkpoint_seq),
                            txid: txid, anchorVersion: useV3 ? 5 : 4,
                            rewardType: 'anchor_' + row.chain, roundReference: Number(row.checkpoint_seq),
                            snapshotBlock: Number(row.snapshot_block),
                            publisher: String(me).toLowerCase(), attestSigs: attestSigs,
                            // We are the publisher, so we own the fan-out: once the drain proves
                            // this anchor mined, the confirmed row goes to every peer (XANCREWARD).
                            federate: true
                        });
                } else {
                    console.log('StateAnchorPublisher: degraded legacy anchor at/above the reward flag-day for ' +
                                row.chain + '/' + row.network + ' @ ' + row.block_index +
                                '; reward withheld (no live indexer derives it from a v' + (useV3 ? '3' : '0') + ')');
                }
                // Tell peers so THEIR copy of the row stops being pending.
                // Without this, every hub whose failover rank unlocks would
                // re-anchor a checkpoint someone else already paid for.
                if(this.peerManager && this.identity){
                    this.peerManager.broadcast(XANC_V0_DONE, {
                        chain: row.chain, network: row.network, block_index: Number(row.block_index),
                        checkpoint_seq: Number(row.checkpoint_seq), txid: txid,
                        sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
                        sig: this.identity.sign(this._v0DoneCanonical(row, txid))
                    });
                }
            } catch(e){
                // A mid-flush deferral: an earlier anchor in this same pass spent the last
                // confirmed output. Not a failure of anything; the row stays pending and
                // the next wake retries it as a normal flush.
                if(e && e.anchorNoConfirmedUtxo) this._noteNoConfirmedUtxo('the ' + row.chain + '/' + row.network + ' anchor');
                else console.error('StateAnchorPublisher: v0 publish failed for ' + row.chain + ': ' + (e && e.message));
            }
        }
        // One line per LEADER flush (daily, startup, size-trigger, anchorflush) when
        // it walked candidates and published none, so the stand-down is visible in the
        // log at its natural cadence. The 15-minute wake stays silent: its skips are
        // the designed steady state and the counters above carry them.
        if(!failoverOnly && skippedRows > 0 && anchored.length === 0){
            console.log('StateAnchorPublisher: ' + skippedRows + ' pending checkpoint(s) belong to another hub\'s election ' +
                        '(or our backup rank is still locked); nothing anchored by this hub');
        }
        return anchored;
    }

    // Anchor-publish reward: the validator that paid the DOGE earns it. Recorded
    // on EVERY hub (by the publisher at publish time and by peers from the
    // signature-verified V0_DONE / FINALIZED announcements) with blockIndex =
    // the quorum-agreed snapshot_block of the rewarded checkpoint, so all hubs
    // hold identical row bytes and the archived rewards section verifies by
    // re-derivation. recordAnchorReward dedups all paths, including a failover
    // race that hands the same (round, type) to two different publisher pubkeys,
    // which it collapses to a single deterministic per-(round,type) winner.
    // `network` is the REWARD's network (the checkpoint row's), threaded through
    // so RewardTracker's derive-vs-push flag-day gate reads the SAME source as
    // this publisher's payload-build gate: re-deriving it from
    // this.hub.network inside RewardTracker double-credited on an unscoped hub.
    _recordReward(rewardType, roundNumber, pubkey, blockIndex, network){
        if(!this.hub.rewardTracker || typeof this.hub.rewardTracker.recordAnchorReward !== 'function') return;
        if(!pubkey) return;
        this.hub.rewardTracker
            .recordAnchorReward(rewardType, roundNumber, String(pubkey).toLowerCase(), Number.isFinite(blockIndex) ? blockIndex : 0, network)
            .catch(e => console.warn('StateAnchorPublisher: reward record failed (' + rewardType + '/' + roundNumber + '): ' + (e && e.message)));
    }

    // Option C (derive-on-BTC-side): after a v4/v5/v6 anchor lands on-chain, publish
    // the XANCPUB publisher-attestation quorum to the append-only anchor_reward_attestations
    // table, mirrored via hub_db_sync (HUB_STATE_TABLES) to every indexer ATTACHED TO THIS HUB.
    // ANCHOR is DOGE-only but capability staking (hence the resolvable stake source
    // createValidatorReward needs) is BTC-only, so the BTC indexer keys reward derivation on
    // these rows: it re-verifies the sigs
    // against its OWN local oracle_publish set at snapshot_block (mirror = transport, not trust)
    // and materializes validator_rewards at block_index = snapshot_block. Gated by the NEW derive
    // flag-day so below the gate no rows exist (byte-identical legacy: DOGE-side write still
    // attempted + silently dropped). INSERT IGNORE keeps it idempotent on the tuple identity; a
    // failover double-publish inserts a second row and the indexer winner-reconcile collapses it.
    //
    // "every indexer attached to this hub" USED to be the whole reach, and that was the
    // defect. HubDbSync holds ONE hubUrl (xchain-indexer/src/hub_db_sync.js), the row is
    // written only on the ELECTED publisher, and the v0 publisher rotates per checkpoint by
    // hashOrder, so a federation's hubs held DISJOINT subsets and an indexer derived only the
    // subset its own hub happened to publish. The gap was the PRODUCER's, not the mirror's,
    // and that is where the fix went: `e` carries the confirmed anchor txid and, on the
    // publisher, a truthy `federate`, which broadcasts XANCREWARD after the local write so
    // every peer independently re-verifies and writes its own copy. Two notes still stand:
    //   - Do NOT "correct" the sibling sentence in src/sql/anchor_reward_attestations.sql. Its
    //     "exactly like state_checkpoints" is TRUE and scoped to the MIRROR semantics (id-parity
    //     INSERT IGNORE, never retracted); hub_db_sync.js states the identical property for both
    //     tables in HUB_STATE_TABLES. It makes no hub-to-hub federation claim, so replacing it
    //     with one would trade a true sentence for a false one on a consensus table.
    //   - The XANCPUB quorum a receiver re-verifies is the SAME quorum XANCPUB_SIGN already put
    //     on the wire, verified the same way (_handleAttestSign). The receiver mints money rows,
    //     so it re-verifies against its OWN oracle_publish set at snapshot_block and re-proves
    //     the anchor mined, and never trusts the wire for either.
    // Ordering came out as the indexer's PRE-ARMING BLOCKERS note pinned it: the mined-anchor
    // proof (the deferred queue below) landed first, so federation fans out only rows whose
    // anchor this hub itself watched confirm.
    async _recordRewardAttestation(chain, network, rewardType, roundReference, snapshotBlock, publisher, attestSigs, dogeAnchorTxid, e){
        if(!ar.isAnchorRewardDeriveActive(Number(snapshotBlock), network)) return;
        if(!publisher || !Array.isArray(attestSigs) || attestSigs.length === 0) return;
        let amount = (rewardType === 'anchor_archive') ? ar.ARCHIVE_REWARD_AMOUNT : ar.ANCHOR_REWARD_AMOUNT;
        let sigs   = attestSigs.map(s => ({ pubkey: String(s.pubkey).toLowerCase(), sig: String(s.sig).toLowerCase() }));
        let sigsJson = JSON.stringify(sigs);
        // The txid the drain PROVED mined for this exact tuple. Never taken from a
        // caller that did not go through that proof: a null column is a row nothing
        // downstream can prove, and the BTC indexer derives nothing from it.
        let txid = (dogeAnchorTxid == null || dogeAnchorTxid === '') ? null : String(dogeAnchorTxid).toLowerCase();
        try {
            await this.db.doQuery(
                'INSERT IGNORE INTO anchor_reward_attestations ' +
                '(chain, network, reward_type, round_reference, snapshot_block, publisher, reward_amount, publisher_attestations, doge_anchor_txid) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [chain, network, rewardType, roundReference, snapshotBlock, publisher, amount, sigsJson, txid]);
            let rows = await this.db.doQuery(
                'SELECT id, chain, network, reward_type, round_reference, snapshot_block, publisher, reward_amount, publisher_attestations, doge_anchor_txid, created_at ' +
                'FROM anchor_reward_attestations WHERE chain = ? AND network = ? AND reward_type = ? AND round_reference = ? AND snapshot_block = ? AND publisher = ? LIMIT 1',
                [chain, network, rewardType, roundReference, snapshotBlock, publisher]);
            if(rows && rows[0] && this.hub.hubDbBroadcaster && typeof this.hub.hubDbBroadcaster.broadcastRow === 'function')
                this.hub.hubDbBroadcaster.broadcastRow({ table: 'anchor_reward_attestations', row: rows[0] });
        } catch(err){
            console.warn('StateAnchorPublisher: anchor_reward_attestations record failed (' +
                         rewardType + '/' + roundReference + '): ' + (err && err.message));
            return;   // nothing to federate: peers must not be told about a row we failed to hold
        }
        if(e && e.federate) this._federateRewardAttestation(e, sigs, txid);
    }

    // Federate a CONFIRMED reward attestation to every peer (AML #4170).
    //
    // Broadcast, not gossip-forward: only the publisher that watched its own anchor confirm
    // sends, and a receiver never re-broadcasts, so one attested reward costs exactly one
    // fan-out and a Byzantine peer cannot amplify. The payload carries the reward tuple, the
    // XANCPUB signature set, the proven DOGE txid, and the CHECKPOINT IDENTITY
    // (chain/network/block_index/checkpoint_seq/anchor_version) the receiver needs to re-run
    // the same on-chain proof against its own state_checkpoints row and its own DOGE indexer.
    // The reward AMOUNT is deliberately absent: it is a frozen consensus constant both sides
    // read from the twin module, so there is nothing on the wire to lie about.
    _federateRewardAttestation(e, sigs, txid){
        if(!this.peerManager || !this.identity || !txid) return;
        let payload = {
            chain: String(e.chain), network: String(e.network),
            reward_type: String(e.rewardType), round_reference: Number(e.roundReference),
            snapshot_block: Number(e.snapshotBlock), publisher: String(e.publisher).toLowerCase(),
            doge_anchor_txid: txid, anchor_version: Number(e.anchorVersion),
            block_index: Number(e.blockIndex), checkpoint_seq: Number(e.checkpointSeq),
            attest_sigs: sigs
        };
        payload.sig_pubkey = this.identity.getPubkeyHex().toLowerCase();
        payload.sig        = this.identity.sign(this._rewardFederationCanonical(payload));
        this.peerManager.broadcast(XANCREWARD, payload);
    }

    // The canonical the SENDER signs over an XANCREWARD payload. Distinct from the XANCPUB
    // reward canonical on purpose: this one authenticates the TRANSPORT (who relayed which
    // tuple, bound to which mined txid and which checkpoint identity), while the XANCPUB
    // quorum inside the payload authenticates the REWARD. A receiver checks both, and the
    // 'XANCREWARD|' tag keeps this signature from ever being replayable as either an
    // attestation co-signature or a checkpoint signature.
    _rewardFederationCanonical(d){
        return ['XANCREWARD', String(d.chain), String(d.network), String(d.reward_type),
                String(d.round_reference), String(d.snapshot_block),
                String(d.publisher).toLowerCase(), String(d.doge_anchor_txid).toLowerCase(),
                String(d.anchor_version), String(d.block_index), String(d.checkpoint_seq)].join('|');
    }

    // Receiver half of the federation (AML #4170). Everything here is a re-derivation from
    // this hub's OWN state; the message supplies identity, never authority:
    //   1. the derive flag-day gate, per the row's own snapshot_block, so an inert network
    //      writes nothing at all;
    //   2. the sender's signature over the transport canonical, and the sender's membership
    //      in OUR oracle_publish set at snapshot_block (anti-flood: an outsider cannot make
    //      us run the verification work, let alone queue an entry);
    //   3. the XANCPUB quorum, re-verified against OUR OWN oracle_publish set at
    //      snapshot_block with the canonical rebuilt LOCALLY from the tuple and the FROZEN
    //      amount, so a forged, short, or amount-inflated quorum verifies against nothing;
    //   4. the mined anchor, re-proved by handing the entry to the SAME deferred queue the
    //      publisher uses, so the row is written only once _verifyAnchorOnChain binds that
    //      exact txid at that exact ANCHOR version against our own checkpoint row, buried
    //      dogeConfirmations deep on our own DOGE indexer.
    // A receiver never re-broadcasts and never federates its own write (`federate` unset),
    // so the fan-out stays one hop.
    async _handleRewardAttestation(envelope){
        let d = envelope && envelope.data;
        if(!d) return;
        let network       = String(d.network || '');
        let snapshotBlock = Number(d.snapshot_block);
        if(!Number.isFinite(snapshotBlock)) return;
        if(!ar.isAnchorRewardDeriveActive(snapshotBlock, network)) return;   // gate INERT: no rows exist at all

        let rewardType = String(d.reward_type || '');
        let chain      = String(d.chain || '');
        let publisher  = String(d.publisher || '').toLowerCase();
        let txid       = String(d.doge_anchor_txid || '').toLowerCase();
        let sender     = String(d.sig_pubkey || '').toLowerCase();
        let roundRef   = Number(d.round_reference);
        let version    = Number(d.anchor_version);
        let blockIndex = Number(d.block_index);
        let cpSeq      = Number(d.checkpoint_seq);
        if(!chain || !publisher || !sender) return;
        if(!/^[0-9a-f]{64}$/.test(txid)) return;
        if(!Number.isFinite(roundRef) || !Number.isFinite(blockIndex) || !Number.isFinite(cpSeq)) return;
        if(![4, 5, 6].includes(version)) return;                             // only the attestation-bearing ANCHOR versions carry a reward
        if(rewardType !== 'anchor_archive' && rewardType !== 'anchor_' + chain) return;
        // BIND the two: v6 is the archive leg, v4/v5 the per-chain leg, which is the
        // pairing the BTC derive path enforces (indexer anchor_proof_client._judge:
        // "a v4 can never prove an archive reward and vice versa"). Checked
        // independently, a mis-paired tuple still passes everything downstream: the
        // XANCPUB canonical is rebuilt from the reward_type, so a publisher that really
        // collected a per-chain quorum can federate it against the v6 archive head that
        // wraps the same checkpoint, and the drain's byte-match (four core hashes,
        // identical on both legs) confirms it. The row it writes is append-only and
        // never retracted, and the derive path rejects it forever: consensus-table
        // pollution and a permanently stranded credit. Reject at ingress instead.
        if((rewardType === 'anchor_archive') !== (version === 6)) return;
        if(!Array.isArray(d.attest_sigs) || d.attest_sigs.length === 0) return;
        if(this.identity && sender === this.identity.getPubkeyHex().toLowerCase()) return;   // our own broadcast echoing back

        // The signing/quorum set at the reward's snapshot_block, resolved LOCALLY. This is the
        // same set + weighting the indexer re-verifies against, so a quorum this hub accepts is
        // one the derive path will accept too.
        let signingSet = await this._resolveCapabilitySet('oracle_publish', snapshotBlock, resolveQuorumNetwork({ network: network }, this.network));
        let pubkeys    = new Set((signingSet || []).map(v => String(v.pubkey).toLowerCase()));
        if(pubkeys.size === 0) return;                                       // unresolved set: fail closed, exactly like every other path here
        if(!pubkeys.has(sender))    return;                                  // relayer is not one of ours
        if(!pubkeys.has(publisher)) return;                                  // the earner must itself hold oracle_publish, or the indexer drops it anyway
        if(!ValidatorIdentity.verify(this._rewardFederationCanonical(d), String(d.sig || ''), sender)) return;

        // Rebuild the XANCPUB canonical from the tuple and the FROZEN amount. Nothing from the
        // wire enters it, so an inflated reward_amount cannot be co-signed into existence.
        let cp        = { chain: chain, network: network, checkpoint_seq: roundRef, snapshot_block: snapshotBlock };
        let canonical = (rewardType === 'anchor_archive')
            ? this._archiveAttestationCanonical({ network: network, snapshot_block: snapshotBlock }, roundRef, publisher)
            : this._attestationCanonical(cp, publisher);

        let seen = new Set(), signers = [], sigs = [];
        for(let s of d.attest_sigs){
            let pk = String(s && s.pubkey || '').toLowerCase();
            if(!pk || seen.has(pk) || !pubkeys.has(pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s && s.sig || ''), pk)) continue;
            seen.add(pk);
            signers.push(pk);
            sigs.push({ pubkey: pk, sig: String(s.sig).toLowerCase() });
        }
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, resolveQuorumNetwork({ network: network }, this.network));
        let met;
        if(weighted){
            let weightedSet = (signingSet || []).map(v => ({
                pubkey: String(v.pubkey).toLowerCase(),
                source: String(v.source != null ? v.source : ''),
                weight: String(v.amount != null ? v.amount : '0')
            }));
            // Carry the truncation flag through, exactly as the publisher-attestation round
            // does: meetsStakeThreshold fails CLOSED on an over-cap snapshot, and dropping the
            // flag here would let a receiver accept a quorum on a truncated set that the
            // indexer's own weighted check would then reject, stranding the credit.
            if(signingSet && signingSet.truncated === true) weightedSet.truncated = true;
            met = swq.meetsStakeThreshold(weightedSet, signers);
        } else {
            met = signers.length >= bftQuorumOrSingle(pubkeys.size, 1);
        }
        if(!met){
            console.warn('StateAnchorPublisher: federated reward attestation ' + rewardType + '/' + roundRef +
                         ' from ' + sender + ' failed local XANCPUB re-verification (' + signers.length +
                         ' of ' + pubkeys.size + ' local oracle_publish signers); dropped');
            return;
        }

        // Quorum-valid, but NOT yet proven mined on our own DOGE view. Hand it to the same
        // confirm-then-write queue the publisher uses rather than writing here.
        this._deferRewardAttestation({
            chain: chain, network: network, blockIndex: blockIndex, checkpointSeq: cpSeq,
            txid: txid, anchorVersion: version,
            rewardType: rewardType, roundReference: roundRef, snapshotBlock: snapshotBlock,
            publisher: publisher, attestSigs: sigs
        });
    }

    // Hold a reward attestation until its anchor is actually MINED.
    // _broadcastWithRetry returns when DOGE ACCEPTS the transaction, not when it is
    // confirmed (see the note at the top of this file), so both producer
    // sites used to write the mirror row against a mempool txid. Because the row is
    // append-only and never retracted and the BTC indexer mints a COLLECT-spendable
    // validator_rewards from it, an evicted or reorged anchor left a permanent reward
    // for a transaction the chain never carried; nothing downstream can undo it.
    //
    // Queuing grants no authority: the entry writes nothing until
    // _drainDeferredRewardAttest sees _verifyAnchorOnChain bind this exact txid at this
    // exact ANCHOR version, buried dogeConfirmations deep. `e` carries the checkpoint
    // identity (chain/network/blockIndex/checkpointSeq) that verification re-SELECTs, the
    // txid and anchorVersion it must bind, and the attestation tuple to write.
    //
    // RESIDUAL, deliberate: this queue is in memory, so a restart inside the confirmation
    // window forfeits THIS hub's own reward for that anchor. That is fail-closed and
    // fleet-uniform (no row exists, so every indexer derives the same nothing), where the
    // behavior it replaces was fail-open (a permanent mint for an anchor that never
    // landed). Making it durable means persisting the XANCPUB sigs, which exist only in
    // the attestation round's memory today.
    _deferRewardAttestation(e){
        if(!e || !ar.isAnchorRewardDeriveActive(Number(e.snapshotBlock), e.network)) return;   // gate INERT: no rows exist at all
        if(!e.txid || !e.publisher || !Array.isArray(e.attestSigs) || e.attestSigs.length === 0) return;
        let key = [e.rewardType, String(e.roundReference), String(e.snapshotBlock),
                   String(e.publisher), String(e.txid)].join('|');
        if(this._deferredRewardAttest.has(key)) return;
        // Bounded: drop the OLDEST entry rather than the new one (Map preserves insertion
        // order), matching the two announcement queues. Dropping only ever forfeits this
        // hub's own reward; it can never write one.
        if(this._deferredRewardAttest.size >= this.announceQueueMax){
            let oldest = this._deferredRewardAttest.keys().next().value;
            this._deferredRewardAttest.delete(oldest);
            console.warn('StateAnchorPublisher: deferred reward-attestation queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        this._deferredRewardAttest.set(key, Object.assign({}, e, { at: Date.now() }));
        console.log('StateAnchorPublisher: reward attestation ' + e.rewardType + '/' + e.roundReference +
                    ' held until anchor ' + e.txid + ' is ' + this.dogeConfirmations + ' deep on DOGE (' +
                    this._deferredRewardAttest.size + ' pending)');
    }

    // Write the queued reward attestations whose anchor has since been buried. Runs on
    // the announceRetryMs timer and at the head of every flush, beside the V0_DONE and
    // FINALIZED drains.
    //
    // Only 'verified' writes: _verifyAnchorOnChain binds the exact txid AND the exact
    // ANCHOR version, so neither a never-mined transaction nor a different anchor for the
    // same checkpoint can stand in as proof. A decided CONTENT verdict
    // ('rejected:status' / ':mismatch' / ':version') is terminal for this txid and drops
    // the entry. 'rejected:txid' is deliberately NOT terminal here: getanchoraction
    // reports checkpoint_anchored UNFILTERED, so that verdict also fires while our own tx
    // is merely unmined on a checkpoint that already carries an earlier anchor, which is
    // the v6 archive head's normal state. Retrying it until the TTL costs a queue slot;
    // dropping it would forfeit a legitimate reward. Every non-verified outcome writes
    // nothing either way, so the safety property does not depend on this choice.
    async _drainDeferredRewardAttest(){
        if(this._deferredRewardAttest.size === 0) return;
        for(let [key, e] of [...this._deferredRewardAttest]){
            if(Date.now() - e.at > this.announceRetryTtlMs){
                this._deferredRewardAttest.delete(key);
                console.warn('StateAnchorPublisher: deferred reward attestation ' + key + ' expired after ' +
                             this.announceRetryTtlMs + 'ms without its anchor confirming; dropped (no reward is ' +
                             'derived for an anchor that never landed)');
                continue;
            }
            try {
                // Re-SELECT our OWN checkpoint row (never a cached copy): _verifyAnchorOnChain
                // byte-matches the decoded on-chain payload against it.
                let rows = await this.db.doQuery(
                    'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
                    [String(e.chain), String(e.network), Number(e.blockIndex), Number(e.checkpointSeq)]);
                if(!rows || rows.length === 0) continue;              // checkpoint gone (reorg): let the TTL clear it
                let v = await this._verifyAnchorOnChain(rows[0], { txid: String(e.txid), version: Number(e.anchorVersion) });
                if(v === 'verified'){
                    this._deferredRewardAttest.delete(key);
                    // The proven txid goes ONTO the row (doge_anchor_txid): it is what every
                    // downstream re-proof (a peer's XANCREWARD check, the BTC indexer's
                    // getanchorconfirmations check) binds the reward to. `e` also carries the
                    // publisher's federate flag, so the fan-out happens at the confirmed write.
                    await this._recordRewardAttestation(e.chain, e.network, e.rewardType, Number(e.roundReference),
                                                        Number(e.snapshotBlock), e.publisher, e.attestSigs,
                                                        String(e.txid).toLowerCase(), e);
                    console.log('StateAnchorPublisher: reward attestation ' + key + ' anchor confirmed on DOGE; row written');
                } else if(v === 'rejected:status' || v === 'rejected:mismatch' || v === 'rejected:version'){
                    this._deferredRewardAttest.delete(key);
                    console.warn('StateAnchorPublisher: reward attestation ' + key + ' REJECTED on re-verification (' +
                                 v + '); dropped, no reward');
                }
            } catch(err){
                console.warn('StateAnchorPublisher: reward attestation ' + key +
                             ' re-verification error: ' + (err && err.message));
            }
        }
    }

    _buildV0Payload(row){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '0', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block), String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        return parts.join('|');
    }

    // SPV Phase 2 (spec §6.3): v0 checkpoint PLUS the two light-client roots + version
    // bytes appended before SIG_COUNT (positional). The roots come straight from the
    // signed state_checkpoints row; the row's sigs already cover them (the post-flag-day
    // checkpoint canonical includes the same roots), so this transports signed data.
    _buildV3Payload(row){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '3', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block),
                     String(row.state_root || '').toLowerCase(), String(row.state_root_version),
                     String(row.block_merkle_root || '').toLowerCase(), String(row.block_merkle_version),
                     String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        return parts.join('|');
    }

    // ANCHOR v4 (anchor-reward flag-day): the rootless v0 checkpoint PLUS the elected
    // PUBLISHER pubkey and a 2f+1 oracle_publish attestation (XANCPUB) over the reward
    // tuple, appended AFTER the root signature list. The indexer re-derives the reward
    // from these bytes (anchor.js formats[4]), so the trusted hub push is retired.
    // Field order MUST match the indexer parser: ...|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|
    // ATTEST_SIG_COUNT|APUBKEY|ASIG|...
    _buildV4Payload(row, publisher, attestSigs){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '4', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block), String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        parts.push(String(publisher).toLowerCase(), String((attestSigs || []).length));
        for(let s of (attestSigs || [])) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        return parts.join('|');
    }

    // ANCHOR v5: the root-bearing v3 checkpoint (SPV light-client roots + version bytes)
    // PLUS the same publisher + XANCPUB attestation tail as v4 (indexer formats[5]). Emitted
    // instead of v3 when the checkpoint carries roots AND the anchor-reward flag-day is met.
    _buildV5Payload(row, publisher, attestSigs){
        let sigs = this._parseSigs(row.validator_signatures);
        let parts = ['ANCHOR', '5', row.chain, row.network, String(row.block_index), row.block_hash,
                     row.ledger_hash, row.actions_hash, row.contract_hash,
                     String(row.checkpoint_seq), String(row.snapshot_block),
                     String(row.state_root || '').toLowerCase(), String(row.state_root_version),
                     String(row.block_merkle_root || '').toLowerCase(), String(row.block_merkle_version),
                     String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        parts.push(String(publisher).toLowerCase(), String((attestSigs || []).length));
        for(let s of (attestSigs || [])) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        return parts.join('|');
    }

    // Publisher-attestation canonical (XANCPUB): the string the 2f+1 oracle_publish quorum
    // signs to ATTEST which validator earns the anchor reward. MUST be BYTE-IDENTICAL to the
    // indexer's Anchor._rewardCanonical (a divergence forks the derived reward row). The
    // amount is the FROZEN consensus constant (ar.ANCHOR_REWARD_AMOUNT, read from the twin
    // module, NOT the operator-tunable ANCHOR_REWARD_PER_PUBLISH env). The EQUIV wrapper uses
    // the checkpoint's NETWORK (cp.network) like _canonical/_archiveCanonical, NOT this.network,
    // and a distinct 'XANCPUB|...' roundId gives the attestation its own equivocation family so
    // a validator that signs both the checkpoint root canonical and this reward attestation in
    // the same round is never falsely slashable.
    _attestationCanonical(cp, publisher){
        let base = ['XANCPUB', 'anchor_' + cp.chain, String(cp.checkpoint_seq),
                    String(cp.snapshot_block), String(publisher || '').toLowerCase(),
                    ar.ANCHOR_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network)){
            let roundId = 'XANCPUB|' + cp.chain + '|' + cp.network + '|' + cp.checkpoint_seq + '|' + cp.snapshot_block;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }

    // Run the publisher-attestation round for a checkpoint THIS hub is publishing.
    // Resolves { met, sigs:[{pubkey,sig}], publisher } once a 2f+1 oracle_publish quorum
    // (stake-weighted at/above STAKE_WEIGHTED_QUORUM, else count) co-signs XANCPUB, or
    // { met:false } on timeout / short quorum. The SIGNING/QUORUM set is resolved at the
    // checkpoint's snapshot_block, the SAME set the indexer (anchor.js) verifies the
    // attestation against, so the hub never collects a quorum the chain then rejects.
    async _runPublisherAttestationRound(cp, publisher){
        if(!this.identity) return { met: false, sigs: [] };

        // _resolveCapabilitySet FAILS CLOSED off regtest (it throws when the
        // deterministic snapshot is unavailable), which is right for the callers that
        // must not build on a divergent set. Here it would abort the whole anchor: this
        // round is awaited inside the per-row publish loop, whose catch only logs 'v0
        // publish failed' and drops the row, so a transient snapshot outage would
        // withhold the ANCHOR itself rather than just its reward. Degrade instead,
        // byte-identically to the snapCount === 0 abstain below: no attestation, legacy
        // v0/v3 lands, no reward is recorded. Scoped to the resolve call only, so an
        // unrelated throw inside the round still surfaces.
        let signingSet;
        try {
            signingSet = await this._resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));
        } catch(e){
            console.warn('StateAnchorPublisher: oracle_publish set unresolvable at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (' + (e && e.message) + '); abstaining from the ' +
                         'publisher-attestation round (legacy anchor, no reward) rather than blocking the anchor');
            return { met: false, sigs: [] };
        }
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let me        = this.identity.getPubkeyHex().toLowerCase();
        let canonical = this._attestationCanonical(cp, publisher);
        let mySig     = this.identity.sign(canonical);

        // An UNRESOLVED (empty) signing set is not a quorum of one: abstain. The rest of
        // this file fails closed on an unresolved set, and the two resolvers used across
        // one round can legitimately disagree (_getActiveOraclePublishPubkeys reads the
        // capability snapshot, _resolveCapabilitySet may take the weighted one), so a
        // hub can pass the eligible.length fail-closed gate in _publishPendingCheckpoints
        // and still resolve snapCount 0 here. Self-attesting on that would emit a v4/v5
        // carrying one signature that every indexer rejects (it resolves a non-empty set),
        // while THIS hub banks and archives an anchor reward no live indexer credits: the
        // live-vs-recovered ledger fork the reward gates exist to prevent. Falling back to
        // a legacy anchor is degraded, not divergent.
        if(snapCount === 0){
            console.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + '; abstaining from the publisher-attestation round ' +
                         '(legacy anchor, no reward) rather than self-attesting');
            return { met: false, sigs: [] };
        }
        // The publisher must itself hold oracle_publish at snapshot_block, or the indexer
        // drops the reward (PUBLISHER must be in the verified set). Fall back to a legacy
        // anchor rather than emit a v4/v5 whose reward can never be credited.
        if(!signingPubkeys.includes(me)) return { met: false, sigs: [] };

        let signatures = new Map();
        signatures.set(me, mySig);

        // Genuine single-node set (snapCount === 1, membership proven above): the
        // publisher's own attestation IS the quorum.
        if(snapCount <= 1 || !this.peerManager)
            return { met: true, sigs: [{ pubkey: me, sig: mySig }], publisher: publisher };

        return await new Promise((resolve) => {
            // Full {pubkey, source, weight} set so the stake-weighted tally can sum
            // distinct-source stake, identical to the archive round.
            let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
            // Preserve the truncation flag so the weighted reward quorum
            // (_checkAttestQuorum via meetsStakeThreshold) fails closed on an over-cap
            // oracle_publish snapshot, identical to the archive round (_startArchiveRound:899).
            // Without this the publisher-attestation quorum fail-OPENS on a truncated set,
            // emitting a v4/v5 whose reward the indexer would drop (stranded credit).
            if(signingSet.truncated === true) roundValidators.truncated = true;
            let round = {
                cp, publisher, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            this._attestRound = round;
            round.timer = setTimeout(() => {
                if(this._attestRound === round && !round.done){
                    round.done = true;
                    this._attestRound = null;
                    console.warn('StateAnchorPublisher: publisher-attestation round (seq ' + cp.checkpoint_seq +
                                 ') timed out at ' + round.signatures.size + '/' + quorum + ' sigs; legacy fallback');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })) });
                }
            }, this.roundTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            this.peerManager.broadcast(XANCPUB_SIGN_REQ, {
                checkpoint: cp, publisher: publisher, sig_pubkey: me, sig: mySig
            });
            this._checkAttestQuorum();
        });
    }

    _checkAttestQuorum(){
        let round = this._attestRound;
        if(!round || round.done) return;
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._attestRound = null;
        round.resolve({ met: true, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })), publisher: round.publisher });
    }

    // Follower: co-sign the publisher attestation ONLY when the proposer is the
    // legitimately rank-unlocked publisher of a checkpoint that byte-matches our own
    // state_checkpoints row, and we ourselves hold oracle_publish at its snapshot_block.
    // The frozen amount is enforced implicitly: we rebuild the canonical with
    // ar.ANCHOR_REWARD_AMOUNT, so a wire-supplied amount can never be co-signed.
    async _handleAttestSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !d.checkpoint) return;
        let cp        = d.checkpoint;
        let myPubkey  = this.identity.getPubkeyHex().toLowerCase();
        let sender    = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;
        // The publisher attests ITSELF: the proposer must be the rewarded publisher, or it
        // is binding a pubkey it is not entitled to.
        let publisher = String(d.publisher || '').toLowerCase();
        if(publisher !== sender) return;

        // Re-run the v0 publisher election (oracle_publish @ snapshot_block, hash-ordered by
        // the v0 election key) and confirm the proposer is rank-unlocked on the SAME failover
        // ladder _publishPendingCheckpoints used, bounded to our own BTC tip (anti-spam; the
        // binding security is the checkpoint + frozen-amount re-derivation below).
        let eligible = await this._getActiveOraclePublishPubkeys(Number(cp.snapshot_block));
        if(eligible.length === 0) return;
        {
            // Run the ladder check for EVERY set size: a single-member set must
            // still bind sender === eligible[0] (rank 0), or any current member
            // could impersonate the sole elected publisher.
            let order = StateAnchorPublisher.hashOrder(this._v0ElectionKey(cp), eligible);
            let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - Number(cp.snapshot_block) : null;
            if(!this._rankUnlocked(order, sender, since)) return;          // proposer not unlocked
        }
        // Only co-sign if WE hold oracle_publish at snapshot_block, or the indexer would drop
        // our attestation signature anyway (same gate the archive follower applies).
        if(!eligible.includes(myPubkey)) return;

        // The checkpoint must equal OUR own state_checkpoints row (latest seq for the height);
        // a reorg-superseded row never attests. canonicalCheckpoint binds chain/network/
        // block_index/hashes/checkpoint_seq/snapshot_block, so this also rejects a proposer
        // whose seq or snapshot_block differs from ours.
        let local = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? ORDER BY checkpoint_seq DESC LIMIT 1',
            [cp.chain, cp.network, Number(cp.block_index)]);
        if(!local || local.length === 0) return;
        let mine = this._cpFromRow(local[0]);
        // Compare the ROOTLESS canonical deliberately: the attestation canonical this
        // path signs carries no SPV root suffix, and _cpFromRow omits the root fields,
        // so both operands are rootless today. Using _rawCanonicalCheckpoint pins that
        // intent so a future root-bearing operand on one side can't flip this guard
        // fail-closed post-flag-day.
        if(StateCheckpointEngine._rawCanonicalCheckpoint(mine) !== StateCheckpointEngine._rawCanonicalCheckpoint(cp)) return;

        let canonical = this._attestationCanonical(cp, publisher);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;   // proposer's own sig

        this.peerManager.broadcast(XANCPUB_SIGN, {
            chain: cp.chain, network: cp.network,
            checkpoint_seq: Number(cp.checkpoint_seq), snapshot_block: Number(cp.snapshot_block),
            sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    async _handleAttestSign(envelope){
        let d = envelope.data;
        let round = this._attestRound;
        if(!round || round.done || !d) return;
        // Match the active round by checkpoint identity (chain/network/seq/snapshot_block).
        if(String(d.chain) !== String(round.cp.chain) || String(d.network) !== String(round.cp.network) ||
           Number(d.checkpoint_seq) !== Number(round.cp.checkpoint_seq) ||
           Number(d.snapshot_block) !== Number(round.cp.snapshot_block)) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this._checkAttestQuorum();
    }

    // Archive publisher-attestation canonical: the string the 2f+1 oracle_publish
    // quorum signs to ATTEST which validator earns the anchor_archive reward. MUST be
    // BYTE-IDENTICAL to the indexer's Anchor._rewardCanonical for FORMAT 6 (a divergence
    // forks the derived reward row). The amount is the FROZEN consensus constant
    // (ar.ARCHIVE_REWARD_AMOUNT, from the twin module, NOT the operator-tunable env). The
    // 'XANCPUB|archive|...' roundId is disjoint from every per-chain XANCPUB roundId, so
    // the two attestation families can never equivocation-collide.
    _archiveAttestationCanonical(cp, batchSeq, publisher){
        let base = ['XANCPUB', 'anchor_archive', String(batchSeq),
                    String(cp.snapshot_block), String(publisher || '').toLowerCase(),
                    ar.ARCHIVE_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network)){
            let roundId = 'XANCPUB|archive|' + cp.network + '|' + batchSeq + '|' + cp.snapshot_block;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }

    // Run the archive publisher-attestation round for a batch THIS hub is publishing
    // (mirrors _runPublisherAttestationRound for the archive leg). The signing/quorum set
    // is resolved at the wrapper checkpoint's snapshot_block, the SAME set the indexer
    // (anchor.js formats[6]) verifies the attestation against.
    async _runArchiveAttestationRound(cp, batchSeq, publisher){
        if(!this.identity) return { met: false, sigs: [] };

        // Same fail-closed resolver, same reason to degrade rather than propagate (see
        // _runPublisherAttestationRound): this round is awaited in _publishArchive AFTER
        // the v1 co-sign quorum has already been collected, so a throw here discards a
        // completed round instead of publishing the legacy v1 the archive's own liveness
        // note promises. Abstaining matches the snapCount === 0 branch below exactly.
        let signingSet;
        try {
            signingSet = await this._resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));
        } catch(e){
            console.warn('StateAnchorPublisher: oracle_publish set unresolvable at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (' + (e && e.message) + '); abstaining from the ' +
                         'archive publisher-attestation round (legacy v1, no reward) rather than discarding the archive');
            return { met: false, sigs: [] };
        }
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let me        = this.identity.getPubkeyHex().toLowerCase();
        let canonical = this._archiveAttestationCanonical(cp, batchSeq, publisher);
        let mySig     = this.identity.sign(canonical);

        // Unresolved (empty) set: abstain, exactly as the v4/v5 round does. Self-attesting
        // here would emit a v6 whose lone signature every indexer rejects while this hub
        // banks and archives the archive-anchor reward locally.
        if(snapCount === 0){
            console.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + '; abstaining from the archive publisher-attestation ' +
                         'round (legacy v1, no reward) rather than self-attesting');
            return { met: false, sigs: [] };
        }
        // The publisher must itself hold oracle_publish at snapshot_block, or the indexer
        // drops the reward (PUBLISHER must be in the verified set). Fall back to a legacy
        // v1 rather than emit a v6 whose reward can never be credited.
        if(!signingPubkeys.includes(me)) return { met: false, sigs: [] };

        let signatures = new Map();
        signatures.set(me, mySig);

        // Genuine single-node set (snapCount === 1, membership proven above).
        if(snapCount <= 1 || !this.peerManager)
            return { met: true, sigs: [{ pubkey: me, sig: mySig }], publisher: publisher };

        return await new Promise((resolve) => {
            let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
            // Preserve the truncation flag so the weighted quorum fails closed on an
            // over-cap oracle_publish snapshot (same reasoning as the v4/v5 round: a
            // fail-open would emit a v6 whose reward the indexer drops).
            if(signingSet.truncated === true) roundValidators.truncated = true;
            let round = {
                cp, batchSeq, publisher, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            this._archiveAttestRound = round;
            round.timer = setTimeout(() => {
                if(this._archiveAttestRound === round && !round.done){
                    round.done = true;
                    this._archiveAttestRound = null;
                    console.warn('StateAnchorPublisher: archive publisher-attestation round (batch ' + batchSeq +
                                 ') timed out at ' + round.signatures.size + '/' + quorum + ' sigs; legacy v1 fallback');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })) });
                }
            }, this.roundTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            this.peerManager.broadcast(XANCARCHPUB_SIGN_REQ, {
                batch_seq: batchSeq, publisher: publisher, sig_pubkey: me, sig: mySig
            });
            this._checkArchiveAttestQuorum();
        });
    }

    _checkArchiveAttestQuorum(){
        let round = this._archiveAttestRound;
        if(!round || round.done) return;
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._archiveAttestRound = null;
        round.resolve({ met: true, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })), publisher: round.publisher });
    }

    // Follower: co-sign the ARCHIVE publisher attestation ONLY when the proposer is an
    // archive leader we OBSERVED pass the election/rank check for THIS batch_seq (the same
    // observed-leader authority _handleFinalized trusts), the attestation binds the
    // proposer itself as the earner, and we hold oracle_publish at the batch's wrapper
    // snapshot_block. The canonical is rebuilt from OUR OWN stashed checkpoint identity
    // and the frozen ARCHIVE_REWARD_AMOUNT, so neither a wire-supplied snapshot_block nor
    // a wire-supplied amount can ever be co-signed.
    async _handleArchiveAttestSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d) return;
        let myPubkey  = this.identity.getPubkeyHex().toLowerCase();
        let sender    = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;
        let publisher = String(d.publisher || '').toLowerCase();
        if(publisher !== sender) return;
        let batchSeq = Number(d.batch_seq);
        if(!Number.isFinite(batchSeq)) return;
        // Fail closed on an un-observed round: we only attest an archive election we
        // ourselves witnessed via its XANC_SIGN_REQ.
        if(!this._isObservedArchiveLeader(batchSeq, sender)) return;
        let id = this._observedArchiveCheckpoint(batchSeq);
        if(!id) return;
        // Resolve the stashed identity to OUR OWN state_checkpoints row (never the wire).
        let rows = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
            [id.chain, id.network, Number(id.block_index), Number(id.checkpoint_seq)]);
        if(!rows || rows.length === 0) return;
        let cp = this._cpFromRow(rows[0]);
        // Only co-sign if WE hold oracle_publish at snapshot_block, or the indexer would
        // drop our attestation signature anyway.
        let eligible = await this._getActiveOraclePublishPubkeys(Number(cp.snapshot_block));
        if(eligible.length === 0 || !eligible.includes(myPubkey)) return;

        let canonical = this._archiveAttestationCanonical(cp, batchSeq, publisher);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;   // proposer's own sig

        this.peerManager.broadcast(XANCARCHPUB_SIGN, {
            batch_seq: batchSeq,
            sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    async _handleArchiveAttestSign(envelope){
        let d = envelope.data;
        let round = this._archiveAttestRound;
        if(!round || round.done || !d) return;
        if(Number(d.batch_seq) !== Number(round.batchSeq)) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this._checkArchiveAttestQuorum();
    }

    // Archive round (v1/v2).
    // Leader = hash-order rank 0 over the oracle_publish set, with the same
    // failover ladder as v0 anchors: the election key is anchored on the archive
    // CONTENT (wrapper checkpoint + batch seq; deterministic + identical on
    // every hub, and stable while the batch is stalled), and each further rank
    // unlocks after another ANCHOR_ELECTION_TOLERANCE_BLOCKS past the wrapper
    // checkpoint's snapshot_block. Without the ladder a signer-less elected
    // leader stalled archiving (live on a 3-hub test cluster: only 1-of-3 elections could
    // publish; on a static regtest tip the same leader won forever). Returns
    // the flush summary's archive status.
    async _startArchiveRound(signer, electionBlock, failoverOnly){
        if(this._archiveRound) return 'round_pending';                       // one at a time

        // Fail closed on an unresolved BTC tip. flush() passes whatever
        // hub._resolveBtcLatestBlock() returned, and that is null whenever the pushed tip
        // is stale, the indexer lags past MAX_INDEXER_LAG_BLOCKS, or the RPC fails. A null
        // block makes _getActiveOraclePublishPubkeys take its block-UNPINNED branch, whose
        // own contract scopes it to the coarse V0_DONE / FINALIZED sender pre-filter: it
        // answers from the per-hub, gossip-driven capabilityRegistry, so two hubs would
        // elect over different member lists on a path that spends real DOGE. The follower
        // side already refuses this round (_handleSignReq bounds election_block to its own
        // tip), so the leader-side defer costs a stalled multi-hub round it was never going
        // to complete, and closes the single-member case that self-quorums today. Same
        // fail-closed idiom as the empty-set defer below; rows stay pending for the next
        // flush, exactly like the balance and spend-guard gates in flush().
        if(!Number.isFinite(electionBlock)){
            console.warn('StateAnchorPublisher: BTC tip unresolved (' + electionBlock +
                         '); deferring archive round rather than electing over the ' +
                         'block-unpinned live registry (fail closed)');
            return 'none';
        }

        // Leader ELECTION runs over the set at the current BTC block (liveness: a
        // freshly-joined validator can take over a stalled publish even when the
        // wrapper checkpoint's snapshot_block is hours old). This set decides only
        // WHO drives the round + pays the DOGE; it does NOT gate which signatures
        // count on-chain (that is the snapshot_block signing set resolved below).
        let electionPubkeys = await this._getActiveOraclePublishPubkeys(electionBlock);
        let me = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        // Fail closed: an empty/unresolved oracle_publish set must defer the
        // archive round, not let every hub drive it independently (each would
        // broadcast a competing v1 + burn DOGE for the same batch slot).
        if(electionPubkeys.length === 0){
            console.log('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': empty oracle_publish set, deferring round (fail closed)');
            return 'none';
        }
        if(!me) return 'none';
        if(!electionPubkeys.includes(me)){
            console.log('StateAnchorPublisher: archive election at block ' + electionBlock +
                        ': own pubkey not in the oracle_publish election set (' + electionPubkeys.length + ' eligible)');
            return 'none';                                               // not an eligible publisher right now
        }

        let matches = await this.db.doQuery(
            "SELECT * FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status " +
            "ORDER BY match_id ASC LIMIT ?", [this.maxBatch]);
        let calls = await this.db.doQuery(
            "SELECT * FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status " +
            "ORDER BY call_id ASC, phase ASC LIMIT ?", [this.maxBatch]);
        // Archive transport for the anchor_% reward rails. Read this before touching
        // recovery dedup: the "indexer can never re-derive these" invariant is NOT
        // uniformly true any more, and the difference matters because these rows land
        // on the COLLECT-spendable ledger.
        //   - anchor_<CHAIN> BELOW the anchor-reward flag-day, and anchor_archive BELOW
        //     the archive-reward flag-day: genuinely hub-pushed. The chain
        //     carries no parse for them, so the archive is their only recovery
        //     transport. The original invariant holds here.
        //   - anchor_<CHAIN> AT/ABOVE the anchor-reward flag-day, and anchor_archive
        //     AT/ABOVE the archive-reward flag-day: the indexer DOES re-derive these
        //     on-chain from the v4/v5/v6 XANCPUB publisher attestation (anchor.js
        //     createValidatorReward / reconcileAnchorRewardWinner), crediting the same
        //     frozen ANCHOR_REWARD_AMOUNT / ARCHIVE_REWARD_AMOUNT. The hub still records the row locally
        //     (RewardTracker isDerived path) and this selector still archives it, so the
        //     archive redundantly transports a row the chain reproduces.
        // That redundancy is safe ONLY because restore and derive both key on the UNIQUE
        // (validator_pubkey, round_number, reward_type), so the two paths dedup and the
        // amounts agree. Weaken that dedup and the archived anchor_<CHAIN> row becomes a
        // genuine SECOND credit. Do not treat "archived" as proof of "not re-derivable".
        // (oracle_round/attest_fee rows are indexer-derived and NEVER archived.)
        // Rows are immutable, so batch_seq IS NULL is the only pending test;
        // pre-upgrade rows without a deterministic block_index stay local.
        let rewards = await this.db.doQuery(
            "SELECT * FROM validator_rewards WHERE reward_type LIKE 'anchor\\_%' AND batch_seq IS NULL AND block_index IS NOT NULL " +
            "ORDER BY reward_type ASC, round_number ASC, validator_pubkey ASC LIMIT ?", [this.maxBatch]);
        if((!matches || matches.length === 0) && (!calls || calls.length === 0) && (!rewards || rewards.length === 0)){ this._pendingMatches = 0; return 'none'; }
        matches = matches || [];
        calls   = calls   || [];
        rewards = rewards || [];

        // The checkpoint wrapper: latest checkpoint (prefer BTC; its height also
        // selects validator sets). Without any checkpoint there is nothing to bind
        // the archive's signatures to, so defer until the checkpoint engine has run.
        // Scoped to this.network when one is configured, so a prior-network
        // leftover row can never become the archive wrapper (same hazard the
        // latch loader defends against); unconfigured-network hubs keep the
        // legacy unscoped selection.
        // Ordered on the CONSENSUS key (checkpoint_seq, then snapshot_block, then
        // block_index), never on `id`. `id` is this hub's AUTO_INCREMENT insertion
        // cursor: every hub writes its own state_checkpoints rows (_acceptFinalized on
        // both the leader and follower paths), so id ordering is local insertion order,
        // which MATCH_KEYS already calls "the hub-assigned mirror cursor" and
        // _verifyArchiveAgainstLocal deletes before byte-comparing. The selected row
        // feeds _archiveElectionKey, which advertises itself as "deterministic +
        // identical on every hub"; keying that on a locally-ordered pick let two hubs
        // elect over different keys for the same batch_seq (divergent rank orders, a
        // stalled or double-published archive round). checkpoint_seq is quorum-agreed
        // and derived from snapshot_block, so it is the same value on every hub.
        let cps = this.network
            ? await this.db.doQuery(
                "SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1",
                [this.network])
            : await this.db.doQuery(
                "SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1");
        if(!cps || cps.length === 0){
            console.log('StateAnchorPublisher: no state checkpoint yet; archive deferred');
            return 'none';
        }
        let cp = this._cpFromRow(cps[0]);

        let network  = String(cps[0].network);

        // Durable at-most-once for the ARCHIVE spend, the twin of the
        // anchor_published_checkpoints gate in _publishPendingCheckpoints. A crash
        // between an accepted v1/v2 send and _backfillBatch leaves every source row
        // pending. The archive path does read mined state, through getarchiveanchor
        // rather than getanchoraction, but only at the send: _publishArchive passes
        // _findExistingArchiveAnchor to _broadcastWithRetry, and that lookup answers from
        // parsed on-chain actions, so a send still sitting in the DOGE mempool reads as
        // absent. Without this marker the next flush therefore rebuilds the whole batch
        // under a fresh seq and re-pays for the head plus every chunk. Checked here,
        // which is BEFORE any such lookup, before the batch seq is drawn and
        // before the co-signing round burns a quorum, so a held round costs nothing.
        // Bounded by anchorIntentTtlMs: an unbounded marker for a send that never
        // relayed would stall archiving forever.
        let liveIntent = await this._getLiveArchiveIntent(network);
        if(this._anchorIntentHolds(liveIntent)){
            console.warn('StateAnchorPublisher: archive round for ' + network + ' held: batch ' +
                         liveIntent.batch_seq + ' recorded a broadcast intent at ' + String(liveIntent.intent_at) +
                         (liveIntent.txid ? ' (v1 txid ' + liveIntent.txid + ')' : '') +
                         ' and never finished its bookkeeping; not rebuilding a second archive until that ' +
                         'intent ages past ' + this.anchorIntentTtlMs + 'ms (rows stay pending)');
            return 'intent_held';
        }

        let batchSeq = await this._getNextBatchSeq();

        {
            // Unconditional (all set sizes): the membership check above already
            // pins the size-1 identity, and a single-member ladder resolves to
            // rank 0 (always unlocked), so this is uniform, not a behavior change.
            let order = StateAnchorPublisher.hashOrder(this._archiveElectionKey(cp, batchSeq), electionPubkeys);
            let since = Number.isFinite(electionBlock) ? electionBlock - Number(cp.snapshot_block) : null;
            // Same backup-only rule as the v0 path. A leader driving its
            // own batch on the wake cadence would archive whatever few rows are
            // pending every 15 minutes instead of accumulating them to the interval
            // or the size trigger, which is the over-anchoring this mode exists to
            // avoid. Backups are exactly who the wake is for.
            if(failoverOnly && this._isRankZero(order)) return 'none';
            if(!this._rankUnlocked(order, me, since)){
                // Operator visibility: a hub that never wins the archive
                // election (e.g. signer-less peers keep ranking first) is
                // indistinguishable from a broken publisher without this.
                console.log('StateAnchorPublisher: archive election (batch ' + batchSeq + ') at block ' + electionBlock +
                            ': rank ' + order.indexOf(me) + '/' + order.length + ' (leader ' +
                            order[0].substring(0, 12) + '..., ladder unlocks a rank every ' +
                            this.electionToleranceBlocks + ' blocks), not publishing');
                return 'none';                                               // not unlocked on the failover ladder
            }
        }
        // Pin each reward's earn-time source into the archive (resolved via the
        // BTC indexer, block-scoped; every hub gets the same answer, and
        // recovery restores rewards BEFORE the BTC reindex so it cannot resolve
        // them itself). An unresolvable source leaves the row for a later batch
        // rather than archiving a hole.
        let rewardRows = [];
        for(let r of rewards){
            let source = this.hub.rewardTracker
                ? await this.hub.rewardTracker.resolveSourceByPubkey(String(r.validator_pubkey), Number(r.block_index))
                : null;
            if(!source){
                console.warn('StateAnchorPublisher: reward ' + r.reward_type + '/#' + r.round_number +
                             ' source unresolved for ' + String(r.validator_pubkey).substring(0, 12) + '... deferred to a later batch');
                continue;
            }
            rewardRows.push({ row: r, source: source });
        }

        // After source resolution, a round with no matches, no calls, and no
        // RESOLVABLE rewards has nothing to archive. The raw empty-check above
        // counts unresolvable rewards as pending, so without this an unstaked
        // single-validator hub (its own anchor-reward pubkey resolves to no
        // stake source) re-publishes an empty 0/0/0 archive to DOGE every cycle
        // (a live prod fee-burn finding). The unresolvable rows stay pending
        // (batch_seq NULL) for a later batch that can resolve them; recording is
        // deliberately unconditional (every hub holds identical rows for the
        // federation re-derivation invariant), so we suppress the empty PUBLISH,
        // not the record. Real federations are unaffected: a staked publisher's
        // rewards resolve, so rewardRows is non-empty whenever rewards are.
        if(matches.length === 0 && calls.length === 0 && rewardRows.length === 0){
            this._pendingMatches = 0;
            return 'none';
        }

        let archive  = await this._buildArchive(network, batchSeq, matches, cp.snapshot_block, calls, rewardRows);
        let json     = archive.json;
        let crc      = this._crc32Hex(json);
        let b64      = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
        let chunks   = this._splitChunks(b64);

        let canonical = this._archiveCanonical(cp, batchSeq, archive.count, crc, chunks.length);
        if(!this.identity) throw new Error('no validator identity: cannot sign archives');
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);

        // SIGNING/QUORUM set: resolved at the wrapper checkpoint's snapshot_block.
        // The block the published v1 declares on the wire is the block the indexer
        // (anchor.js) + full-parse recovery verify the wrapper signatures against
        // (oracle_publish @ snapshot_block). Resolving it at the current election
        // block instead would let signers present only in the current set
        // contribute signatures the indexer later drops, pushing validSigs below
        // quorum, marking the v1 invalid on-chain while the rows get dequeued
        // anyway (see the on-chain-validity gate in _publishArchive), permanently
        // losing settled cross-chain state. The election set above may differ
        // (liveness); the set that gates co-signature acceptance must not.
        // Resolve the SIGNING set as the full {pubkey, source, weight} snapshot via
        // _resolveCapabilitySet (the SAME set the indexer anchor.js + full-parse
        // recovery verify the wrapper signatures against, oracle_publish @
        // snapshot_block, source-keyed). Bare pubkeys would lose the staking weight
        // the stake-weighted gate needs, so the publisher's local quorum decision
        // must use this set, not _getActiveOraclePublishPubkeys.
        let signingSet     = await this._resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        // An UNRESOLVED (empty) signing set is not a quorum of one: defer the round,
        // exactly as the two publisher-attestation rounds already do (_runPublisherAttestationRound
        // / _runArchiveAttestationRound both abstain on snapCount === 0). The election gate
        // above fails closed on an empty set, but it reads a DIFFERENT resolver at a
        // DIFFERENT height (_getActiveOraclePublishPubkeys @ electionBlock vs
        // _resolveCapabilitySet @ cp.snapshot_block), so passing it does not imply
        // snapCount > 0. Without this the `snapCount <= 1` self-sign path below treats 0
        // as single-node: the leader signs an archive whose declared signing set it is
        // not a member of, publishes a v1 that the indexer (anchor.js) and full-parse
        // recovery both refuse (their quorum verifiers need at least one qualified
        // signer), and dequeues the settled cross_chain rows anyway - a live-vs-recovered
        // ledger fork. Returning 'none' leaves every row pending, so a later flush
        // re-archives them under a fresh batch seq once the set resolves.
        if(snapCount === 0){
            console.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (batch ' + batchSeq + '); deferring the archive ' +
                         'round rather than self-publishing an empty-set v1 (rows stay pending)');
            return 'none';
        }
        // STAKE_WEIGHTED_QUORUM: weighted (source-deduped) at/above activation, else
        // legacy 2f+1 count; keyed on the BTC snapshot_block so the hub flips on the
        // same anchor as anchor.js (`swq.isStakeWeightedQuorumActive(snapshotBlock, NETWORK)`).
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        // Seed the leader's own signature only if the leader is itself in the
        // signing set. A leader elected for liveness but absent from the
        // snapshot_block set must not inflate the local quorum with a signature
        // the indexer will drop on-chain.
        let signatures = new Map();
        if(snapCount <= 1 || signingPubkeys.includes(myPubkey)) signatures.set(myPubkey, mySig);

        // Full {pubkey, source, weight} set so _checkArchiveQuorum can tally
        // distinct-source stake (weight carries the source's stake when weighted).
        // Preserve the truncation flag so the weighted archive quorum (_checkArchiveQuorum
        // via meetsStakeThreshold) fails closed on an over-cap oracle_publish snapshot.
        let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
        if(signingSet.truncated === true) roundValidators.truncated = true;

        let round = {
            cp, batchSeq, crc, b64, chunks, canonical, quorum, weighted, signer, electionBlock,
            count:      archive.count,
            matchIds:   matches.map(m => ({ match_id: m.match_id, status: m.status })),
            callIds:    calls.map(c => ({ call_id: c.call_id, phase: c.phase, status: c.status })),
            rewardIds:  rewardRows.map(({row}) => ({ reward_type: String(row.reward_type), round_number: Number(row.round_number), validator_pubkey: String(row.validator_pubkey).toLowerCase() })),
            validators: roundValidators,
            signatures: signatures,
            done:       false,
            timer:      null
        };

        if(snapCount <= 1){                                                   // single-node: self-sign suffices
            // A held publish never archived anything, so the pending counter must NOT be
            // cleared: the rows really are still pending and the next flush re-checks.
            if((await this._publishArchive(round)) === 'intent_held') return 'intent_held';
            this._pendingMatches = 0;
            return 'published';
        }

        this._archiveRound = round;
        round.timer = setTimeout(() => {
            if(this._archiveRound === round && !round.done){
                console.warn('StateAnchorPublisher: archive round (batch ' + batchSeq + ') timed out at ' +
                             round.signatures.size + '/' + quorum + ' sigs; retrying next flush');
                this._archiveRound = null;
            }
        }, this.roundTimeoutMs);
        if(round.timer.unref) round.timer.unref();

        this.peerManager.broadcast(XANC_SIGN_REQ, {
            checkpoint: cp, batch_seq: batchSeq, match_count: archive.count,
            batch_crc32: crc, total_chunks: chunks.length, archive_b64: b64,
            election_block: (Number.isFinite(electionBlock) ? electionBlock : 0),
            sig_pubkey: myPubkey, sig: mySig
        });
        await this._checkArchiveQuorum();
        return 'round_started';
    }

    // Content-anchored election key: deterministic + identical on every hub
    // (both fields come from quorum-agreed state) and STABLE while the batch is
    // stalled, so the failover ladder has a fixed anchor to climb against.
    // Unlike the old current-block key, which re-elected fresh every block (and
    // on a static regtest tip elected the SAME leader forever).
    _archiveElectionKey(cp, batchSeq){
        return 'XANCV1|' + cp.chain + '|' + cp.network + '|' + String(cp.checkpoint_seq) + '|' + String(batchSeq);
    }

    // Failover-ladder check shared by leader election and follower verification:
    // rank 0 may publish immediately; each further rank unlocks after another
    // ANCHOR_ELECTION_TOLERANCE_BLOCKS past the anchor point. Concurrent
    // unlocked publishers build byte-identical archives (both verify against
    // the same quorum-agreed rows), so a race is duplicate-tx waste, not a
    // divergence hazard.
    _rankUnlocked(order, pubkey, sinceBlocks){
        let rank = order.indexOf(String(pubkey || '').toLowerCase());
        if(rank < 0) return false;
        if(rank === 0) return true;
        let unlocked = Number.isFinite(sinceBlocks) ? Math.floor(Math.max(0, sinceBlocks) / this.electionToleranceBlocks) : 0;
        return rank <= unlocked;
    }

    // Resolve the qualifying set for (capability, block). Primary source is
    // CapabilitySnapshot.getSnapshot (deterministic from on-chain BTC stakes,
    // identical on EVERY hub), so the archive builder (leader) and the archive
    // verifier (followers) agree regardless of which hub led past rounds (the
    // local capability_snapshots table only holds rows a hub persisted while
    // leading, so it can't be the shared source). Falls back to the local
    // table for seeded/regtest stacks with no live BTC resolution.
    async _resolveCapabilitySet(capability, block, network){
        // Derive the weighted-vs-count set for the RECORD's network (callers
        // pass resolveQuorumNetwork(record, this.network) / the archive network),
        // matching the round/verify gate that judges the resulting set. On a scoped
        // hub this equals this.network (a no-op); on an unscoped or cross-network hub
        // the gate would otherwise say weighted while the set resolved as count,
        // failing the stake tally closed. Falls back to this.network when none passed.
        let net = (network != null) ? network : this.network;
        // Source-keyed at/above STAKE_WEIGHTED_QUORUM so the archived snapshot rows
        // carry the staking source recovery needs to dedupe weight; legacy set
        // below it (source=''). amount carries the source's weight when weighted.
        let weighted = swq.isStakeWeightedQuorumActive(Number(block), net);
        // Gate on snapshot PRESENCE, not non-emptiness, matching the three sibling
        // resolvers (CrossChainDexEngine/CrossChainCallEngine/StateCheckpointEngine)
        // and the _coerceValidators contract: an actual array (even length 0) is a
        // legitimate snapshot; only a malformed shape yields null. Gating on
        // length > 0 conflated "legitimately empty at this block" with "indexer
        // unavailable" and routed the former into the per-hub-local table, so two
        // hubs could resolve different sets/N/quorum for the same (capability, block).
        // A throw from the snapshot call propagates (like the siblings) rather than
        // being swallowed into the divergent local-table fallback.
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, Number(block));
                if(snap && Array.isArray(snap.validators)){
                    let set = snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), amount: String(v.weight != null ? v.weight : '0'), source: String(v.source != null ? v.source : '') }));
                    // Carry the truncation flag so the weighted quorum verdict fails closed
                    // on an over-cap snapshot (SWQ-TRUNC parity: a truncated set under-counts
                    // S, so a stake-evicted minority could otherwise clear the 2/3 bar).
                    if(snap.truncated === true) set.truncated = true;
                    return set;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, Number(block));
                if(snap && Array.isArray(snap.validators))
                    return snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), amount: String(v.amount != null ? v.amount : '0'), source: '' }));
            }
        }
        // Local-table fallback is gated to seeded/regtest stacks with no live BTC
        // resolution, matching the sibling resolvers
        // (StateCheckpointEngine/CrossChainCallEngine/CrossChainDexEngine, which seed
        // only when regtest). The local capability_snapshots table holds only rows a
        // hub persisted while leading, so it is NOT the shared source: on mainnet/
        // testnet a null snapshot means THIS hub's indexer is down/misconfigured
        // (CapabilitySnapshot returns null on any fetch/auth/echo failure), and
        // resolving from local rows while healthy peers resolve the on-chain snapshot
        // forks the set bytes for the same (capability, block). Fail closed off
        // regtest so a degraded round stalls (archive verification catches it) rather
        // than building a divergent archive.
        if(this.network !== 'regtest'){
            throw new Error('StateAnchorPublisher: cannot resolve capability set for (' +
                String(capability) + ', ' + Number(block) + '): deterministic snapshot unavailable ' +
                'and the local capability_snapshots table is not a valid shared source off regtest ' +
                '(indexer down/misconfigured); failing closed rather than building a divergent archive');
        }
        let rows = await this.db.doQuery(
            "SELECT signing_pubkey, amount, source FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC",
            [Number(block), String(capability)]);
        return (rows || []).map(r => ({ pubkey: String(r.signing_pubkey).toLowerCase(), amount: String(r.amount), source: String(r.source != null ? r.source : '') }));
    }

    // Archive JSON with fixed key order (crc32-bearing bytes; see MATCH_KEYS).
    // capability_snapshots makes recovery self-contained: cross_chain rows for
    // every match's snapshot_block (to re-verify match signatures) PLUS the
    // oracle_publish rows at the wrapper checkpoint's snapshot_block (to
    // re-verify the v1 anchor's own signatures). Recovery additionally
    // cross-checks archived pubkeys against on-chain BTC stakes; archived
    // sets are a convenience, the chain remains the root of trust.
    async _buildArchive(network, batchSeq, matches, wrapperSnapshotBlock, calls, rewards){
        calls   = calls   || [];
        rewards = rewards || [];
        let wants = matches.map(m => ({ block: Number(m.snapshot_block), capability: 'cross_chain' }))
            .concat(calls.map(c => ({ block: Number(c.snapshot_block), capability: 'cross_chain' })))
            // oracle_publish set at each reward's earn block; verifiers (and
            // recovery) check the rewarded pubkey was an eligible publisher.
            .concat(rewards.map(({row}) => ({ block: Number(row.block_index), capability: 'oracle_publish' })));
        if(wrapperSnapshotBlock != null)
            wants.push({ block: Number(wrapperSnapshotBlock), capability: 'oracle_publish' });
        let seen = new Set(), snaps = [];
        for(let w of wants.sort((a, b) => a.block - b.block || (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))){
            let key = w.block + '|' + w.capability;
            if(seen.has(key)) continue;
            seen.add(key);
            let set = await this._resolveCapabilitySet(w.capability, w.block, network);
            // Total order: pubkey then source. Equal pubkeys are legitimately
            // possible in weighted snapshots (one row per (source, pubkey), a key
            // may be delegated by multiple sources); a two-branch comparator that
            // returns 1 for both orderings of an equal pair is inconsistent and
            // leaves relative order engine-defined, which can diverge the crc32
            // archive bytes that follower co-signers verify byte-for-byte.
            for(let v of set.slice().sort((a, b) => a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)))
                snaps.push({ snapshot_block: w.block, capability: w.capability,
                             signing_pubkey: v.pubkey, amount: v.amount,
                             source: String(v.source != null ? v.source : '') });
        }
        // `calls` and `rewards` are additive to the v1 archive shape: recovery
        // treats a missing key as an empty list, so older on-chain archives stay
        // parseable.
        let obj = {
            v: 1,
            network: network,
            batch_seq: batchSeq,
            matches: matches.map(m => StateAnchorPublisher.serializeMatch(m)),
            calls: calls.map(c => StateAnchorPublisher.serializeCall(c)),
            rewards: rewards.map(({row, source}) => StateAnchorPublisher.serializeReward(row, source)),
            capability_snapshots: snaps
        };
        return { json: JSON.stringify(obj), count: matches.length };
    }

    // Fixed-key-order match record (shared with the follower verifier + recovery).
    static serializeMatch(m){
        let out = {};
        for(let k of MATCH_KEYS){
            let v = m[k];
            if(k === 'id' || k === 'a_action_index' || k === 'b_action_index' || k === 'snapshot_block' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'a_ownership' || k === 'b_ownership')
                out[k] = Number(v) ? 1 : 0;
            else if(k === 'a_tick' || k === 'b_tick')
                out[k] = (v == null) ? null : String(v);
            else if(k === 'a_payout_legs' || k === 'b_payout_legs'){
                // Omit-when-null: legs only exist at/above the CROSS_CHAIN_ROYALTY flag-day
                // (create-side deny below it), so legs-less archives stay byte-identical to
                // those built by pre-royalty hubs and recovery tolerates both shapes.
                if(v != null) out[k] = String(v);
            }
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    // Fixed-key-order XCALL relay record (shared with the follower verifier +
    // recovery). result_status / return_payload_b64 are null on dispatch rows.
    static serializeCall(c){
        let out = {};
        for(let k of CALL_KEYS){
            let v = c[k];
            if(k === 'id' || k === 'snapshot_block' || k === 'source_action_index' || k === 'source_contract_index' ||
               k === 'target_contract_index' || k === 'gas_limit' || k === 'cross_hops' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'result_status' || k === 'return_payload_b64')
                out[k] = (v == null) ? null : String(v);
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    }

    // Fixed-key-order anchor-publish reward record (shared with the follower
    // verifier + recovery). `source` is the earn-time staking address pinned by
    // the archive builder. Recovery restores rewards into the BTC indexer DB
    // BEFORE the reindex, so it cannot resolve sources itself, and a later
    // re-stake of the pubkey from a different address must not move the credit.
    static serializeReward(r, source){
        return {
            validator_pubkey: String(r.validator_pubkey).toLowerCase(),
            source:           String(source),
            round_number:     Number(r.round_number),
            reward_type:      String(r.reward_type),
            amount:           String(r.amount),
            block_index:      Number(r.block_index)
        };
    }

    // v1 archive canonical = the RAW v0 checkpoint content + the batch extension, then
    // (at/above the EQUIV flag-day) wrapped ONCE in the uniform header. The v1 ROUND_ID
    // appends `batch_seq` to the v0 round id so the v0 (per-block) and v1 (archive)
    // canonicals (which legitimately share checkpoint_seq) get DISTINCT equivocation
    // keys; otherwise an honest validator that signs both is falsely slashable (R-4 fix).
    // Nests _rawCanonicalCheckpoint (not canonicalCheckpoint) so the header lands outside.
    _archiveCanonical(cp, batchSeq, count, crc, totalChunks){
        let raw = StateCheckpointEngine._rawCanonicalCheckpoint(cp) + '|' +
                  String(batchSeq) + '|' + String(count) + '|' + crc + '|' + String(totalChunks);
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq + '|' + batchSeq, 0, raw);
        return raw;
    }

    _splitChunks(b64){
        let chunks = [];
        for(let i = 0; i < b64.length; i += this.chunkMaxBytes) chunks.push(b64.slice(i, i + this.chunkMaxBytes));
        return chunks.length ? chunks : [''];
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XANC_SIGN_REQ:  this._handleSignReq(envelope).catch(e => console.error('StateAnchorPublisher: SIGN_REQ error: ' + (e && e.message))); break;
            case XANC_SIGN:      this._handleSign(envelope).catch(e => console.error('StateAnchorPublisher: SIGN error: ' + (e && e.message)));        break;
            case XANC_FINALIZED: this._handleFinalized(envelope).catch(e => console.error('StateAnchorPublisher: FINALIZED error: ' + (e && e.message))); break;
            case XANC_V0_DONE:   this._handleV0Done(envelope).catch(e => console.error('StateAnchorPublisher: V0_DONE error: ' + (e && e.message)));     break;
            case XANCPUB_SIGN_REQ: this._handleAttestSignReq(envelope).catch(e => console.error('StateAnchorPublisher: XANCPUB_SIGN_REQ error: ' + (e && e.message))); break;
            case XANCPUB_SIGN:     this._handleAttestSign(envelope).catch(e => console.error('StateAnchorPublisher: XANCPUB_SIGN error: ' + (e && e.message)));         break;
            case XANCARCHPUB_SIGN_REQ: this._handleArchiveAttestSignReq(envelope).catch(e => console.error('StateAnchorPublisher: XANCARCHPUB_SIGN_REQ error: ' + (e && e.message))); break;
            case XANCARCHPUB_SIGN:     this._handleArchiveAttestSign(envelope).catch(e => console.error('StateAnchorPublisher: XANCARCHPUB_SIGN error: ' + (e && e.message)));         break;
            case XANCREWARD:           this._handleRewardAttestation(envelope).catch(e => console.error('StateAnchorPublisher: XANCREWARD error: ' + (e && e.message)));               break;
        }
    }

    // Peer back-fill for a published v0 anchor. Gated on membership + signature +
    // the sender being the rank-unlocked ELECTED v0 publisher for the referenced
    // checkpoint (see the election re-derivation below); a non-elected member can
    // no longer suppress the anchor or mirror itself the reward. The residual
    // (a Byzantine elected publisher announcing a fake txid) needs on-chain txid
    // verification. First writer wins (IS NULL guard).
    async _handleV0Done(envelope){
        let d = envelope.data;
        if(!d || !d.chain || !d.txid) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set: d.sig_pubkey is self-asserted and the sig is
        // verified against it, so membership in the oracle_publish set is the ONLY
        // thing tying this announcement to a federation member. An empty set (startup /
        // registry hiccup) must reject, not admit anyone -- otherwise a forged V0_DONE
        // stamps a bogus anchor_txid (suppressing the real anchor) and mirrors rewards.
        if(pubkeys.length === 0 || !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this._v0DoneCanonical(d, String(d.txid)), String(d.sig || ''), sender)) return;
        // XANC-V0DONE-SUPPRESS-1 / XANC-REWARD-THEFT-1: membership + signature alone let ANY
        // oracle_publish member self-assert an anchor for a checkpoint it never published,
        // stamping a bogus anchor_txid (suppressing the real anchor fleet-wide via the
        // `anchor_txid IS NULL` selector) and mirroring itself the reward. Re-run the SAME v0
        // publisher election the real publisher ran (_publishPendingCheckpoints): resolve
        // oracle_publish at THIS checkpoint's snapshot_block and require the sender to be
        // rank-unlocked on the failover ladder. snapshot_block is read from our own
        // quorum-agreed checkpoint row (not the wire), so this needs NO signed-canonical
        // change. It rejects any NON-elected member; a Byzantine ELECTED publisher (a far
        // smaller surface, fully closed only by on-chain txid verification - open item) can
        // still self-suppress its own election share. Rejecting a V0_DONE only ever risks a
        // redundant re-anchor (benign, the direction the code already tolerates), never a
        // fork, so using the receiver's own BTC-tip view for rank-unlock is safe here (same
        // pattern as _handleSignReq).
        let ckptRows = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
            [String(d.chain), String(d.network), Number(d.block_index), Number(d.checkpoint_seq)]);
        if(!ckptRows || ckptRows.length === 0) return;   // no local copy of the referenced checkpoint: cannot vet the election
        let electionSet = await this._getActiveOraclePublishPubkeys(Number(ckptRows[0].snapshot_block));
        if(electionSet.length === 0) return;             // fail closed: unresolved election set
        {
            // Run the ladder check for EVERY set size. A size-1 set previously
            // skipped it, so any CURRENT oracle_publish member (even one that
            // joined after snapshot_block) could stamp the sole elected
            // publisher's on-chain anchor with a V0_DONE naming itself and,
            // pre-ANCHOR_REWARD flag-day, capture the mirrored reward.
            let order = StateAnchorPublisher.hashOrder(
                this._v0ElectionKey({ chain: d.chain, network: d.network, checkpoint_seq: d.checkpoint_seq, snapshot_block: Number(ckptRows[0].snapshot_block) }),
                electionSet);
            let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - Number(ckptRows[0].snapshot_block) : null;
            if(!this._rankUnlocked(order, sender, since)) return;   // sender is not a rank-unlocked elected publisher
        }
        // XANC-V0DONE-SUPPRESS-1 / XANC-ELECTED-FORGE-1 (v0 half): the election gate
        // above proves the SENDER is an elected v0 publisher, NOT that it ever
        // published this anchor. A Byzantine ELECTED publisher can still announce a
        // phantom/never-mined txid, stamping a bogus anchor_txid (suppressing the real
        // anchor via the `anchor_txid IS NULL` selector) and mirroring itself the
        // reward. Confirm the anchor is really on DOGE at >= XCHAIN_CONFIRMATIONS_DOGE
        // depth by asking OUR OWN DOGE indexer for the DECODED anchor_actions row for
        // THIS checkpoint (payload hashes must byte-match our own copy). ABSTAIN (skip
        // stamp+reward, the benign redundant-re-anchor direction this handler already
        // tolerates) when the DOGE indexer is unwired/unreachable or the anchor is
        // absent/shallow; REJECT on a decoded-invalid status or a hash mismatch. The
        // failover ladder unlocks at ~electionToleranceBlocks BTC blocks per rank
        // (hours), far slower than the ~60-conf DOGE window, so waiting for depth does
        // not open a practical double-anchor race.
        //
        // d.txid is bound into the signed _v0DoneCanonical, so binding it here closes
        // the v0 half of XANC-ELECTED-FORGE-1: an ELECTED publisher announcing a
        // never-mined txid, or pointing at a real anchor for a DIFFERENT checkpoint,
        // no longer stamps (the phantom stamp is what suppresses the real anchor via
        // the `anchor_txid IS NULL` selector).
        let vOnChain = await this._verifyAnchorOnChain(ckptRows[0], { txid: String(d.txid), rejectVersions: [1, 2, 6] });
        if(vOnChain !== 'verified'){
            // NOT a rejection for the not-yet-buried verdicts. The publisher announces at
            // 0 confirmations (the broadcast returns a mempool txid), so 'absent' /
            // 'shallow' is the NORMAL first answer for a perfectly honest anchor, and
            // 'unreachable' / 'no-indexer' / 'no-txid-support' are local-wiring faults
            // that clear on their own. Dropping those was what left anchor_txid NULL
            // fleet-wide. Queue for re-verification instead; only a positively-detected
            // forge ('rejected:*') is discarded here. The queued entry is re-verified in
            // full before it can stamp anything, so queuing grants no authority.
            if(String(vOnChain).startsWith('rejected')){
                console.warn('StateAnchorPublisher: V0_DONE for ' + d.chain + '/' + d.network + ' @ ' +
                             d.block_index + '/' + d.checkpoint_seq + ' REJECTED on-chain (' + vOnChain +
                             '); skipping stamp + reward');
                return;
            }
            this._deferV0Done(d, sender, vOnChain);
            return;
        }
        await this._applyV0Done(d, sender, ckptRows[0]);
    }

    // Queue an authenticated-but-not-yet-buried V0_DONE for re-verification. Keyed on
    // the announcement's full identity INCLUDING the txid, so two competing txids for
    // one checkpoint are tracked separately and whichever actually confirms wins.
    _deferV0Done(d, sender, reason){
        let key = [String(d.chain), String(d.network), Number(d.block_index),
                   Number(d.checkpoint_seq), String(d.txid)].join('|');
        if(this._deferredV0Done.has(key)) return;
        // Bounded: drop the OLDEST entry rather than the new one (Map preserves
        // insertion order), so a flood cannot pin the queue on stale announcements.
        if(this._deferredV0Done.size >= this.announceQueueMax){
            let oldest = this._deferredV0Done.keys().next().value;
            this._deferredV0Done.delete(oldest);
            console.warn('StateAnchorPublisher: deferred V0_DONE queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        this._deferredV0Done.set(key, { d: d, sender: sender, at: Date.now() });
        console.log('StateAnchorPublisher: V0_DONE for ' + d.chain + '/' + d.network + ' @ ' +
                    d.block_index + '/' + d.checkpoint_seq + ' not yet buried (' + reason +
                    '); queued for re-verification (' + this._deferredV0Done.size + ' pending)');
    }

    // Re-verify queued V0_DONE announcements and stamp the ones that have since been
    // buried. Runs on its own timer (announceRetryMs) and at the head of every flush.
    // The announcement's authenticity (membership, signature over the txid-bearing
    // canonical, publisher election at the checkpoint's immutable snapshot_block) was
    // settled at receipt and cannot change; what is re-checked is the ONE thing that
    // does change, namely whether the anchor is really on DOGE at depth.
    async _drainDeferredV0Done(){
        if(this._deferredV0Done.size === 0) return;
        for(let [key, entry] of [...this._deferredV0Done]){
            let d = entry.d;
            if(Date.now() - entry.at > this.announceRetryTtlMs){
                this._deferredV0Done.delete(key);
                console.warn('StateAnchorPublisher: deferred V0_DONE ' + key + ' expired after ' +
                             this.announceRetryTtlMs + 'ms without confirming; dropping so the failover ' +
                             'ladder can re-anchor if the checkpoint is still pending');
                continue;
            }
            try {
                let rows = await this.db.doQuery(
                    'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
                    [String(d.chain), String(d.network), Number(d.block_index), Number(d.checkpoint_seq)]);
                if(!rows || rows.length === 0) continue;              // checkpoint gone (reorg): let the TTL clear it
                if(rows[0].anchor_txid != null){                      // already stamped by our own publish or another announcement
                    this._deferredV0Done.delete(key);
                    continue;
                }
                let v = await this._verifyAnchorOnChain(rows[0], { txid: String(d.txid), rejectVersions: [1, 2, 6] });
                if(v === 'verified'){
                    this._deferredV0Done.delete(key);
                    await this._applyV0Done(d, entry.sender, rows[0]);
                    console.log('StateAnchorPublisher: deferred V0_DONE ' + key + ' confirmed on DOGE; stamped');
                } else if(String(v).startsWith('rejected')){
                    this._deferredV0Done.delete(key);
                    console.warn('StateAnchorPublisher: deferred V0_DONE ' + key + ' REJECTED on re-verification (' + v + '); dropped');
                }
            } catch(e){
                console.warn('StateAnchorPublisher: deferred V0_DONE ' + key + ' re-verification error: ' + (e && e.message));
            }
        }
    }

    // Apply a fully-verified V0_DONE: stamp anchor_txid and mirror the reward.
    // Shared by the immediate receipt path and the deferred re-verification drain, so
    // an announcement that arrives at 0 confirmations lands EXACTLY the same rows as
    // one that arrives already buried.
    async _applyV0Done(d, sender, ckptRow){
        // Key the stamp on checkpoint_seq exactly as the publisher's own stamp does:
        // checkpoint_seq is part of the signed _v0DoneCanonical, so binding it here
        // stops one V0_DONE from marking a DIFFERENT (or multiple) seq row(s) at the
        // same height.
        await this.db.doQuery(
            'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL',
            [String(d.txid), String(d.chain), String(d.network), Number(d.block_index), Number(d.checkpoint_seq)]);
        // Mirror the publisher's anchor reward locally (the caller has already
        // signature-verified the sender and confirmed the anchor on-chain) so every
        // hub holds the same reward rows and any of them can archive/verify the
        // rewards section. The snapshot_block comes from OUR copy of the checkpoint
        // row (quorum-agreed state, identical on every hub).
        // Mirror against the EXACT announced+verified checkpoint (ckptRow, keyed on
        // d.checkpoint_seq above), NOT the latest seq at this height. When a reorg leaves
        // more than one checkpoint_seq at the same block_index with different
        // snapshot_blocks, the latest-seq row's snapshot_block diverges from the seq the
        // publisher actually anchored + recorded its reward under, forking peer reward rows
        // from the publisher's (a live-vs-recovered COLLECT-ledger fork).
        let cps = [{ snapshot_block: ckptRow.snapshot_block }];
        // At/above the anchor-reward flag-day the per-chain reward is indexer-
        // DERIVED from the on-chain v4/v5 attestation. V0_DONE does not say (and
        // its signed canonical does not bind) WHICH payload version landed, so a
        // mirror here could mint a reward for a degraded legacy v0/v3 fallback
        // that no live indexer credits (a stranded archive-only credit; the
        // live-vs-recovered fork). Skip the mirror at/above the flag-day: the
        // attested publisher records its own row (the archive transport), and
        // live + recovering indexers both derive the credit from the on-chain
        // attestation. Below the flag-day the mirror remains the only transport.
        if(cps && cps.length > 0 && !ar.isAnchorRewardActive(Number(cps[0].snapshot_block), String(d.network)))
            this._recordReward('anchor_' + String(d.chain), Number(d.checkpoint_seq), sender, Number(cps[0].snapshot_block), String(d.network));
    }

    _v0DoneCanonical(row, txid){
        return 'XANCV0DONE|' + row.chain + '|' + row.network + '|' + String(row.block_index) + '|' +
               String(row.checkpoint_seq) + '|' + String(txid || '');
    }

    // On-chain ANCHOR verification (XANC-ELECTED-FORGE-1 / XANC-V0DONE-SUPPRESS-1
    // residual). A peer's V0_DONE / FINALIZED announcement is authenticated (signed
    // by an elected sender) but its txid is SELF-ASSERTED: an elected-yet-Byzantine
    // publisher can announce a checkpoint it never actually anchored on DOGE,
    // suppressing the real anchor (bogus anchor_txid stamp) or minting itself a
    // reward. Confirm the anchor really landed by asking OUR OWN DOGE indexer for
    // the DECODED anchor_actions row for this checkpoint. `cp` is a raw
    // state_checkpoints row (our own quorum-agreed copy); its hashes are the bind.
    //
    // Returns the string 'verified' ONLY when the on-chain row exists, is not a
    // decoded-invalid, is buried >= XCHAIN_CONFIRMATIONS_DOGE deep, and its payload
    // hashes byte-match our checkpoint. Every other outcome returns a short reason
    // the caller treats as ABSTAIN (skip stamp+reward): 'no-indexer' (a hub with no
    // DOGE indexer wired fails closed, i.e. skips the receiver stamp+reward; wire
    // DOGE_INDEXER_URL fleet-wide before deploy), 'unreachable',
    // 'absent', 'shallow' are the benign redundant-re-anchor direction the receiver
    // paths already tolerate; 'rejected:status' / 'rejected:mismatch' /
    // 'rejected:txid' / 'rejected:version' are a positively-detected forge.
    //
    // `expect` BINDS the announcement to a specific on-chain transaction:
    //   expect.txid    - the txid the peer announced (signed into the V0_DONE /
    //                    FINALIZED canonical), so an elected-but-Byzantine publisher
    //                    cannot point at a real-but-different anchor, nor at a
    //                    never-mined one (XANC-ELECTED-FORGE-1).
    //   expect.version - narrows to a specific ANCHOR version (the archive gate binds
    //                    the v1 head), since one checkpoint_seq carries both the v0/v3
    //                    checkpoint anchor and the v1 archive anchor.
    //   expect.rejectVersions - a set of ANCHOR versions to REJECT when no single
    //                    exact version is expected (the V0_DONE checkpoint path passes
    //                    {1,2,6}, the archive-carrying set ARCHIVE_VERSIONS names in
    //                    _findExistingCheckpointAnchor, so an archive anchor cannot pose
    //                    as a checkpoint anchor).
    // Without `expect` this only proves "this checkpoint is anchored at depth".
    //
    // FAIL CLOSED against an un-upgraded indexer: one that predates the txid filter
    // silently ignores the param and returns no `txid`, so a caller that asked to bind
    // a txid gets 'no-txid-support' (ABSTAIN) rather than a false 'verified'. Roll the
    // DOGE indexers before the hubs.
    async _verifyAnchorOnChain(cp, expect){
        if(!cp) return 'no-checkpoint';
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url) return 'no-indexer';
        let want = expect || {};
        let wantTxid = want.txid ? String(want.txid).toLowerCase() : null;
        let res;
        try {
            let params = {
                chain: String(cp.chain), network: String(cp.network),
                block_index: Number(cp.block_index), checkpoint_seq: Number(cp.checkpoint_seq)
            };
            if(wantTxid)                 params.txid    = wantTxid;
            if(want.version != null)     params.version = Number(want.version);
            res = await this._indexerCall('DOGE', 'getanchoraction', params);
        } catch(e){
            console.warn('StateAnchorPublisher: getanchoraction unreachable for ' + cp.chain + '/' + cp.network +
                         ' @ ' + cp.block_index + '/' + cp.checkpoint_seq + ': ' + (e && e.message));
            return 'unreachable';
        }
        if(!res || !res.exists){
            // The filtered lookup found nothing. `checkpoint_anchored` says whether ANY
            // anchor exists for this checkpoint: if one does, the announced txid is a
            // forge (the checkpoint is anchored, just not by that tx). If none does, the
            // checkpoint simply is not anchored yet, which is the benign direction.
            if(wantTxid && res && res.checkpoint_anchored) return 'rejected:txid';
            return 'absent';
        }
        if(/^invalid/i.test(String(res.status || ''))) return 'rejected:status';
        if(!(Number(res.confirmations) >= this.dogeConfirmations)) return 'shallow';
        // Re-check the binding client-side. The indexer already filtered, so this only
        // fires against an indexer that ignored the filter (pre-upgrade) or answered
        // inconsistently; either way we must not trust an unbound row.
        if(wantTxid){
            if(!res.txid) return 'no-txid-support';
            if(String(res.txid).toLowerCase() !== wantTxid) return 'rejected:txid';
        }
        if(want.version != null && Number(res.version) !== Number(want.version)) return 'rejected:version';
        // Reject a disallowed version even when no single exact version is
        // expected. The V0_DONE path accepts any CHECKPOINT-anchor version
        // ({0,3,4,5}) but must not accept an ARCHIVE anchor ({1,2,6}): one
        // checkpoint_seq carries both, and the 4-core-hash byte-match below
        // passes for a v1/v6 archive whose wrapper is this same checkpoint, so
        // without this a Byzantine v0 publisher could name a confirmed v1/v6
        // archive txid as proof of a v0 anchor (stamping the row fleet-wide and
        // mirroring a reward it never earned).
        if(Array.isArray(want.rejectVersions) &&
           want.rejectVersions.map(Number).includes(Number(res.version))) return 'rejected:version';
        // Byte-match the decoded on-chain payload against our own checkpoint. The
        // four core hashes are present on every checkpoint version; state_root and
        // block_merkle_root are compared only when the on-chain anchor is a
        // root-bearing version (v3/v5), matching the payload the publisher signed.
        if(!this._anchorHashEq(res.block_hash,    cp.block_hash)    ||
           !this._anchorHashEq(res.ledger_hash,   cp.ledger_hash)   ||
           !this._anchorHashEq(res.actions_hash,  cp.actions_hash)  ||
           !this._anchorHashEq(res.contract_hash, cp.contract_hash)) return 'rejected:mismatch';
        if(Number(res.version) === 3 || Number(res.version) === 5){
            if(!this._anchorHashEq(res.state_root,        cp.state_root) ||
               !this._anchorHashEq(res.block_merkle_root, cp.block_merkle_root)) return 'rejected:mismatch';
        }
        return 'verified';
    }

    // Null-safe hex-hash equality for the on-chain payload byte-match. Both
    // null/empty compare equal (a version that legitimately carries no such hash);
    // a one-sided null is a mismatch. Case-insensitive: hex hashes may differ only
    // in case between the decoder's serialization and ours.
    _anchorHashEq(a, b){
        let na = (a == null || a === '') ? null : String(a).toLowerCase();
        let nb = (b == null || b === '') ? null : String(b).toLowerCase();
        return na === nb;
    }

    // JSON-RPC to a per-coin indexer (byte-identical to the ReorgHandler /
    // CrossChainCallEngine helper). The hub attaches its x-api-key; getanchoraction
    // is a FEDERATION_READ_METHOD on the indexer.
    async _indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    // Follower: co-sign ONLY an archive that byte-matches our own DB state.
    async _handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !d.checkpoint) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;

        let cp = d.checkpoint;
        // The publisher is elected by the CURRENT BTC block (not the checkpoint's
        // possibly hours-old snapshot_block). The REQ carries its election block;
        // we verify the SENDER's rank against it, bounded to our own view of the
        // BTC tip (anti-spam; the security property is the DB byte-match below).
        let electionBlock = Number(d.election_block);
        if(!Number.isFinite(electionBlock)) return;
        let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(Number.isFinite(myBtc) && Math.abs(myBtc - electionBlock) > this.electionToleranceBlocks) return;
        let electionPubkeys = await this._getActiveOraclePublishPubkeys(electionBlock);
        // Fail CLOSED on an unresolved election set, the same way the LEADER does
        // at the identical condition (_startArchiveRound: "empty oracle_publish set,
        // deferring round (fail closed)") and the same way _handleFinalized and
        // _handleV0Done already do. The old fall-through skipped BOTH the rank ladder and
        // every membership tie to the federation, so during an unresolved window a
        // NON-MEMBER could solicit co-signatures from the historical wrapper set and
        // assemble a duplicate v1 under a batch_seq of its own choosing: honest CONTENT
        // (the DB byte-match still holds) but real DOGE burned twice, and two archives
        // able to claim one seq, which is what the ladder exists to serialize.
        // The liveness the asymmetry protected is nearly nil: the snapshot_block
        // signing-set gate a few lines below already returns on an empty answer from THIS
        // SAME resolver, so an indexer outage that empties the election set almost always
        // empties the signing set too and this hub was not going to co-sign either way.
        // The residual case (electionBlock unresolvable while snapshot_block is cached)
        // costs one co-signature on one round, which the round timeout re-runs.
        if(electionPubkeys.length === 0) return;
        {
            // Same content-anchored key + failover ladder the leader used.
            // Accept any sender whose rank has unlocked, not just rank 0, or a
            // signer-less rank-0 hub stalls archiving federation-wide.
            // Runs for a single-member set too (previously skipped), so the
            // sole elected leader cannot be impersonated by a non-member.
            let order = StateAnchorPublisher.hashOrder(this._archiveElectionKey(cp, Number(d.batch_seq)), electionPubkeys);
            let since = electionBlock - Number(cp.snapshot_block);
            if(!this._rankUnlocked(order, sender, since)) return;            // not unlocked on the failover ladder
        }
        // AUTHENTICATE THE PROPOSER BEFORE BINDING ANYTHING TO IT. Everything above
        // this line is derived from the wire: `sender` is the application-level
        // d.sig_pubkey, NOT the envelope key PeerManager authenticated (that one binds
        // only the relayer), and the rank ladder is keyed on the wire checkpoint, so any
        // federation member can put another member's pubkey here and unlock a rank by
        // choosing cp/batch_seq. The proposer's signature over the archive canonical is
        // the one thing only the real leader can produce, so it gates the record: without
        // it, a member could poison _observedArchiveCheckpoints for a future batch_seq
        // (first observation wins, so the genuine round then resolves no local row and
        // never co-signs) or flood past _observedArchiveLeadersCap and evict the
        // in-flight entries every legitimate XANC_FINALIZED is authenticated against.
        // The canonical is built from wire fields already in hand, so verifying here
        // costs no extra state and no liveness.
        let canonical = this._archiveCanonical(cp, Number(d.batch_seq), Number(d.match_count),
                                               String(d.batch_crc32), Number(d.total_chunks));
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;
        // The sender has validated as the (rank-unlocked) elected archive leader
        // for this batch_seq at election_block. Bind it locally BEFORE the
        // snapshot-set co-sign check below, so an election-set member that will
        // NOT co-sign (present only at election_block, not at snapshot_block) can
        // still authenticate this leader's later XANC_FINALIZED and back-fill.
        // Deliberately still ahead of the local state_checkpoints byte-match below: a
        // hub lagging on the wrapper checkpoint must keep recording the leader, or it
        // abstains from the back-fill and the rows re-archive under a fresh seq.
        if(electionPubkeys.includes(sender))
            this._recordObservedArchiveLeader(Number(d.batch_seq), sender, cp);
        // MY co-sign eligibility, by contrast, is gated on the snapshot_block
        // SIGNING set: the indexer + recovery only count a wrapper signature whose
        // signer holds oracle_publish AT snapshot_block, so a follower present only
        // in the current election set would contribute a signature that is dropped
        // on-chain and could drag an otherwise-valid archive below quorum.
        let signingPubkeys = await this._getActiveOraclePublishPubkeys(Number(cp.snapshot_block));
        if(!signingPubkeys.includes(myPubkey)) return;

        // 1. The checkpoint wrapper must equal OUR state_checkpoints row (latest
        // seq for the height; a reorg-superseded row never co-signs an archive).
        let local = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? ORDER BY checkpoint_seq DESC LIMIT 1',
            [cp.chain, cp.network, Number(cp.block_index)]);
        if(!local || local.length === 0) return;
        let mine = this._cpFromRow(local[0]);
        // Rootless compare, deliberately: _archiveCanonical nests
        // _rawCanonicalCheckpoint by construction and _cpFromRow omits the SPV root
        // fields, so this guard binds identity fields only. Pinning to
        // _rawCanonicalCheckpoint keeps it immune to the presence-gated root suffix.
        if(StateCheckpointEngine._rawCanonicalCheckpoint(mine) !== StateCheckpointEngine._rawCanonicalCheckpoint(cp)) return;

        // 2. The archive must decompress, CRC-match, and byte-match our own rows.
        let json;
        // Bounded decompress: the archive is attacker-supplied bytes decompressed
        // BEFORE any CRC/quorum check, so an unbounded gunzip is a gzip-bomb DoS.
        // Mirror the committed indexer cap (anchor.js / recovery.js, 16 MiB).
        try { json = zlib.gunzipSync(Buffer.from(String(d.archive_b64), 'base64url'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'); }
        catch(e){ return; }
        if(this._crc32Hex(json) !== String(d.batch_crc32)) return;
        let archive;
        try { archive = JSON.parse(json); } catch(e){ return; }
        if(!archive || !Array.isArray(archive.matches) || archive.matches.length !== Number(d.match_count)) return;
        // Wrapper snapshot_block from OUR OWN row (`mine`), never the archive body: it
        // decides which oracle_publish group the completeness check requires, and `mine`
        // is byte-matched to the wire cp above (snapshot_block rides _rawCanonicalCheckpoint).
        if(!(await this._verifyArchiveAgainstLocal(archive, Number(mine.snapshot_block)))){
            console.warn('StateAnchorPublisher: proposed archive (batch ' + d.batch_seq + ') diverges from our DB; NOT signing');
            return;
        }

        this.peerManager.broadcast(XANC_SIGN, {
            batch_seq: Number(d.batch_seq), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    // Every archived match's TERMS must byte-equal our own cross_chain_matches
    // row (every hub writes finalized matches, so the local DB is authoritative).
    // validator_signatures is EXCLUDED from the byte-comparison (each hub stores
    // its own collected sig set; membership/order differ per node) and instead
    // verified CRYPTOGRAPHICALLY: the archived sigs must reach 2f+1 of OUR OWN
    // resolved cross_chain set over the XMATCH canonical (strictly stronger than
    // comparing local copies). Capability sets must exactly equal our own
    // resolution (set equality, not subset, so a leader can neither inject a
    // fake validator nor omit a real one).
    //
    // `wrapperSnapshotBlock` is the archive wrapper checkpoint's snapshot_block (the
    // caller's own byte-matched row, never the archive body), needed because the
    // completeness check below has to know which oracle_publish group _buildArchive
    // was obliged to emit for the wrapper itself.
    async _verifyArchiveAgainstLocal(archive, wrapperSnapshotBlock){
        for(let am of archive.matches){
            let rows = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [am.match_id]);
            if(rows && rows.length > 0){
                let localTerms    = StateAnchorPublisher.serializeMatch(rows[0]);
                let archivedTerms = Object.assign({}, am);
                // id is per-hub bookkeeping (each hub assigns its own AUTO_INCREMENT
                // cursor); the leader archives ITS id as provenance only (ordering
                // is (snapshot_block, match_id)/(snapshot_block, call_id)), so
                // followers must not byte-compare it, like validator_signatures.
                delete localTerms.id;
                delete archivedTerms.id;
                delete localTerms.validator_signatures;
                delete archivedTerms.validator_signatures;
                if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                    console.warn("StateAnchorPublisher: archive match " + String(am.match_id).substring(0, 16) +
                                 "... TERMS differ from our row; local " + JSON.stringify(localTerms).substring(0, 120) +
                                 " vs archived " + JSON.stringify(archivedTerms).substring(0, 120));
                    return false;
                }
            } else {
                // A row we never wrote: it predates this hub joining the
                // federation (a late joiner has no copy of earlier history).
                // The cryptographic bar below (archived sigs reaching 2f+1 of
                // OUR OWN resolved cross_chain set at the row's snapshot_block)
                // is the same proof full-parse recovery accepts, so absence is
                // not divergence. A forged row cannot carry those signatures.
                console.log('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                            '... predates our local history; accepting on signature quorum alone');
            }

            let set  = await this._resolveCapabilitySet('cross_chain', Number(am.snapshot_block), resolveQuorumNetwork(am, this.network));
            let sigs = this._parseSigs(am.validator_signatures);
            if(!this._quorumVerified(this._matchCanonical(am), sigs, set, swq.isStakeWeightedQuorumActive(Number(am.snapshot_block), resolveQuorumNetwork(am, this.network)))){   // RECORD network
                console.warn('StateAnchorPublisher: archive match ' + String(am.match_id).substring(0, 16) +
                             '... fails signature quorum against the cross_chain set at block ' + am.snapshot_block);
                return false;
            }
        }
        for(let ac of (archive.calls || [])){
            let rows = await this.db.doQuery(
                'SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [ac.call_id, ac.phase]);
            if(rows && rows.length > 0){
                let localTerms    = StateAnchorPublisher.serializeCall(rows[0]);
                let archivedTerms = Object.assign({}, ac);
                delete localTerms.id;                       // per-hub cursor; see the match loop
                delete archivedTerms.id;
                delete localTerms.validator_signatures;
                delete archivedTerms.validator_signatures;
                if(JSON.stringify(localTerms) !== JSON.stringify(archivedTerms)){
                    console.warn("StateAnchorPublisher: archive call " + String(ac.call_id).substring(0, 16) +
                                 "... (" + ac.phase + ") TERMS differ from our row; local " + JSON.stringify(localTerms).substring(0, 160) +
                                 " vs archived " + JSON.stringify(archivedTerms).substring(0, 160));
                    return false;
                }
            } else {
                console.log('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                            '... (' + ac.phase + ') predates our local history; accepting on signature quorum alone');
            }

            let set  = await this._resolveCapabilitySet('cross_chain', Number(ac.snapshot_block), resolveQuorumNetwork(ac, this.network));
            let sigs = this._parseSigs(ac.validator_signatures);
            if(!this._quorumVerified(this._callCanonical(ac), sigs, set, swq.isStakeWeightedQuorumActive(Number(ac.snapshot_block), resolveQuorumNetwork(ac, this.network)))){   // RECORD network
                console.warn('StateAnchorPublisher: archive call ' + String(ac.call_id).substring(0, 16) +
                             '... (' + ac.phase + ') fails signature quorum against the cross_chain set at block ' + ac.snapshot_block);
                return false;
            }
        }
        // Reward rows carry no per-row signatures (they are unilateral local
        // writes), so they verify by RE-DERIVATION: every field must equal what
        // this hub derives independently:
        //   type:      anchor publish rails only; oracle_round/attest_fee are
        //              indexer-derived and must never ride the archive
        //   pubkey:    member of OUR oracle_publish set at the earn block
        //   amount:    exactly OUR configured publish reward
        //   source:    OUR own block-scoped indexer resolution
        //   local row: if we hold (type, round), it must agree (a leader
        //              crediting itself for another hub's publish diverges
        //              here on every hub that saw the real announcement);
        //              absence alone is tolerated (late joiner), the
        //              re-derivation above still bounds what it can say.
        // Loop var is `rr` (reward row), NOT `ar`: the module import `ar`
        // (anchor_reward_activation) is referenced below for the frozen-amount gate.
        for(let rr of (archive.rewards || [])){
            let tag = (rr && rr.reward_type) + '/#' + (rr && rr.round_number);
            if(!rr || !/^anchor_[A-Za-z_]+$/.test(String(rr.reward_type || ''))){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' has a non-anchor reward_type; NOT signing');
                return false;
            }
            let pubkey = String(rr.validator_pubkey || '').toLowerCase();
            // Resolve the RECORD's network once, and use it for the
            // capability set AND both flag-day gates below.
            //
            // The gates used to read `this.network`, the DEPLOYMENT network, while the
            // capability-set resolution on the next line already used the archive's own.
            // That is the same defect fixed at the record/mirror sites and
            // missed here: on an unscoped hub (network === '') the gate resolved
            // inactive, so this verifier expected the legacy operator-tunable amount
            // while the leader that built the row used the FROZEN derived constant, and
            // a perfectly valid archive was refused signature (or, with the mismatch the
            // other way, a wrong amount was signed). The activation constants themselves
            // do not move; only which network they are read for.
            let recordNetwork = resolveQuorumNetwork(archive, this.network);
            let set = await this._resolveCapabilitySet('oracle_publish', Number(rr.block_index), recordNetwork);
            if(!set.some(v => v.pubkey === pubkey)){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' pubkey ' + pubkey.substring(0, 12) +
                             '... is not in the oracle_publish set at block ' + rr.block_index + '; NOT signing');
                return false;
            }
            // A derived reward (per-chain at/above the ANCHOR_REWARD flag-day,
            // anchor_archive at/above the ARCHIVE_REWARD flag-day) carries the FROZEN consensus
            // amount that every indexer credits and recovery restores; below each flag-day the
            // legacy operator-configured amount stands. Mirrors RewardTracker.recordAnchorReward
            // so a leader's own archived rows verify here.
            let isDerivedChain   = /^anchor_(BTC|LTC|DOGE)$/.test(String(rr.reward_type || '')) &&
                                   ar.isAnchorRewardActive(Number(rr.block_index), recordNetwork);
            let isDerivedArchive = String(rr.reward_type || '') === 'anchor_archive' &&
                                   ar.isArchiveRewardActive(Number(rr.block_index), recordNetwork);
            let expectedAmount = isDerivedChain
                ? ar.ANCHOR_REWARD_AMOUNT
                : isDerivedArchive
                ? ar.ARCHIVE_REWARD_AMOUNT
                : (this.hub.rewardTracker ? parseFloat(this.hub.rewardTracker.anchorReward).toFixed(8) : null);
            if(expectedAmount !== null && String(rr.amount) !== expectedAmount){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' amount ' + rr.amount +
                             ' != expected ' + expectedAmount + '; NOT signing');
                return false;
            }
            let mySource = this.hub.rewardTracker
                ? await this.hub.rewardTracker.resolveSourceByPubkey(pubkey, Number(rr.block_index))
                : null;
            if(!mySource || String(rr.source) !== mySource){
                console.warn('StateAnchorPublisher: archive reward ' + tag + ' source ' + rr.source +
                             ' does not match our resolution (' + mySource + '); NOT signing');
                return false;
            }
            // Cross-check against ALL our own local rows for this (reward_type,
            // round_number). Reward rows are written independently by every hub
            // from the same on-chain anchor-publish events, so an honest hub that
            // saw this round derives the SAME winner set. The table's UNIQUE key
            // is (validator_pubkey, round_number, reward_type), so two pubkeys can
            // legitimately co-exist for one (reward_type, round_number) under a
            // transient failover double-publish: querying ALL rows tolerates that
            // window (the archived pubkey's own row is matched and verified) while
            // still rejecting a leader that credits a pubkey we never derived.
            //   - a row for the archived pubkey  -> amount/block must agree
            //   - rows exist but none is ours     -> divergence: this hub saw the
            //                                        round and credited a DIFFERENT
            //                                        winner, so the archived pubkey
            //                                        is a misattributed/inflated
            //                                        credit -> NOT signing
            //   - no rows at all                  -> late joiner; re-derivation
            //                                        above already bounds it
            let local = await this.db.doQuery(
                'SELECT validator_pubkey, amount, block_index FROM validator_rewards WHERE reward_type = ? AND round_number = ?',
                [String(rr.reward_type), Number(rr.round_number)]);
            if(local && local.length > 0){
                let mine = local.find(r => String(r.validator_pubkey).toLowerCase() === pubkey);
                if(!mine){
                    console.warn('StateAnchorPublisher: archive reward ' + tag + ' credits ' + pubkey.substring(0, 12) +
                                 '... but our local rows for this round credit ' +
                                 local.map(r => String(r.validator_pubkey).substring(0, 12) + '...').join(',') +
                                 '; NOT signing');
                    return false;
                }
                if(String(mine.amount) !== String(rr.amount) ||
                   (mine.block_index != null && Number(mine.block_index) !== Number(rr.block_index))){
                    console.warn('StateAnchorPublisher: archive reward ' + tag + ' diverges from our row (' +
                                 String(mine.validator_pubkey).substring(0, 12) + '.../' + mine.amount + '/' + mine.block_index +
                                 ' vs ' + pubkey.substring(0, 12) + '.../' + rr.amount + '/' + rr.block_index + '); NOT signing');
                    return false;
                }
            } else {
                console.log('StateAnchorPublisher: archive reward ' + tag + ' predates our local history; accepting on re-derivation alone');
            }
        }
        // Key the inner map on `pubkey|source`, NOT pubkey alone. At/above
        // STAKE_WEIGHTED_QUORUM the snapshot is one row per (source, pubkey), so a key
        // delegated by two sources contributes TWO rows; a pubkey-only map collapsed
        // them to one, making archived.size < resolved.length so `resolved.length !==
        // archived.size` rejected every archive containing a multi-source key (the
        // co-sign stall). The builder (_buildArchive) already emits both rows, so the
        // verifier is the odd one out. Inert below SWQ, where source='' and there is one
        // row per pubkey (key becomes `pubkey|`).
        let groups = new Map();              // block|capability -> Map<pubkey|source, {amount, source}>
        for(let s of (archive.capability_snapshots || [])){
            let key = Number(s.snapshot_block) + '|' + String(s.capability);
            if(!groups.has(key)) groups.set(key, new Map());
            let sSource = String(s.source != null ? s.source : '');
            groups.get(key).set(String(s.signing_pubkey).toLowerCase() + '|' + sSource,
                                { amount: String(s.amount), source: sSource });
        }
        // COMPLETENESS. `groups` is derived from archive.capability_snapshots, which is
        // ATTACKER-SUPPLIED, so iterating it alone only proves the groups the leader chose
        // to include are honest. A Byzantine elected leader that DROPS a whole
        // (block, capability) group is never visited: the match/call/reward signature
        // checks above resolve their sets LOCALLY, so they still pass, and this hub
        // co-signs. The indexer's full-parse recovery then rebuilds each verification set
        // FROM the archived rows (recovery.js setFor), gets an empty set for the omitted
        // group and refuses the wrapper or the affected match/call: a quorum-signed but
        // permanently unrecoverable anchor stranding settled cross_chain rows.
        //
        // Re-derive the group list exactly as the honest builder does (_buildArchive
        // `wants`) and seed any missing key with an EMPTY map, so the loop below judges it
        // with the same `resolved.length !== archived.size` rule as every present group.
        // Seeding rather than rejecting outright is deliberate: a group whose set OUR OWN
        // resolution also finds empty is legitimately absent from an honest archive
        // (_buildArchive emits one row per member, so an empty set emits nothing), and
        // rejecting it would stall co-signing on honest rounds.
        let wants = (archive.matches || []).map(m => ({ block: m.snapshot_block, capability: 'cross_chain' }))
            .concat((archive.calls   || []).map(c => ({ block: c.snapshot_block, capability: 'cross_chain' })))
            .concat((archive.rewards || []).map(r => ({ block: r.block_index,    capability: 'oracle_publish' })));
        if(wrapperSnapshotBlock != null)
            wants.push({ block: wrapperSnapshotBlock, capability: 'oracle_publish' });
        for(let w of wants){
            // An honest builder always emits a finite height; a non-numeric one is a
            // malformed archive, and letting it through would resolve a NaN-keyed set.
            if(!Number.isFinite(Number(w.block))){
                console.warn('StateAnchorPublisher: archive requires a ' + w.capability +
                             ' snapshot group at a non-numeric block (' + w.block + '); NOT signing');
                return false;
            }
            let key = Number(w.block) + '|' + w.capability;
            if(!groups.has(key)) groups.set(key, new Map());
        }
        for(let [key, archived] of groups){
            let [block, capability] = key.split('|');
            let resolved = await this._resolveCapabilitySet(capability, Number(block), resolveQuorumNetwork(archive, this.network));
            if(resolved.length !== archived.size){
                console.warn("StateAnchorPublisher: archive snapshot group " + key + " size " + archived.size +
                             " differs from our resolution (" + resolved.length + ")");
                return false;
            }
            for(let v of resolved){
                let vSource = String(v.source != null ? v.source : '');
                let a = archived.get(v.pubkey + '|' + vSource);
                if(!a || a.amount !== v.amount || a.source !== vSource){
                    console.warn("StateAnchorPublisher: archive snapshot group " + key + " diverges for pubkey " +
                                 v.pubkey.substring(0, 12) + "... (local amount/source " + v.amount + "/" + vSource +
                                 ", archived " + (a ? (a.amount + "/" + a.source) : "<absent>") + ")");
                    return false;
                }
            }
        }
        return true;
    }

    async _handleSign(envelope){
        let d = envelope.data;
        let round = this._archiveRound;
        if(!round || round.done || Number(d.batch_seq) !== round.batchSeq) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        await this._checkArchiveQuorum();
    }

    async _checkArchiveQuorum(){
        let round = this._archiveRound;
        if(!round || round.done) return;
        // STAKE_WEIGHTED_QUORUM: fire on distinct-source signer stake > 2/3 of the
        // snapshot when weighted, else legacy signature count. Matches the indexer
        // anchor.js / recovery verdict so the publisher never dequeues a batch the
        // chain then rejects (or stalls a stake-met-but-count-short batch).
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._archiveRound = null;
        // Same rule as the single-node path: a round held by a surviving broadcast
        // intent published nothing, so the pending counter stays as it was.
        if((await this._publishArchive(round)) !== 'intent_held') this._pendingMatches = 0;
    }

    async _publishArchive(round){
        let sigs = [];
        for(let [pk, sg] of round.signatures) sigs.push({ pubkey: pk, sig: sg });

        let cp      = round.cp;
        let network = String(cp.network);

        // Last gate before anything is spent, mirroring the pre-broadcast marker read in
        // _publishPendingCheckpoints. _startArchiveRound checks this before the round
        // opens, but a co-signed round reaches here minutes later and _publishArchive is
        // reachable from other paths, so re-read: any UNSETTLED intent for this network
        // belongs to an earlier round that may already have paid, and this round's own
        // intent is not armed until just before its send. Checked ahead of the
        // publisher-attestation round so a held publish does not burn a peer quorum
        // either. Fails closed (a DB read error throws and the rows stay pending) rather
        // than spending against publish history it could not read.
        let liveIntent = await this._getLiveArchiveIntent(network);
        if(this._anchorIntentHolds(liveIntent)){
            console.warn('StateAnchorPublisher: archive batch ' + round.batchSeq + ' NOT published: batch ' +
                         liveIntent.batch_seq + ' recorded a broadcast intent at ' + String(liveIntent.intent_at) +
                         ' that never finished; rows stay pending and re-archive under a fresh seq once it ' +
                         'settles or ages past ' + this.anchorIntentTtlMs + 'ms');
            return 'intent_held';
        }

        // Archive-reward re-derivation flag-day: at/above it, run the archive
        // publisher-attestation round (2f+1 oracle_publish quorum over the archive XANCPUB
        // canonical binding THIS hub as the earner) and emit ANCHOR v6 (the v1 archive
        // anchor + the publisher tail), so the indexer DERIVES the anchor_archive reward
        // and the last key-authenticated push is retired. LIVENESS-SAFE: a degraded round
        // (timeout / short quorum / not a snapshot member) FALLS BACK to legacy v1, so the
        // archive always lands; only reward issuance gains the quorum dependency.
        let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let attested = false;   // a v6 (reward-derivable) payload was actually built
        let attestSigs = [];
        if(me && ar.isArchiveRewardActive(Number(cp.snapshot_block), cp.network)){
            let attest = await this._runArchiveAttestationRound(cp, round.batchSeq, me);
            if(attest && attest.met && attest.sigs.length >= 1){
                attestSigs = attest.sigs;
                attested = true;
            } else {
                console.warn('StateAnchorPublisher: archive publisher-attestation quorum not reached for batch ' +
                             round.batchSeq + '; publishing legacy v1 (archive lands, no reward)');
            }
        }
        let parts = ['ANCHOR', attested ? '6' : '1', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                     cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                     String(cp.checkpoint_seq), String(cp.snapshot_block),
                     String(round.batchSeq), String(round.count), round.crc,
                     String(round.chunks.length), round.chunks[0], String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        if(attested){
            // Field order MUST match the indexer parser (anchor.js formats[6]):
            // ...|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
            parts.push(String(me).toLowerCase(), String(attestSigs.length));
            for(let s of attestSigs) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        }
        let v1Payload = parts.join('|');

        let broadcaster = round.signer.broadcastFn || ((p) => this._defaultBroadcast(p, round.signer));
        // Chunks descend from the head by design: they go out back-to-back from the
        // same wallet and there is no confirmed output between them, so they are the
        // one broadcast that may spend unconfirmed change. A chunk paying the target
        // rate mines right behind a head that mines; a head that does not mine is
        // caught by the confirmation watchdog, not by starving its chunks.
        let chunkBroadcaster = round.signer.broadcastFn ||
            ((p) => this._defaultBroadcast(p, round.signer, { allowUnconfirmed: true }));

        // Armed BEFORE the send, so the window this marker covers starts at the earliest
        // moment DOGE could have moved, and stays armed across the whole v2 chunk loop:
        // a crash anywhere in the round is one unfinished archive, not one per chunk.
        await this._recordArchiveIntent(network, round.batchSeq);
        let result;
        try {
            // The durable intent above holds a crashed round for anchorIntentTtlMs; this
            // is the part that settles it, and the part that covers the window AFTER the
            // TTL expires. getarchiveanchor answers "did we already publish THIS batch"
            // from the batch's content (checkpoint identity + crc + count) rather than
            // from the match_batch_seq the restart no longer preserves, so an archive
            // that already reached DOGE is ADOPTED here instead of paid for twice.
            result = await this._broadcastWithRetry(broadcaster, v1Payload, undefined,
                () => this._findExistingArchiveAnchor(cp, round));
        } catch(e){
            // A definitive failure means nothing reached the DOGE node (pre-send
            // build/sign errors, a spend-ceiling refusal, an RPC rejection), so withdraw
            // rather than stall archiving for the whole TTL over a send that never
            // happened. An AMBIGUOUS send KEEPS its intent: that case is exactly what the
            // marker exists for.
            if(!(e && e.anchorAmbiguousSend)) await this._withdrawArchiveIntent(network, round.batchSeq);
            throw e;
        }
        let txid = result && result.txid ? result.txid : null;
        if(txid) await this._markArchiveSent(network, round.batchSeq, txid);
        if(txid && !(result && result.exists)) this._notePendingConfirmation('archive_head', txid, String(round.batchSeq));

        // The seq the chunks must be addressed to. Normally this round's own, but when
        // the head above was ADOPTED it is the seq that head actually landed under,
        // which this process could not know (the re-election allocated a different one).
        // Chunks broadcast under any other number are orphans: they would carry the
        // archive bytes but attach to no head, and the batch would never reassemble.
        // Only the CHUNK addressing moves. Local bookkeeping (_backfillBatch, the
        // FINALIZED announcement, the reward's round reference) stays on round.batchSeq,
        // because peers observed this round's SIGN_REQ under that seq and authenticate
        // the FINALIZED against it; nothing binds the local seq to match_batch_seq.
        let chunkSeq = (result && result.archiveAnchor && result.archiveAnchor.match_batch_seq != null)
            ? Number(result.archiveAnchor.match_batch_seq) : round.batchSeq;
        if(chunkSeq !== round.batchSeq)
            console.log('StateAnchorPublisher: adopted an already-published archive head (txid ' + txid +
                        ', batch ' + chunkSeq + ') for round ' + round.batchSeq +
                        '; remaining chunks go out under the adopted seq');

        let lostChunks = 0;
        for(let i = 1; i < round.chunks.length; i++){
            let v2Payload = ['ANCHOR', '2', String(chunkSeq), String(i), String(round.chunks.length), round.chunks[i]].join('|');
            // A lost chunk is a durability failure (recovery needs every chunk),
            // so the shared anchor-broadcast retry matters most here.
            // The same content-addressed check guards each chunk slot: a crash can land
            // the head and only some of its chunks, and without per-slot resolution the
            // resume would either re-pay for the chunks that landed or strand the batch.
            try {
                let chunkResult = await this._broadcastWithRetry(chunkBroadcaster, v2Payload, undefined,
                      () => this._findExistingArchiveChunk(cp, round, i));
                if(chunkResult && chunkResult.txid && !chunkResult.exists)
                    this._notePendingConfirmation('archive_chunk', chunkResult.txid, round.batchSeq + '/' + i);
            }
            catch(e){
                lostChunks++;
                this._archiveChunkLosses++;
                console.error('StateAnchorPublisher: v2 chunk ' + i + ' broadcast failed after retries: ' + (e && e.message));
            }
        }

        // On-chain VALIDITY gate: the source rows are only safe to DEQUEUE if the
        // v1 we just broadcast will pass the indexer's own check. Its wrapper
        // signatures must reach quorum over oracle_publish @ snapshot_block, the
        // SAME set + threshold the indexer (anchor.js) and full-parse recovery
        // verify against. If they don't (e.g. a validator-set drift the signing
        // round could not satisfy), the on-chain v1 is stored `invalid`; dequeuing
        // the rows anyway would strand settled cross_chain_matches/calls in an
        // unrecoverable hole. Treat it exactly like a lost chunk: keep the rows
        // pending so a later round re-archives them under a fresh batch seq. The
        // GENUINE single-node degenerate (validators.length === 1) keeps today's
        // behavior (the indexer stores those as recoverable 'unverified').
        // === 1, not <= 1: an EMPTY declared signing set is not a single-node quorum.
        // _startArchiveRound now defers a snapCount === 0 round outright, so this is
        // defense-in-depth for any other path into _publishArchive; it fails closed
        // (an empty set gives qualified 0 -> bftQuorumOrSingle(0, 1) === 1 > 0 valid
        // signers), so the rows stay pending instead of being dequeued against a v1
        // no verifier can ever confirm.
        let onChainValid = (round.validators.length === 1) ||
                           this._quorumVerified(round.canonical, sigs, round.validators, round.weighted);

        // A partially-published archive is unrecoverable (recovery refuses
        // incomplete batches), so the rows must NOT be marked archived. Back-fill
        // with a sentinel archived_status instead: batch_seq still advances (a
        // re-archive must get a FRESH seq; two v1 anchors sharing one seq would
        // corrupt chunk reassembly) while `archived_status <> status` keeps every
        // row eligible, so the next flush re-archives the whole batch.
        // A null txid is a false/incomplete broadcast success (_defaultBroadcast falls
        // back to { txid: null }); the v1 never landed on-chain, so dequeuing the rows
        // with their final status would strand them in an unrecoverable hole and the
        // archive reward would be credited for an anchor that was never published. Treat
        // it exactly like a lost chunk: keep the rows pending under a fresh batch seq.
        // (Mirrors the v0 null-txid guard in _publishPendingCheckpoints.)
        let noTxid = !txid;
        let matchIds = round.matchIds, callIds = round.callIds || [], rewardIds = round.rewardIds || [];
        if(lostChunks > 0 || !onChainValid || noTxid){
            matchIds  = matchIds.map(m => Object.assign({}, m, { status: '__partial__' }));
            callIds   = callIds.map(c => Object.assign({}, c, { status: '__partial__' }));
            rewardIds = [];                  // reward rows stay pending (batch_seq NULL) and re-archive
            if(lostChunks > 0)
                console.error('StateAnchorPublisher: batch ' + round.batchSeq + ' lost ' + lostChunks +
                              ' chunk(s) on-chain; rows stay pending and re-archive under a new batch seq' +
                              ' (cumulative chunk losses: ' + this._archiveChunkLosses + ')');
            if(!onChainValid)
                console.error('StateAnchorPublisher: batch ' + round.batchSeq + ' archive will NOT reach quorum over ' +
                              'oracle_publish @ snapshot_block ' + round.cp.snapshot_block + '; on-chain v1 would be ' +
                              'invalid, rows stay pending and re-archive under a new batch seq');
            if(noTxid)
                console.error('StateAnchorPublisher: batch ' + round.batchSeq + ' archive v1 broadcast returned no ' +
                              'txid; rows stay pending and re-archive under a new batch seq');
        }
        await this._backfillBatch(round.batchSeq, matchIds, txid, callIds, rewardIds);
        // Bookkeeping is done, so the crash window this marker covers is closed: settle it
        // and let the next round start immediately. Settling is gated on a real txid
        // because a null one is a false/incomplete broadcast success, NOT proof that
        // nothing was sent (the same reasoning that leaves the checkpoint marker armed on
        // a null txid); leaving it unsettled makes the TTL, rather than this flush, decide
        // when a possibly-paid batch may be rebuilt. A partial archive (lost chunks /
        // invalid on-chain quorum) DOES settle: its rows re-archive under a fresh seq by
        // design, and the head we paid for is accounted for.
        if(txid) await this._settleArchiveIntent(network, round.batchSeq);
        if(this.peerManager){
            this.peerManager.broadcast(XANC_FINALIZED, {
                batch_seq: round.batchSeq, txid: txid, matches: matchIds,
                calls: callIds,
                rewards: rewardIds,
                snapshot_block: Number(round.cp.snapshot_block),
                sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
                sig: this.identity.sign(this._finalizedCanonical(round.batchSeq, txid, matchIds.length))
            });
        }
        if(lostChunks === 0 && onChainValid && !noTxid){
            console.log('StateAnchorPublisher: archived ' + round.count + ' matches + ' +
                        ((round.callIds && round.callIds.length) || 0) + ' calls + ' +
                        ((round.rewardIds && round.rewardIds.length) || 0) + ' rewards (batch ' + round.batchSeq +
                        ', ' + round.chunks.length + ' chunk(s), txid ' + txid + ')');
            // At/above the archive-reward flag-day the reward is DERIVED on-chain from the
            // v6 publisher attestation, and the indexer credits NOTHING for a degraded
            // legacy v1. Recording it anyway would strand the credit in hub-local +
            // archive bookkeeping only, forking the COLLECT rail live-vs-recovered (same
            // reasoning as the v4/v5 degraded-fallback withhold).
            if(attested || !ar.isArchiveRewardActive(Number(round.cp.snapshot_block), round.cp.network)){
                this._recordReward('anchor_archive', round.batchSeq,
                                   this.identity ? this.identity.getPubkeyHex() : null,
                                   Number(round.cp.snapshot_block), round.cp.network);
                // Option C: mirror the archive XANCPUB quorum so the BTC indexer derives
                // the anchor_archive reward (only when the v6 attestation actually landed).
                // Same confirm-then-write rule as the v4/v5 site. onChainValid above
                // is a signature-quorum verdict, not proof the v6 head was mined, and `txid` is
                // the mempool txid _broadcastWithRetry returned, so the row is queued until the
                // head is buried at version 6.
                if(attested){
                    let mePk = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
                    if(mePk)
                        this._deferRewardAttestation({
                            chain: round.cp.chain, network: round.cp.network,
                            blockIndex: Number(round.cp.block_index), checkpointSeq: Number(round.cp.checkpoint_seq),
                            txid: txid, anchorVersion: 6,
                            rewardType: 'anchor_archive', roundReference: Number(round.batchSeq),
                            snapshotBlock: Number(round.cp.snapshot_block),
                            publisher: mePk, attestSigs: attestSigs,
                            federate: true      // archive leader owns the fan-out, same as the v4/v5 site
                        });
                }
            } else {
                console.log('StateAnchorPublisher: degraded legacy v1 archive at/above the archive-reward ' +
                            'flag-day for batch ' + round.batchSeq + '; reward withheld (no live indexer derives it)');
            }
        }
    }

    // Back-fills batch metadata from the archive leader so a rotated leader doesn't re-archive.
    async _handleFinalized(envelope){
        let d = envelope.data;
        if(!d || !Array.isArray(d.matches)) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set (see _handleV0Done): membership is the only tie
        // to a federation member, so an empty set must reject. Otherwise a forged
        // FINALIZED backfills real matches as archived and strands them for recovery.
        if(pubkeys.length === 0 || !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this._finalizedCanonical(Number(d.batch_seq), d.txid, d.matches.length),
                                     String(d.sig || ''), sender)) return;
        // Authenticate the FINALIZED sender as an archive leader we actually
        // observed getting elected for THIS batch_seq (via _handleSignReq). The
        // archive election is keyed on election_block, which the FINALIZED
        // canonical does NOT carry, so membership + signature alone let ANY
        // oracle_publish member forge a FINALIZED that (a) marks settled rows
        // archived under a bogus batch_seq -> stranded from full-parse recovery
        // (XANC-FINALIZED-STRAND-1), and (b) mirrors the anchor_archive reward
        // crediting itself -> mints COLLECT-spendable XCHAIN, since the archive
        // reward push is NOT retired by the anchor-reward flag-day (RewardTracker
        // only derives anchor_<CHAIN> on-chain; anchor_archive still pushes). Fail
        // closed on an un-observed round: back-fill is local bookkeeping the rows
        // re-archive under a fresh seq if missed, and the elected leader records
        // its own reward directly (co-signers' mirrors are redundant, INSERT
        // IGNORE-deduped). A Byzantine ELECTED leader announcing a never-published
        // txid is the residual, closable only by on-chain DOGE txid verification.
        if(!this._isObservedArchiveLeader(Number(d.batch_seq), sender)) return;
        // XANC-FINALIZED-CONTENT-1: the signed canonical binds only (batch_seq,
        // txid, match COUNT); the match/call/reward id+status lists are UNSIGNED
        // wire fields. The observed-leader gate above bounds WHO may send this,
        // not WHAT it says: a Byzantine ELECTED leader could otherwise stamp
        // arbitrary local rows archived with attacker-chosen statuses, stranding
        // them from every future archive round. Re-verify the announced content
        // against OUR OWN rows before stamping (receiver-side only, no
        // wire-format change; same authority argument as _verifyArchiveAgainstLocal:
        // every hub writes finalized rows, so the local DB is authoritative).
        // Rejecting is always safe: back-fill is local bookkeeping and missed
        // rows simply re-archive under a fresh batch seq.
        let calls   = Array.isArray(d.calls)   ? d.calls   : [];
        let rewards = Array.isArray(d.rewards) ? d.rewards : [];
        if(!(await this._verifyFinalizedAgainstLocal(d.matches, calls, rewards))){
            console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') announces content ' +
                         'diverging from our DB; ignoring back-fill (rows re-archive under a fresh seq)');
            return;
        }
        // XANC-FINALIZED-NULLTXID-1. The back-fill below is
        // state-changing and runs before ANY on-chain check: it stamps
        // archived_status = status, and the pending selectors
        // (`batch_seq IS NULL OR archived_status <> status`) then skip those rows, which
        // for a row already at its TERMINAL status means forever. An elected-yet-
        // Byzantine leader that announces real pending rows carrying their true current
        // statuses passes _verifyFinalizedAgainstLocal (the statuses genuinely match) and
        // can suppress them with an archive it never published.
        //
        // An honest leader NEVER emits that shape: _publishArchive rewrites every match
        // and call status to the '__partial__' sentinel and clears the reward list
        // whenever the broadcast returned no txid, so `txid == null` implies
        // `every status === '__partial__'`, which leaves `archived_status <> status` and
        // keeps the rows eligible. Refuse the combination the honest builder cannot
        // produce. This costs no liveness at all and needs no chain access, but it closes
        // only the NULL-txid half: a FABRICATED-but-plausible txid still stamps, and
        // closing that needs the announced txid verified on DOGE at depth. That gate
        // cannot simply be inlined here - the FINALIZED is broadcast at 0 confirmations
        // (mempool) exactly like XANC_V0_DONE, so it needs the same defer-and-re-verify
        // queue (_deferV0Done / _drainDeferredV0Done), plus an archive-head version SET
        // {1, 6} in _verifyArchiveCheckpointOnChain, which today hardcodes v1 because it
        // only runs below the flag-day.
        let terminalAnnounced = (d.matches || []).some(m => m && m.status !== '__partial__') ||
                                calls.some(c => c && c.status !== '__partial__') ||
                                rewards.length > 0;
        if(!d.txid && terminalAnnounced){
            console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') carries NO txid but ' +
                         'announces non-__partial__ rows; an honest publish marks every row __partial__ when ' +
                         'the broadcast returned no txid, so this cannot be a real archive. Ignoring the ' +
                         'back-fill (rows stay pending and re-archive under a fresh seq)');
            return;
        }
        // XANC-FINALIZED-FORGE-1. The guard above closes
        // only the shape an honest leader cannot produce; a plausible FABRICATED txid
        // still stamps archived_status = status, which the pending selectors then skip
        // for a terminal row forever. Close it the way the v0 rail closes
        // XANC-ELECTED-FORGE-1: the announced ARCHIVE HEAD must be on DOGE at
        // dogeConfirmations depth before the suppressing column is written.
        //
        // FINALIZED is broadcast at 0 confirmations (the broadcast returns a mempool
        // txid), so 'absent'/'shallow'/'unreachable' is the NORMAL first answer for a
        // perfectly honest archive; refusing outright would be a liveness bug. Split the
        // back-fill exactly the way an honest lost-chunk publish already splits it:
        //   now   - stamp batch_seq under the '__partial__' sentinel, no txid,
        //   later - stamp the announced statuses + txid once the head is buried.
        // Staging the seq is load-bearing: _getNextBatchSeq is MAX(batch_seq)+1
        // fleet-wide, so a follower that stamped nothing would hand its own next round
        // the seq the leader just used, and two v1 anchors sharing one seq corrupt chunk
        // reassembly. The sentinel keeps `archived_status <> status` true, so nothing is
        // suppressed and the rows re-archive under a fresh seq if the head never
        // confirms. Reward rows are deliberately NOT staged: their pending test is
        // `batch_seq IS NULL` alone, so an early stamp is itself permanent suppression.
        //
        // LANDING NOTE: this inverts a contract pinned OUTSIDE this repo,
        // but in ONE harness, not two, and the distinction decides what a landing lane may
        // touch. The two xchain-e2e-test suites that assert on this back-fill run under
        // OPPOSITE conditions, so a single "the harness has no chain" claim is wrong:
        //   multiHubStateAnchor.integration.test.js:282 is CHAINLESS. Its own header says
        //     "no chain in this harness" and it publishes through a captured broadcast
        //     hook, so nothing answers getanchoraction, the verify abstains, every follower
        //     stamps '__partial__', and its archived_status === 'finalized' assertion does
        //     genuinely have to move with this diff.
        //   anchorElection.test.js:412 is LIVE. Its header says "on a LIVE DOGE regtest
        //     chain" and its prerequisites boot the real indexer, which serves
        //     getanchoraction as a federation read (xchain-indexer/src/api.js:163, :1266).
        //     That repo ships no getanchoraction STUB because it has the real RPC; absence
        //     of a stub is not absence of a chain. Its assertion is therefore a live-chain
        //     assertion and must NOT be relaxed to accept '__partial__': that would delete
        //     the only coverage proving this gate stamps a REAL archive. What it actually
        //     faces is the confirmation-DEPTH question, the same one the already-landed v0
        //     gate faces at its own back-fill assertion (:283), and XANC-ELECTED-FORGE-1
        //     landed (31b7475) without editing that file.
        // One residual stays open: the gate proves the CHECKPOINT is anchored, not the
        // BATCH, since nothing binds match_batch_seq and two batch_seqs can share one
        // checkpoint. getanchoraction neither ACCEPTS it (validateAnchorActionParams takes
        // chain/network/block_index/checkpoint_seq/txid/version) nor EMITS it
        // (ANCHOR_ACTIONS_SQL selects no batch column and buildAnchorActionResponse returns
        // none), so binding it needs an xchain-indexer change before this hub can.
        if(!d.txid){
            // Every announced row is '__partial__' here (the guard above proves it), so
            // this is the honest failed-broadcast shape: seq bookkeeping, nothing to verify.
            await this._backfillBatch(Number(d.batch_seq), d.matches, null, calls, rewards);
            return;
        }
        // Archive-head version SET {1, 6}: below the flag-day _publishArchive
        // emits a v1 head, at/above it a v6. This gate runs at ALL heights (row
        // suppression has nothing to do with reward retirement), so it cannot use the
        // reward gate's exact-v1 expectation. Rejecting {0,2,3,4,5} still stops a
        // checkpoint anchor or a v2 continuation chunk standing in for the head.
        let archiveOnChain = await this._verifyArchiveCheckpointOnChain(
            Number(d.batch_seq), String(d.txid), { rejectVersions: [0, 2, 3, 4, 5] });
        if(archiveOnChain === 'verified'){
            await this._applyFinalized(d, sender, calls, rewards);
            return;
        }
        if(String(archiveOnChain).startsWith('rejected')){
            console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') archive head REJECTED ' +
                         'on-chain (' + archiveOnChain + '); stamping nothing (rows stay pending and ' +
                         're-archive under a fresh seq)');
            return;
        }
        await this._backfillBatch(Number(d.batch_seq),
                                  (d.matches || []).map(m => Object.assign({}, m, { status: '__partial__' })),
                                  null,
                                  calls.map(c => Object.assign({}, c, { status: '__partial__' })),
                                  []);
        this._deferFinalized(d, sender, calls, rewards, archiveOnChain);
    }

    // Apply a FINALIZED whose archive head is confirmed on DOGE at depth: stamp the
    // announced statuses + txid, then mirror the leader's reward. Shared by the
    // immediate-receipt path and the deferred drain, so an announcement that arrives at
    // 0 confirmations lands EXACTLY the same rows as one that arrives already buried.
    async _applyFinalized(d, sender, calls, rewards){
        await this._backfillBatch(Number(d.batch_seq), d.matches, d.txid ? String(d.txid) : null,
                                  calls, rewards);
        // Mirror the leader's archive-publish reward (sender is signature-
        // verified) so all hubs hold the same reward rows (same rail as the
        // V0_DONE mirror). Only a COMPLETE publish earns it (the leader skips
        // its own reward on lost chunks and marks rows __partial__).
        let partial = (d.matches || []).some(m => m && m.status === '__partial__') ||
                      calls.some(c => c && c.status === '__partial__');
        if(d.txid && !partial && Number.isFinite(Number(d.snapshot_block))){
            // d.snapshot_block is an unsigned wire field used as the mirrored
            // reward's block-scoped source-resolution key. Bound it by the same
            // re-derivation _verifyArchiveAgainstLocal applies to archived reward
            // rows: the credited pubkey must hold oracle_publish AT that block
            // (a fabricated block index fails the membership resolution).
            let setAtSnap = await this._getActiveOraclePublishPubkeys(Number(d.snapshot_block));
            if(!setAtSnap.includes(sender)){
                console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') sender not in the ' +
                             'oracle_publish set at announced snapshot_block ' + d.snapshot_block +
                             '; NOT mirroring the archive reward');
            } else {
                // XANC-REWARD-THEFT-1 (archive half, LIVE): anchor_archive is NOT
                // retired by the anchor-reward flag-day (RewardTracker only derives
                // anchor_<CHAIN>), so a forged mirror mints COLLECT-spendable XCHAIN
                // TODAY. Gate the mirror on the batch's checkpoint being really
                // anchored on DOGE at depth: an elected-yet-Byzantine leader that
                // announces a FINALIZED for an archive it never published earns
                // nothing. ABSTAIN (no mirror) on an unverifiable / absent / shallow
                // anchor - the elected leader records its own reward directly, so a
                // co-signer's mirror is redundant (INSERT IGNORE-deduped) and the
                // rows re-archive under a fresh seq if the checkpoint later confirms.
                // d.txid is bound into the signed _finalizedCanonical and names the v1
                // archive head, so it is passed through to bind the specific archive
                // transaction, not merely "some anchor for this checkpoint".
                // At/above the archive-reward flag-day the reward is DERIVED
                // on-chain from the v6 attestation; the FINALIZED does not say whether
                // the leader's publish carried it (a degraded v1 earns nothing), so
                // mirroring here could credit a reward no live indexer derives (fork on
                // recovery). Below the flag-day the mirror remains the only peer rail.
                // Gate and record on the CHECKPOINT's network, never
                // this.network. The XANCFIN wire carries no network, so resolve it from
                // the locally stashed identity; re-deriving from the hub's own network
                // double-credited on an unscoped hub (network===''), forking the
                // COLLECT-spendable rail live-vs-recovered. When no local identity is
                // stashed, _verifyArchiveCheckpointOnChain returns 'no-checkpoint-id'
                // and nothing is recorded, so the fallback only feeds the flag-day gate.
                let cpId  = this._observedArchiveCheckpoint(Number(d.batch_seq));
                let cpNet = cpId ? String(cpId.network) : this.network;
                let archiveVerified = ar.isArchiveRewardActive(Number(d.snapshot_block), cpNet)
                    ? 'flag-day-derived (mirror retired)'
                    : await this._verifyArchiveCheckpointOnChain(Number(d.batch_seq), String(d.txid));
                if(archiveVerified === 'verified')
                    this._recordReward('anchor_archive', Number(d.batch_seq), sender, Number(d.snapshot_block), cpNet);
                else
                    console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') archive checkpoint ' +
                                 'not on-chain verified (' + archiveVerified + '); NOT mirroring the archive reward');
            }
        }
    }

    // Queue an authenticated FINALIZED whose archive head is not yet buried. Keyed on
    // the announcement's full identity INCLUDING the txid, so two competing txids for
    // one batch are tracked separately and whichever actually confirms wins. Queuing
    // grants no authority: the entry is re-verified in full before it can stamp.
    _deferFinalized(d, sender, calls, rewards, reason){
        let key = [Number(d.batch_seq), String(d.txid), String(sender)].join('|');
        if(this._deferredFinalized.has(key)) return;
        // Bounded: drop the OLDEST entry rather than the new one (Map preserves
        // insertion order), so a flood cannot pin the queue on stale announcements.
        if(this._deferredFinalized.size >= this.announceQueueMax){
            let oldest = this._deferredFinalized.keys().next().value;
            this._deferredFinalized.delete(oldest);
            console.warn('StateAnchorPublisher: deferred FINALIZED queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        this._deferredFinalized.set(key, { d: d, sender: sender, calls: calls, rewards: rewards, at: Date.now() });
        console.log('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') archive head not yet buried (' +
                    reason + '); seq staged under the __partial__ sentinel, queued for re-verification (' +
                    this._deferredFinalized.size + ' pending)');
    }

    // Re-verify queued FINALIZED announcements and stamp the ones whose archive head has
    // since been buried. Runs on the announceRetryMs timer and at the head of every
    // flush, alongside the V0_DONE drain. Authenticity (membership, signature over the
    // txid-bearing canonical, observed-leader) was settled at receipt and cannot change;
    // what is re-checked is the head's on-chain depth, plus the announced CONTENT, which
    // can move (a row may have advanced status while the entry sat in the queue).
    async _drainDeferredFinalized(){
        if(this._deferredFinalized.size === 0) return;
        for(let [key, entry] of [...this._deferredFinalized]){
            let d = entry.d;
            if(Date.now() - entry.at > this.announceRetryTtlMs){
                this._deferredFinalized.delete(key);
                console.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' expired after ' +
                             this.announceRetryTtlMs + 'ms without confirming; dropping (the staged rows are ' +
                             'still archive-eligible and re-archive under a fresh seq)');
                continue;
            }
            try {
                let v = await this._verifyArchiveCheckpointOnChain(Number(d.batch_seq), String(d.txid),
                                                                   { rejectVersions: [0, 2, 3, 4, 5] });
                if(v === 'verified'){
                    this._deferredFinalized.delete(key);
                    if(!(await this._verifyFinalizedAgainstLocal(d.matches, entry.calls, entry.rewards))){
                        console.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' confirmed on DOGE but its ' +
                                     'announced content no longer matches our DB; dropping the back-fill');
                        continue;
                    }
                    await this._applyFinalized(d, entry.sender, entry.calls, entry.rewards);
                    console.log('StateAnchorPublisher: deferred FINALIZED ' + key + ' confirmed on DOGE; stamped');
                } else if(String(v).startsWith('rejected')){
                    this._deferredFinalized.delete(key);
                    console.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' REJECTED on re-verification (' +
                                 v + '); dropped');
                }
            } catch(e){
                console.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' re-verification error: ' + (e && e.message));
            }
        }
    }

    // FINALIZED content re-verification (receiver side; the XANCFIN canonical
    // does not commit to the announced id/status lists). For every announced
    // row this hub holds locally, the announced status must be the '__partial__'
    // sentinel (keeps the row archive-eligible; benign) or byte-equal our row's
    // current status. A row we do NOT hold passes: its UPDATE is a no-op and a
    // late joiner has no copy of earlier history. Announced rewards must at
    // least be anchor-rail rows (same bar _verifyArchiveAgainstLocal sets);
    // their UPDATE only ever stamps batch_seq on rows we already derived.
    async _verifyFinalizedAgainstLocal(matches, calls, rewards){
        for(let m of (matches || [])){
            if(!m || m.match_id == null) return false;
            if(m.status === '__partial__') continue;
            let rows = await this.db.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [m.match_id]);
            if(rows && rows.length > 0 && String(rows[0].status) !== String(m.status)){
                console.warn('StateAnchorPublisher: FINALIZED match ' + String(m.match_id).substring(0, 16) +
                             "... announces status '" + m.status + "' but our row holds '" + rows[0].status + "'");
                return false;
            }
        }
        for(let c of (calls || [])){
            if(!c || c.call_id == null) return false;
            if(c.status === '__partial__') continue;
            let rows = await this.db.doQuery('SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [c.call_id, c.phase]);
            if(rows && rows.length > 0 && String(rows[0].status) !== String(c.status)){
                console.warn('StateAnchorPublisher: FINALIZED call ' + String(c.call_id).substring(0, 16) +
                             "... (" + c.phase + ") announces status '" + c.status + "' but our row holds '" + rows[0].status + "'");
                return false;
            }
        }
        for(let r of (rewards || [])){
            if(!r || !/^anchor_[A-Za-z_]+$/.test(String(r.reward_type || ''))){
                console.warn('StateAnchorPublisher: FINALIZED reward list carries a non-anchor reward_type; rejecting');
                return false;
            }
        }
        return true;
    }

    _finalizedCanonical(batchSeq, txid, count){
        return 'XANCFIN|' + String(batchSeq) + '|' + String(txid || '') + '|' + String(count);
    }

    // Record that `pubkey` validated as the elected archive leader for `batchSeq`
    // (called from _handleSignReq after the election/rank check passes). Stored as
    // a SET because the failover ladder can legitimately unlock more than one rank
    // for the same batch_seq, and this hub may observe successive proposers.
    _recordObservedArchiveLeader(batchSeq, pubkey, cpIdentity){
        if(!Number.isFinite(batchSeq) || !pubkey) return;
        let set = this._observedArchiveLeaders.get(batchSeq);
        if(!set){ set = new Set(); this._observedArchiveLeaders.set(batchSeq, set); }
        set.add(String(pubkey).toLowerCase());
        // Stash the batch's checkpoint identity (first observation wins). Identity
        // ONLY (chain/network/block_index/checkpoint_seq) - _handleFinalized
        // re-SELECTs our OWN checkpoint row from it before verifying, so a Byzantine
        // wire cp can never inject foreign hashes; a wrong identity just fails to
        // resolve locally and the reward mirror abstains.
        if(cpIdentity && !this._observedArchiveCheckpoints.has(batchSeq))
            this._observedArchiveCheckpoints.set(batchSeq, {
                chain: String(cpIdentity.chain), network: String(cpIdentity.network),
                block_index: Number(cpIdentity.block_index), checkpoint_seq: Number(cpIdentity.checkpoint_seq)
            });
        // Bounded memory: batch_seq is monotonic, so evict the smallest keys from
        // both maps in lockstep.
        while(this._observedArchiveLeaders.size > this._observedArchiveLeadersCap){
            let oldest = null;
            for(let k of this._observedArchiveLeaders.keys()) if(oldest === null || k < oldest) oldest = k;
            if(oldest === null) break;
            this._observedArchiveLeaders.delete(oldest);
            this._observedArchiveCheckpoints.delete(oldest);
        }
    }

    _isObservedArchiveLeader(batchSeq, pubkey){
        let set = this._observedArchiveLeaders.get(batchSeq);
        return !!set && set.has(String(pubkey || '').toLowerCase());
    }

    // The checkpoint identity we stashed for this batch_seq's archive round (from
    // the SIGN_REQ), or null if we never observed it.
    _observedArchiveCheckpoint(batchSeq){
        return this._observedArchiveCheckpoints.get(batchSeq) || null;
    }

    // Verify the checkpoint an archive batch is bound to really landed on DOGE, for
    // the FINALIZED reward gate. Resolves the stashed identity to OUR OWN
    // state_checkpoints row (never the wire), then defers to _verifyAnchorOnChain.
    // Returns 'no-checkpoint-id' (never saw the SIGN_REQ) / 'absent-local' (we do
    // not hold the referenced checkpoint) as ABSTAIN reasons, else the
    // _verifyAnchorOnChain verdict. `announcedTxid` is the FINALIZED's txid, which is
    // bound into the signed _finalizedCanonical and is the txid of the v1 ARCHIVE HEAD
    // (_publishArchive broadcasts the v1/v6 payload first, then the v2 continuation
    // chunks). Binding it, plus the archive-head version set {1, 6}, closes the archive
    // half of XANC-ELECTED-FORGE-1: proving the CHECKPOINT is anchored is not enough,
    // because an elected leader could reference a real-but-different anchored checkpoint
    // and still mirror itself the anchor_archive reward (below the flag-day;
    // at/above it the mirror is retired outright).
    // `expect` overrides the version expectation for callers that run at ALL heights
    // (the back-fill gate passes rejectVersions [0,2,3,4,5], i.e. the archive-head
    // SET {1, 6}); omitted, it keeps the reward gate's exact-v1 expectation below.
    async _verifyArchiveCheckpointOnChain(batchSeq, announcedTxid, expect){
        let id = this._observedArchiveCheckpoint(batchSeq);
        if(!id) return 'no-checkpoint-id';
        let rows = await this.db.doQuery(
            'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
            [id.chain, id.network, Number(id.block_index), Number(id.checkpoint_seq)]);
        if(!rows || rows.length === 0) return 'absent-local';
        if(!announcedTxid) return 'no-txid';
        // Default version 1 stays exact for the REWARD gate: that caller only runs BELOW
        // the archive-reward flag-day (at/above it the FINALIZED reward mirror is retired
        // outright), and every pre-flag-day archive head is a v1. The back-fill
        // gate runs at every height and passes its own archive-head SET instead.
        return this._verifyAnchorOnChain(rows[0],
            Object.assign({ txid: String(announcedTxid) }, expect || { version: 1 }));
    }

    // XMATCH canonical: byte-identical to CrossChainDexEngine._canonicalMatch /
    // the indexer's cross_settle._canonical (kept local so archive verification
    // never depends on the DEX engine being constructed).
    _matchCanonical(m){
        let raw = [
            'XMATCH', m.match_id, String(m.snapshot_block),
            m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
            m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
            String(m.effective_time), m.network || '',
            m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
            m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
        ].join('|');
        // Cross-chain royalty legs ride the signed match at/above the CROSS_CHAIN_ROYALTY
        // flag-day; below it the canonical is byte-identical to the legacy format.
        if(ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
            raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
        // EQUIV (WI-2 bump 2): VIEW = the archived row's finalizing_view. TAG=XDEX,
        // ROUND_ID=match_id. Byte-matches the hub engine + indexer cross_settle.
        if(eq.isEquivHeaderActive(m.snapshot_block, m.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
        return raw;
    }

    // XCALL phase canonicals: byte-identical to CrossChainCallEngine._canonicalMatch
    // / the indexer's verifiers (kept local for the same reason as _matchCanonical).
    _callCanonical(c){
        let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
        let phase = (c.phase === 'result') ? 'result' : 'dispatch';
        let raw;
        if(c.phase === 'result'){
            raw = [
                'XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
                c.target_chain, String(c.result_status || ''),
                sha(c.return_payload_b64), String(c.effective_time)
            ].join('|');
        } else {
            raw = [
                'XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
                c.source_chain, String(c.source_action_index), String(c.source_contract_index),
                c.target_chain, String(c.target_contract_index),
                c.method, sha(c.params_json),
                String(c.gas_limit), String(c.cross_hops), String(c.effective_time)
            ].join('|');
        }
        // EQUIV (WI-2 bump 2): TAG=XCALL, ROUND_ID = sha256('XCALLROUND|'+phase+'|'+call_id),
        // VIEW = the archived row's finalizing_view. Byte-matches the hub engine + indexer twins.
        if(eq.isEquivHeaderActive(c.snapshot_block, c.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|' + phase + '|' + c.call_id), (c.finalizing_view != null ? c.finalizing_view : 0), raw);
        return raw;
    }

    // Signature quorum over a resolved validator set, byte-for-byte the same verdict
    // the indexer recovery (_quorumVerified) + anchor.js apply: stake-weighted
    // (source-deduped, 3*Sigma signer-source weight > 2*S) at/above STAKE_WEIGHTED_QUORUM,
    // else legacy 2f+1 count. `validatorSet` is the full [{pubkey, source, weight|amount}]
    // set (bare-pubkey callers must now pass objects). Used to gate the wrapper's own
    // on-chain validity and every archived match/call against its cross_chain set.
    _quorumVerified(canonical, sigs, validatorSet, weighted){
        // Fail CLOSED on a TRUNCATED weighted set (SWQ-TRUNC parity, mirrors
        // meetsStakeThreshold + the DEX/Call consensus refuse): an over-cap snapshot
        // under-counts summed stake S, so a stake-evicted minority could otherwise clear
        // the strict 2/3 bar and authenticate a fabricated archived match/call (or the
        // wrapper). The COUNT path proceeds (deterministic cap; see CapabilitySnapshot.getQuorum).
        if(weighted && validatorSet && validatorSet.truncated === true) return false;
        let qualified = new Set((validatorSet || []).map(v => String(v.pubkey).toLowerCase()));
        if(qualified.size === 0) return false;
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            let pk = String(s.pubkey).toLowerCase();
            if(seen.has(pk) || !qualified.has(pk)) continue;
            // Mark seen only AFTER a successful verify: marking on first
            // encounter is an order-dependent quorum under-count (a garbage
            // sig ahead of the same pubkey's valid sig would drop the signer),
            // and diverges from the indexer recovery twin this must match.
            if(ValidatorIdentity.verify(canonical, String(s.sig), pk)){
                seen.add(pk);
                validSigners.push(pk);
            }
        }
        if(weighted){
            // source carries the staking source; weight (or amount, from
            // _resolveCapabilitySet) carries its stake; normalize for swq.
            let weightedSet = (validatorSet || []).map(v => ({
                pubkey: String(v.pubkey).toLowerCase(),
                source: String(v.source != null ? v.source : ''),
                weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0'))
            }));
            return swq.meetsStakeThreshold(weightedSet, validSigners);
        }
        let quorum = bftQuorumOrSingle(qualified.size, 1);   // majority-floored BFT quorum
        return validSigners.length >= quorum;
    }

    async _backfillBatch(batchSeq, matchIds, txid, callIds, rewardIds){
        // Every stamp is guarded by the archive-eligibility predicate the
        // pending selectors use (batch_seq IS NULL OR archived_status <> status):
        // a row that is already fully archived can never be re-stamped onto a
        // different batch by a replayed/forged FINALIZED, while legitimate
        // __partial__ re-archives (archived_status <> status) still stamp their
        // fresh seq. Reward rows are immutable, so batch_seq IS NULL is their
        // only pending test (mirrors the reward selector).
        for(let m of matchIds){
            await this.db.doQuery(
                'UPDATE cross_chain_matches SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) ' +
                'WHERE match_id = ? AND (batch_seq IS NULL OR archived_status <> status)',
                [batchSeq, m.status, txid, m.match_id]);
        }
        // Re-emit the stamped rows on the hub-DB mirror feed: anchor_txid is the one
        // back-filled column the mirror twins carry, and without a re-broadcast a
        // long-running streamed mirror keeps NULL forever while a later REST bootstrap
        // serves the stamp (divergent mirrors). Retracted rows stay out of the feed
        // (the stream already deleted them on mirrors); old sync clients INSERT IGNORE
        // the re-delivery, so this is backward-compatible.
        if(txid && matchIds.length && this.hub && this.hub.hubDbBroadcaster){
            try {
                let ids = matchIds.map(m => m.match_id);
                let rows = await this.db.doQuery(
                    "SELECT * FROM cross_chain_matches WHERE match_id IN (" + ids.map(() => '?').join(', ') + ") AND status <> 'retracted'",
                    ids);
                for(let row of rows)
                    this.hub.hubDbBroadcaster.broadcastRow({ table: 'cross_chain_matches', row: row });
            } catch(e){
                console.warn('StateAnchorPublisher: anchor-stamp re-broadcast failed (mirrors converge on next bootstrap):', e.message);
            }
        }
        for(let c of (callIds || [])){
            await this.db.doQuery(
                'UPDATE cross_chain_calls SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) ' +
                'WHERE call_id = ? AND phase = ? AND (batch_seq IS NULL OR archived_status <> status)',
                [batchSeq, c.status, txid, c.call_id, c.phase]);
        }
        for(let r of (rewardIds || [])){
            // Rows are immutable; batch_seq is the only archive bookkeeping.
            await this.db.doQuery(
                'UPDATE validator_rewards SET batch_seq = ? WHERE reward_type = ? AND round_number = ? AND validator_pubkey = ? ' +
                'AND batch_seq IS NULL',
                [batchSeq, String(r.reward_type), Number(r.round_number), String(r.validator_pubkey).toLowerCase()]);
        }
    }

    async _getNextBatchSeq(){
        // Spans every batch_seq-bearing table so a fresh seq is unique across
        // matches, calls AND rewards (consensus-uniform: all hubs compute the
        // same next seq from quorum-agreed rows).
        let r = await this.db.doQuery(
            'SELECT COALESCE(GREATEST(' +
            '  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_matches), -1), ' +
            '  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_calls), -1), ' +
            '  COALESCE((SELECT MAX(batch_seq) FROM validator_rewards), -1)' +
            '), -1) + 1 AS next_seq');
        return (r && r.length > 0) ? Number(r[0].next_seq) : 0;
    }

    // Maps a state_checkpoints row to the 9 identity fields only; deliberately OMITS
    // state_root / state_root_version / block_merkle_root / block_merkle_version.
    // The co-sign guards that consume this compare via _rawCanonicalCheckpoint, so the
    // omission is safe; adding the root fields to only one operand of a guard would flip
    // it fail-closed post-flag-day. Never carry roots here one-sided.
    _cpFromRow(row){
        return {
            chain: String(row.chain), network: String(row.network), block_index: Number(row.block_index),
            block_hash: String(row.block_hash), ledger_hash: String(row.ledger_hash),
            actions_hash: String(row.actions_hash), contract_hash: String(row.contract_hash),
            checkpoint_seq: Number(row.checkpoint_seq), snapshot_block: Number(row.snapshot_block)
        };
    }

    _parseSigs(raw){
        try {
            let sigs = JSON.parse(String(raw || '[]'));
            return Array.isArray(sigs) ? sigs.filter(s => s && s.pubkey && s.sig) : [];
        } catch(e){ return []; }
    }

    // crc32 over the UNCOMPRESSED archive JSON (zlib version independent).
    _crc32Hex(str){
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(str, 'utf8')) : this._crc32Fallback(Buffer.from(str, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    }
    _crc32Fallback(buf){
        let c, crc = 0xFFFFFFFF;
        for(let i = 0; i < buf.length; i++){
            c = (crc ^ buf[i]) & 0xFF;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async _getActiveOraclePublishPubkeys(blockIndex){
        if(!this.hub) return [];
        if(blockIndex !== undefined && blockIndex !== null){
            // Block-PINNED election query. Fail CLOSED on a miss: the block-unpinned,
            // self-test/enabled-filtered, gossip-driven capabilityRegistry set is
            // per-hub, so substituting it here forks the election set across hubs
            // (two hubs elect over different member lists -> double-anchor of real
            // DOGE, stalled checkpoint, or an archive co-signature the indexer drops).
            // An empty (unresolved) set means abstain, which the pinned election gates
            // already fail-close on.
            //
            // Flag-day aware, exactly like _resolveCapabilitySet: at/above
            // STAKE_WEIGHTED_QUORUM the membership authority is the WEIGHT snapshot
            // (getstakeweightsbycapability), below it the count snapshot
            // (getcapabilityvalidators). Those are distinct indexer queries with
            // distinct membership semantics, and the on-chain verifier picks the same
            // way (`weighted ? getStakeWeightsByCapability : getValidatorsByCapability`,
            // xchain-indexer anchor.js). Reading the count snapshot unconditionally made
            // this gate answer a different question from the leader quorum that judges
            // the same round: above the flag-day a validator present in the weighted set
            // (so counted by the indexer, and listed in round.validators) but absent from
            // the count set returned early and never co-signed, silently starving the
            // archive / publisher-attestation quorum into a timeout and a degraded,
            // reward-withholding legacy anchor. Gated on the DEPLOYMENT network, never a
            // wire-supplied one: on a correctly-scoped hub that IS the record's network,
            // and an unscoped hub resolves the gate to off, i.e. today's behaviour.
            // Weighted snapshots carry one row per (source, pubkey), so dedupe before
            // returning: this set is used for membership and hash-order election, both of
            // which must see each key exactly once.
            let snapErr = null;
            if(this.hub.capabilitySnapshot){
                try {
                    let weighted = swq.isStakeWeightedQuorumActive(Number(blockIndex), this.network);
                    let snap = weighted
                        ? await this.hub.capabilitySnapshot.getWeightSnapshot('oracle_publish', blockIndex)
                        : await this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
                    if(snap && Array.isArray(snap.validators))
                        return [...new Set(snap.validators.map(v => String(v.pubkey).toLowerCase()))].sort();
                } catch(e){ snapErr = e; }
            }
            // Local-table fallback, the twin of the one in _resolveCapabilitySet
            // and gated the same way: the per-hub capability_snapshots table is a
            // valid source only on seeded/regtest stacks, where the deterministic
            // snapshot path may simply not be wired. Off regtest a miss means THIS
            // hub's indexer is down, and electing over local rows while healthy
            // peers elect over the on-chain snapshot forks the election set, so
            // the abstain below stands. Without this fallback a regtest hub with
            // no live snapshot resolution abstained from every pinned election
            // and anchored nothing, silently.
            if(this.network === 'regtest' && this.db){
                try {
                    let rows = await this.db.doQuery(
                        "SELECT signing_pubkey FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC",
                        [Number(blockIndex), 'oracle_publish']);
                    // Weighted snapshots persist one row per (source, pubkey);
                    // membership and hash-order election need each key once.
                    if(rows && rows.length > 0)
                        return [...new Set(rows.map(r => String(r.signing_pubkey).toLowerCase()))].sort();
                } catch(e){ if(!snapErr) snapErr = e; }
            }
            // Abstaining is still the correct fail-closed outcome (the pinned
            // election gates treat an empty set as "do not act"), but it must be
            // loud: an unresolved membership here surfaces as zero broadcasts with
            // no error anywhere, which reads as a healthy idle publisher.
            console.warn('StateAnchorPublisher: oracle_publish membership unresolved at block ' +
                Number(blockIndex) + ' (capability snapshot unavailable' +
                (this.network === 'regtest' ? ' and the local capability_snapshots table has no rows'
                                            : '; the local-table fallback is regtest-only') +
                (snapErr ? '; last error: ' + snapErr.message : '') +
                '); abstaining from this pinned election');
            return [];
        }
        // Unpinned CURRENT-membership query (blockIndex null): the coarse V0_DONE /
        // FINALIZED sender pre-filter, which wants "is this sender a current
        // oracle_publish member" and NOT a block-pinned set. Every such caller
        // re-checks the sender against the block-PINNED election / observed-leader
        // set before acting, so the live registry is the correct source here and
        // this path must NOT fail closed (that would reject every legitimate peer
        // back-fill and force systematic re-anchoring).
        if(!this.hub.capabilityRegistry) return [];
        try {
            let pubkeys = await this.hub.capabilityRegistry.getActiveValidators('oracle_publish');
            return pubkeys.map(p => String(p).toLowerCase()).sort();
        } catch(e){ return []; }
    }

    _resolveSigner(){
        let op = this.hub.oraclePublisher || {};
        return {
            broadcastFn:  this.broadcastFn  || op.broadcastFn  || null,
            walletSignFn: this.walletSignFn || op.walletSignFn || null,
            getBalanceFn: this.getBalanceFn || op.getBalanceFn || null,
            encoder:      this.encoder      || op.encoder      || null
        };
    }

    // Back-to-back spends from the one publisher wallet race the UTXO
    // tracker's mempool view and collide on input selection
    // (txn-mempool-conflict), so every anchor broadcast retries with a pause
    // for the previous spend to become visible. Throws the last error once
    // attempts are exhausted.
    // Broadcast with retry, WITHOUT double-spending on a lost ACK.
    //
    // Each attempt intentionally rebuilds a FRESH PSBT from fresh UTXOs (conflict
    // avoidance for back-to-back multi-chain anchors), which is exactly why a
    // retry after an AMBIGUOUS send failure (the DOGE node may have accepted the
    // tx but the ACK was lost in transport) would double-broadcast and burn the
    // fee twice: the rebuilt tx spends different UTXOs, so both can confirm.
    // Mirrors AttestationPublisher's authoritative pre-replay existence check
    // (_fetchPendingRequestIds): when the caller can answer "did this anchor
    // already land?" it passes `existsCheck`, consulted BEFORE every attempt
    // (attempt 0 too, closing the lost-ACK-from-a-previous-flush window) and
    // POLLED after an ambiguous send error before giving up.
    //
    // existsCheck() contract: resolves { exists: true, txid } when a matching
    // anchor is already on-chain (any depth), a falsy value when definitively
    // absent from the mined view, and THROWS when it cannot determine (indexer
    // unreachable / not wired).
    //
    // Rules:
    //   - existsCheck says exists        -> adopt it; never re-broadcast.
    //   - definitive pre-send/reject err -> safe: retry with a fresh PSBT.
    //   - ambiguous send err (tagged `anchorAmbiguousSend` by _defaultBroadcast)
    //     -> the tx may sit in the DOGE mempool where the indexer cannot see it
    //     yet; poll existsCheck briefly, then DEFER (throw) instead of
    //     re-broadcasting. The row stays pending; the next flush's pre-broadcast
    //     existence check settles it once mined (adopt) or confirms absence
    //     (safe re-broadcast). Same defer-over-risk choice AttestationPublisher
    //     makes when its indexer is unreachable.
    async _broadcastWithRetry(broadcaster, payload, attempts, existsCheck){
        attempts = attempts || 5;
        // flush() checks the pause + per-window
        // ceiling ONCE, but a single flush broadcasts N times (one per pending
        // checkpoint plus one per archive chunk), each recording a spend. Re-gate
        // per broadcast here so the ceiling and the runtime pause bind every send,
        // not just the first: once record() has consumed the window budget an
        // exhausted ceiling stops the remaining sends (fail-closed, like the sibling
        // AttestationPublisher which gates allow() immediately before each send).
        // Retries of the SAME payload do not re-consume (record() only fires on a
        // successful fresh send below), so gating once at entry is per row/chunk.
        if(this.spendGuard.isPaused()){
            let err = new Error(this.spendGuard.noteBlocked() + '; skipping remaining broadcasts this flush');
            err.spendBlocked = true;
            throw err;
        }
        if(!this.spendGuard.allow()){
            let err = new Error(this.spendGuard.noteBlocked() + '; skipping remaining broadcasts this flush (per-send ceiling)');
            err.spendBlocked = true;
            throw err;
        }
        let lastErr = null;
        for(let attempt = 0; attempt < attempts; attempt++){
            if(attempt > 0) await new Promise(r => setTimeout(r, this.chunkRetryDelayMs));
            if(existsCheck){
                let found;
                try { found = await existsCheck(); }
                catch(e){ found = undefined; }   // undetermined
                if(found && found.exists){
                    console.log('StateAnchorPublisher: anchor already on-chain (txid ' +
                                (found.txid || '?') + '); adopting instead of re-broadcasting');
                    return found;
                }
                // Undetermined + a send may already have gone out: never risk it.
                if(found === undefined && lastErr && lastErr.anchorAmbiguousSend) throw lastErr;
            }
            try {
                let sent = await broadcaster(payload);
                // A fresh broadcast actually spent a fee; charge the window
                // budget. The adopt paths above (existsCheck hit) return an already
                // on-chain tx and deliberately do NOT record (no new spend).
                this.spendGuard.record();
                return sent;
            }
            catch(e){
                lastErr = e;
                // No confirmed input to build from. Pre-send, nothing was signed or
                // sent, and a 2.5 s retry cannot confirm an output; surface it as the
                // deferral it is instead of burning the attempt budget on it.
                if(e && e.anchorNoConfirmedUtxo) throw e;
                if(e && e.anchorAmbiguousSend){
                    // The send may have been accepted; give the anchor a bounded
                    // window to reach the indexer's mined view, then defer.
                    if(existsCheck){
                        for(let p = 0; p < this.ambiguousPollAttempts; p++){
                            await new Promise(r => setTimeout(r, this.ambiguousPollDelayMs));
                            let found = null;
                            try { found = await existsCheck(); } catch(_e){ found = null; }
                            if(found && found.exists){
                                console.log('StateAnchorPublisher: ambiguous send confirmed on-chain (txid ' +
                                            (found.txid || '?') + '); adopting');
                                return found;
                            }
                        }
                    }
                    throw e;   // defer to a later flush; never rebuild+re-broadcast
                }
            }
        }
        throw lastErr || new Error('broadcast failed');
    }

    // ----- Landing: confirmation watchdog over our own broadcasts -----

    _startConfirmationWatchdog(){
        if(this._confirmTimer) return;
        if(!this.confirmCheckIntervalMs) return;
        this._confirmTimer = setInterval(() => {
            this._checkPublishedConfirmations().catch(e =>
                console.warn('StateAnchorPublisher: confirmation watchdog tick failed: ' + (e && e.message)));
        }, this.confirmCheckIntervalMs);
        if(this._confirmTimer.unref) this._confirmTimer.unref();
    }

    // Record a broadcast as awaiting confirmation. A broadcaster that returns no
    // txid cannot be watched, so it is not tracked: an untrackable send must not
    // masquerade as a stalled one. Adopted (already-mined) anchors are not sent here.
    _notePendingConfirmation(kind, txid, ref){
        if(!txid) return;
        let key = String(txid).toLowerCase();
        if(this._pendingConfirmations.has(key)) return;
        this._pendingConfirmations.set(key, { txid: key, kind: kind, ref: ref, sentAt: Date.now() });
        while(this._pendingConfirmations.size > this.pendingConfirmationsMax){
            let oldest = this._pendingConfirmations.keys().next().value;
            this._pendingConfirmations.delete(oldest);
        }
    }

    // One watchdog pass. Resolves what has landed and leaves the rest ageing.
    // Two shapes count as landed, because the publisher spends only its own address:
    //   - the transaction's own change output is in the set at depth 1 or deeper
    //   - the transaction is absent from the set while some output IS confirmed: its
    //     change was spent by a descendant, and a confirmed output at this address
    //     cannot descend from an unmined ancestor
    // Everything else stays pending, which is exactly the stuck case. Fail soft end
    // to end: nothing here throws, blocks publishing, re-broadcasts, or spends.
    async _checkPublishedConfirmations(){
        if(this._pendingConfirmations.size === 0) return;
        let summary = null;
        try { summary = await this._readUtxoReserve(); } catch(e){ summary = null; }
        if(!summary || !summary.known){ this.confirmationCheckFailures++; return; }
        this.lastConfirmationCheckAt = Date.now();
        for(let entry of Array.from(this._pendingConfirmations.values())){
            let depth = summary.byTxid.get(entry.txid);
            if(depth !== undefined){
                if(depth >= 1){ this._pendingConfirmations.delete(entry.txid); this.confirmedPublishes++; }
                continue;
            }
            if(summary.confirmed > 0){ this._pendingConfirmations.delete(entry.txid); this.confirmedPublishes++; }
        }
        let oldest = this.oldestUnconfirmedPublish();
        if(oldest && oldest.ageMs >= this.confirmStaleMs){
            console.warn('StateAnchorPublisher: UNCONFIRMED_ANCHOR - ' + this._pendingConfirmations.size +
                         ' broadcast(s) have never been seen confirmed; oldest is ' + oldest.kind + ' ' + oldest.ref +
                         ' txid ' + oldest.txid + ' sent ' + Math.round(oldest.ageMs / 1000) + 's ago. ' +
                         'The publisher address holds ' + summary.confirmed + ' confirmed and ' +
                         summary.unconfirmed + ' unconfirmed output(s). Nothing is re-broadcast or fee-bumped ' +
                         'automatically; an operator decides how to unstick the transaction.');
        }
    }

    // The oldest broadcast still awaiting confirmation, or null. Cheap, in-memory,
    // and safe to call from getAnchorStats.
    oldestUnconfirmedPublish(){
        let oldest = null;
        for(let entry of this._pendingConfirmations.values()){
            if(!oldest || entry.sentAt < oldest.sentAt) oldest = entry;
        }
        if(!oldest) return null;
        return { txid: oldest.txid, kind: oldest.kind, ref: oldest.ref, sentAt: oldest.sentAt,
                 ageMs: Math.max(0, Date.now() - oldest.sentAt) };
    }

    // Classify a broadcast_tx failure: could the transaction have reached the
    // DOGE node despite the error? Definitive rejections (the encoder answered
    // with an RPC error, or an HTTP 4xx auth/rate-limit refusal) and
    // never-connected transport errors are safe to retry. Everything else
    // (timeout, reset mid-flight, 5xx after the request went out) is ambiguous.
    // Delegates to the shared classifier so all four hub effectors agree.
    _isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    }

    async _defaultBroadcast(payload, signer, opts){
        signer = signer || this._resolveSigner();
        if(!signer.encoder)      throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!signer.walletSignFn) throw new Error('no wallet sign hook configured');
        if(!this.dogeAddress)    throw new Error('no DOGE_ADDRESS configured');
        let allowUnconfirmed = this.allowUnconfirmedInputs || !!(opts && opts.allowUnconfirmed);
        let utxos = await signer.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0)) throw new Error('no UTXOs available for ' + this.dogeAddress);
        // Per-broadcast confirmed-input check, BEFORE anything is built or signed.
        // The flush-level gate saw the wallet before this pass started spending;
        // several anchors go out back-to-back from one wallet, and the last
        // confirmed output can be gone by the second one. Typed so the caller can
        // treat it as a deferral rather than a failed publish.
        if(!allowUnconfirmed && Array.isArray(utxos)){
            let summary = summarizeUtxoConfirmations(utxos, 1);
            this.lastUtxoReserve = { total: summary.total, confirmed: summary.confirmed,
                                     unconfirmed: summary.unconfirmed, known: summary.known, at: summary.at };
            if(summary.known && summary.total > 0 && summary.confirmed === 0){
                let e = new Error('NO_CONFIRMED_UTXO: every spendable output at ' + this.dogeAddress + ' is unconfirmed');
                e.anchorNoConfirmedUtxo = true;
                throw e;
            }
        }
        // utxos forwarded only while inside the encoder's caller-facing
        // MAX_UTXO_COUNT; past it the param is omitted so the encoder selects from
        // its own uncapped fetch of this same address (lib/encoder_utxo_forward.js).
        let psbtResult = await signer.encoder.createTx({
            utxos: forwardableUtxos(utxos, 'StateAnchorPublisher'), pubkey: this.dogeAddress, data: payload, change: this.dogeAddress, encoding: 'P2SH',
            // See allowUnconfirmedInputs in the constructor: each anchor stands on its
            // own fee rate, so the encoder must not fund it from mempool change.
            unconfirmed: allowUnconfirmed
        });
        if(!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        // Refuse phase 1 of a two-transaction encoding before anything is signed: this
        // pipeline has no reveal, so broadcasting the P2SH funding tx would publish an
        // ANCHOR no indexer can decode and strand the carrier value (lib/two_phase_guard.js).
        assertSingleTxEncoding(psbtResult, 'StateAnchorPublisher');
        let txHex = await signer.walletSignFn(psbtResult.psbt);
        if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        // Everything above is pre-send (building/signing; no money has moved).
        // Only broadcast_tx has a side effect, so only ITS failures get the
        // ambiguity classification _broadcastWithRetry keys the no-double-
        // broadcast guard on.
        try {
            return (await signer.encoder.broadcastTx(txHex)) || { txid: null };
        } catch(e){
            if(this._isAmbiguousSendError(e)) e.anchorAmbiguousSend = true;
            throw e;
        }
    }

    // Existence check for a CHECKPOINT anchor (v0/v3/v4/v5): asks our own
    // DOGE indexer whether this checkpoint already has a mined, non-invalid
    // anchor. Returns { exists: true, txid } / null (definitively absent);
    // THROWS when undetermined (no indexer wired, unreachable, error reply), so
    // _broadcastWithRetry can distinguish "absent" from "can't tell". Any depth
    // counts: even a 1-conf anchor spent our DOGE, so re-broadcasting would
    // double-spend regardless of whether it is deep enough to 'verify' yet.
    //
    // getanchoraction does NOT serve checkpoint anchors only. Its
    // CHECKPOINT_VERSIONS set (indexer anchor-action-query.js: [0,1,3,4,5,6])
    // carries the v1/v6 ARCHIVE HEADS as well, and an archive head wraps a
    // checkpoint under the SAME (chain, network, block_index, checkpoint_seq)
    // identity it is keyed on, so an UNFILTERED lookup answers with whichever
    // row landed at the higher action_index. Adopting an archive head as this
    // checkpoint's anchor stamps the archive txid, skips the real v4/v5 publish
    // and the reward derived from it, and satisfies the anchor cadence with the
    // wrong artifact on every hub that flushes after the head lands.
    //
    // An archive-head answer is not "absent" either: a real checkpoint anchor
    // can sit BENEATH it at a lower action_index, and calling that absent
    // re-broadcasts and double-spends. So narrow with the RPC's exact-version
    // filter (the same one _verifyAnchorOnChain binds) across the checkpoint
    // versions and decide on that, rather than on the unfiltered top row.
    // (The archive path has no such query surface, so it pairs the
    // ambiguous-error defer with its own durable marker,
    // anchor_published_archives, instead of a mined lookup.)
    async _findExistingCheckpointAnchor(row){
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url) throw new Error('no DOGE indexer wired');
        // ANCHOR versions carrying an archive batch (v1/v6 head, v2 continuation
        // chunk) and the ones that really anchor a checkpoint. Mirrors the
        // rejectVersions/{0,3,4,5} split the receiver paths already use.
        const ARCHIVE_VERSIONS    = [1, 2, 6];
        const CHECKPOINT_VERSIONS = [0, 3, 4, 5];
        let ask = async (version) => {
            let params = {
                chain: String(row.chain), network: String(row.network),
                block_index: Number(row.block_index), checkpoint_seq: Number(row.checkpoint_seq)
            };
            if(version != null) params.version = Number(version);
            let r = await this._indexerCall('DOGE', 'getanchoraction', params);
            if(!r || r.error) throw new Error('getanchoraction failed: ' + (r && r.error));
            return r;
        };
        // A decoded-invalid row never anchored the checkpoint; treat as absent
        // (our own payloads are built from the quorum row, so this is a peer's
        // malformed tx, not our lost ACK).
        let usable = (r) => !!(r && r.exists && !/^invalid/i.test(String(r.status || '')));
        let res = await ask(null);
        if(!res.exists) return null;
        // An indexer too old to report `version` answers NaN here, which is not an
        // archive version, so it keeps the pre-filter behavior rather than
        // fanning out four lookups it would answer identically.
        if(ARCHIVE_VERSIONS.includes(Number(res.version))){
            for(let v of CHECKPOINT_VERSIONS){
                let r = await ask(v);          // throws (undetermined) exactly as the unfiltered call does
                // FAIL CLOSED against an indexer that ignores the version param: it
                // would answer every one of these with the same archive head, and
                // accepting that is the adoption this whole branch exists to stop.
                // Undetermined (throw), never "absent": a false absent re-broadcasts,
                // and it would also drop _broadcastWithRetry's ambiguous-send defer.
                if(r && r.exists && Number(r.version) !== Number(v))
                    throw new Error('getanchoraction ignored the version filter (asked v' + v +
                                    ', answered v' + r.version + '); cannot rule out an existing anchor');
                if(usable(r)) return { exists: true, txid: r.txid || null };
            }
            return null;
        }
        if(!usable(res)) return null;
        return { exists: true, txid: res.txid || null };
    }

    // CONTENT-ADDRESSED existence check for an ARCHIVE anchor (v1/v6 head + its v2
    // chunks), the archive-path sibling of _findExistingCheckpointAnchor above.
    //
    // The archive path publishes BEFORE it records: _publishArchive broadcasts the head
    // and every continuation chunk, and only then does _backfillBatch stamp the rows. A
    // crash in that window leaves the rows pending, so the next flush re-elects exactly
    // the same matches and pays for the whole archive a second time. The checkpoint
    // path's guard could not be reused, because the identity every archive read is keyed
    // on (match_batch_seq) is precisely what the restart does not preserve:
    // _getNextBatchSeq is MAX(batch_seq)+1 fleet-wide, so a peer that archived in the
    // meantime moves the seq, and the re-election publishes the identical bytes under a
    // number nothing on-chain carries.
    //
    // getarchiveanchor is keyed on what the batch IS instead: the checkpoint identity
    // it wraps plus the batch's own content commitment (batch_crc32 + match_count),
    // which the publisher signs into the v1 canonical and can therefore recompute after
    // the restart. Scoped to OUR DOGE address, so the answer only ever covers spends
    // this publisher made: unscoped, anyone who copied our mined head onto the chain
    // would answer "already published" for a batch whose chunks they never sent, and we
    // would skip our own head and strand the archive.
    //
    // Returns the usable response, or null when this batch is definitively not on-chain
    // under our address. THROWS when undetermined (no indexer wired, unreachable, error
    // reply, or an indexer too old to serve the method), so _broadcastWithRetry keeps
    // its "absent" / "can't tell" distinction: an un-upgraded indexer therefore degrades
    // to exactly today's behavior (publish) rather than blocking the archive.
    async _archiveAnchorLookup(cp, round){
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url)    throw new Error('no DOGE indexer wired');
        if(!this.dogeAddress) throw new Error('no DOGE_ADDRESS configured');
        let res = await this._indexerCall('DOGE', 'getarchiveanchor', {
            chain: String(cp.chain), network: String(cp.network),
            block_index: Number(cp.block_index), checkpoint_seq: Number(cp.checkpoint_seq),
            batch_crc32: String(round.crc).toLowerCase(),
            match_count: Number(round.count),
            author: String(this.dogeAddress)
        });
        if(!res || res.error) throw new Error('getarchiveanchor failed: ' + (res && res.error));
        if(!res.exists) return null;
        // A decoded-invalid head anchored nothing, so it is not an archive we can adopt
        // or attach chunks to. Same verdict as the checkpoint path.
        if(/^invalid/i.test(String(res.status || ''))) return null;
        // Adopting needs a txid: it is what _backfillBatch stamps and what the FINALIZED
        // announcement carries, and a null txid drives the '__partial__' sentinel, which
        // would leave the rows pending and adopt the same txid-less head again every
        // flush (a livelock, not a saving). Treat it as absent and republish instead.
        if(!res.txid){
            console.warn('StateAnchorPublisher: archive head for batch crc ' + round.crc +
                         ' is on-chain but carries no resolvable txid; treating as absent');
            return null;
        }
        // Chunk geometry must match ours byte-for-byte before we attach to, or adopt,
        // that head: an identical archive split into a different number of chunks (a
        // changed chunk size across the restart) would make our chunk bytes land in
        // slots the head never declared, and the batch would fail reassembly on-chain.
        if(Number(res.total_chunks) !== Number(round.chunks.length)){
            console.warn('StateAnchorPublisher: archive head for batch crc ' + round.crc + ' declares ' +
                         res.total_chunks + ' chunk(s) but this round built ' + round.chunks.length +
                         '; not adopting (republishing the batch whole)');
            return null;
        }
        if(res.match_batch_seq == null) return null;
        return res;
    }

    // existsCheck for the ARCHIVE HEAD broadcast (v1/v6). The head landing is the spend
    // this guard exists to make at-most-once; the chunk-level check below covers the
    // rest of the batch. `archiveAnchor` rides along on the adopt result so
    // _publishArchive can address the remaining chunk slots under the seq the batch
    // actually landed under, which this process no longer knows.
    async _findExistingArchiveAnchor(cp, round){
        let res = await this._archiveAnchorLookup(cp, round);
        if(!res) return null;
        return { exists: true, txid: res.txid || null, archiveAnchor: res };
    }

    // existsCheck for ONE v2 continuation chunk. A crash can land the head and some of
    // its chunks, so per-chunk resolution is what makes the resume cheap: without it the
    // only choices are re-sending every chunk (paying again for the ones that landed) or
    // skipping the batch (stranding it). An absent head answers "chunk absent", which is
    // right in both directions: on a fresh publish the head is still in the mempool and
    // every chunk must go out, and with no head there is nothing for a chunk to attach to.
    async _findExistingArchiveChunk(cp, round, chunkIndex){
        let res = await this._archiveAnchorLookup(cp, round);
        if(!res) return null;
        let present = Array.isArray(res.chunks_present) ? res.chunks_present.map(Number) : [];
        if(!present.includes(Number(chunkIndex))) return null;
        return { exists: true, txid: res.txid || null };
    }

    // Durable at-most-once for the anchor spend (anchor_published_checkpoints).
    //
    // The existence check above closes a lost ACK only where it can SEE the earlier send,
    // and getanchoraction resolves a txid through mined blocks, so an anchor sitting in
    // the DOGE mempool reads as DEFINITIVELY ABSENT. Everything else that knows a send
    // went out is in memory (_broadcastWithRetry's lastErr / ambiguous-poll loop) and
    // `anchor_txid` is stamped only after the broadcast returns. A crash in between
    // therefore leaves the row still matching the `anchor_txid IS NULL` selector with
    // nothing anywhere recording that DOGE already paid, and the next flush rebuilds a
    // FRESH PSBT from different UTXOs: a second fee, and two anchors that can both
    // confirm.
    //
    // These four methods are the restart-surviving half, ported from the three sibling
    // effectors that already carry it (OraclePublisher's oracle_published_rounds,
    // AttestationPublisher's attest_published_requests, AttestationRelay's
    // WAL). Intent is armed before the send, confirmed after it, and withdrawn when the
    // send definitively never went out; a surviving intent HOLDS the row rather than
    // re-broadcasting.
    //
    // Two deliberate choices. It does not re-broadcast the earlier bytes: that turns on
    // how this encoder classifies a duplicate submission, which is not established here,
    // and holding costs latency where guessing costs money. And the hold is bounded by
    // anchorIntentTtlMs, because an unbounded marker for a never-mined tx would suppress
    // a needed re-anchor forever, which is the failure the announcement queues above are
    // TTL-bounded for as well.

    // Read the durable marker for a checkpoint, or null when none exists. Throws on a DB
    // error so the caller FAILS CLOSED (the row stays pending) rather than spending on a
    // checkpoint whose publish history it could not read.
    async _getAnchorIntent(row){
        let rows = await this.db.doQuery(
            'SELECT chain, network, checkpoint_seq, txid, intent_at, sent_at FROM anchor_published_checkpoints ' +
            'WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
            [row.chain, row.network, Number(row.checkpoint_seq)]);
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    // Does this marker still cover a send that might be live? Measured from intent_at,
    // which is written BEFORE the broadcast, so the window starts at the earliest moment
    // money could have moved. An unreadable stamp holds (fail closed): the TTL is a
    // liveness bound, not a licence to spend.
    _anchorIntentHolds(marker){
        if(!marker) return false;
        let at = marker.intent_at ? new Date(marker.intent_at).getTime() : NaN;
        if(!Number.isFinite(at)) return true;
        return (Date.now() - at) < this.anchorIntentTtlMs;
    }

    // Durably arm broadcast intent before the send. Re-arming refreshes the window
    // rather than leaving the row untouched: the caller reaches this only when no
    // unexpired intent holds the checkpoint AND `anchor_txid` is still NULL, so the
    // marker being overwritten is an expired one and the write is this retry opening its
    // own window. Throws on a DB error so the caller fails closed.
    async _recordAnchorIntent(row){
        await this.db.doQuery(
            'INSERT INTO anchor_published_checkpoints (chain, network, checkpoint_seq) VALUES (?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE intent_at = CURRENT_TIMESTAMP, sent_at = NULL, txid = NULL',
            [row.chain, row.network, Number(row.checkpoint_seq)]);
    }

    // Record that the broadcast returned a txid. Logged, never thrown: the DOGE fee is
    // already spent, and the surviving intent-only row makes the next flush HOLD instead
    // of re-broadcasting, which is the fail-safe direction.
    async _markAnchorSent(row, txid){
        try {
            await this.db.doQuery(
                'UPDATE anchor_published_checkpoints SET txid = ?, sent_at = NOW() ' +
                'WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
                [txid || null, row.chain, row.network, Number(row.checkpoint_seq)]);
        } catch(e){
            console.error('StateAnchorPublisher: anchor for ' + row.chain + '/' + row.network + ' @ ' +
                          row.block_index + ' broadcast as ' + txid + ' but its durable sent marker could not be ' +
                          'persisted; the intent still holds the row, so nothing re-broadcasts. Error:', e && e.message);
        }
    }

    // Withdraw an intent for a send that DEFINITIVELY never went out (a pre-send build,
    // sign, ceiling or RPC-rejection failure). Without this a routine failure would hold
    // the checkpoint for the whole TTL, which is worse than the replay risk the marker
    // exists for. Scoped `AND sent_at IS NULL` so a confirmed marker can never be deleted
    // by a late or misordered call. Logged, never thrown: leaving the row is fail-closed.
    async _withdrawAnchorIntent(row){
        try {
            await this.db.doQuery(
                'DELETE FROM anchor_published_checkpoints ' +
                'WHERE chain = ? AND network = ? AND checkpoint_seq = ? AND sent_at IS NULL',
                [row.chain, row.network, Number(row.checkpoint_seq)]);
        } catch(e){
            console.warn('StateAnchorPublisher: could not withdraw the broadcast intent for ' + row.chain + '/' +
                         row.network + ' @ ' + row.block_index + '; it will hold the row until the TTL expires: ' +
                         (e && e.message));
        }
    }

    // Durable at-most-once for the ARCHIVE spend (anchor_published_archives).
    //
    // Same failure and the same remedy as the checkpoint marker above, with one
    // structural difference that changes the key. A checkpoint is re-selected under its
    // OWN identity (chain, network, checkpoint_seq) after a crash, so its marker can be
    // read by that identity. An archive is not: the rows re-select as "pending" and the
    // rebuild draws a FRESH batch_seq (two v1 anchors sharing one seq corrupt chunk
    // reassembly), so a marker read by batch_seq could never match the round it has to
    // stop. The hold is therefore per-NETWORK over any UNSETTLED intent, and settled_at
    // is what keeps a finished round from blocking the next one.
    //
    // The archive path DOES have a mined-state fallback, just not through
    // getanchoraction, which serves CHECKPOINT_VERSIONS only. getarchiveanchor answers
    // "did we already publish THIS batch" from the batch's own content (checkpoint
    // identity + crc + count + author), and _publishArchive passes it to
    // _broadcastWithRetry as the head's existsCheck via _findExistingArchiveAnchor, plus
    // _findExistingArchiveChunk per continuation chunk. What that lookup cannot see is a
    // send that has not mined yet: it answers from parsed on-chain actions, so an archive
    // still in the DOGE mempool reads as definitively absent. This marker covers exactly
    // that window, together with the ambiguous-send defer, and it is read before the
    // batch seq is even drawn, which is why the hold is unconditional within the TTL
    // rather than conditional on a mined lookup.

    // Read the newest unsettled marker for a network, or null when none exists. Throws on
    // a DB error so the caller FAILS CLOSED (rows stay pending) rather than spending on a
    // batch whose publish history it could not read.
    async _getLiveArchiveIntent(network){
        let rows = await this.db.doQuery(
            'SELECT network, batch_seq, txid, intent_at, sent_at FROM anchor_published_archives ' +
            'WHERE network = ? AND settled_at IS NULL ORDER BY intent_at DESC LIMIT 1',
            [String(network)]);
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    // Durably arm archive-broadcast intent before the v1 send. The upsert form matches the
    // checkpoint twin: the caller reaches this only when no unexpired intent holds the
    // network, so an existing row for this seq is a stale one and the write is this round
    // opening its own window. Throws on a DB error so the caller fails closed.
    async _recordArchiveIntent(network, batchSeq){
        await this.db.doQuery(
            'INSERT INTO anchor_published_archives (network, batch_seq) VALUES (?, ?) ' +
            'ON DUPLICATE KEY UPDATE intent_at = CURRENT_TIMESTAMP, sent_at = NULL, txid = NULL, settled_at = NULL',
            [String(network), Number(batchSeq)]);
    }

    // Record that the v1 broadcast returned a txid. Logged, never thrown: the DOGE fee is
    // already spent, and an intent-only row left behind makes the next round HOLD instead
    // of re-archiving, which is the fail-safe direction.
    async _markArchiveSent(network, batchSeq, txid){
        try {
            await this.db.doQuery(
                'UPDATE anchor_published_archives SET txid = ?, sent_at = NOW() WHERE network = ? AND batch_seq = ?',
                [txid || null, String(network), Number(batchSeq)]);
        } catch(e){
            console.error('StateAnchorPublisher: archive batch ' + batchSeq + ' broadcast as ' + txid +
                          ' but its durable sent marker could not be persisted; the intent still holds the ' +
                          'network, so nothing re-archives. Error:', e && e.message);
        }
    }

    // Close the window once the round's bookkeeping has landed, so the next round is not
    // blocked for the full TTL by a batch that completed normally. Scoped `AND sent_at IS
    // NOT NULL` so it can only ever close a marker whose broadcast actually returned.
    // Logged, never thrown: an unsettled marker costs latency (the TTL), never money.
    async _settleArchiveIntent(network, batchSeq){
        try {
            await this.db.doQuery(
                'UPDATE anchor_published_archives SET settled_at = NOW() ' +
                'WHERE network = ? AND batch_seq = ? AND sent_at IS NOT NULL',
                [String(network), Number(batchSeq)]);
        } catch(e){
            console.warn('StateAnchorPublisher: could not settle the archive intent for batch ' + batchSeq +
                         '; it will hold ' + network + ' archiving until the TTL expires: ' + (e && e.message));
        }
    }

    // Withdraw an intent for a v1 send that DEFINITIVELY never went out (a pre-send build,
    // sign, ceiling or RPC-rejection failure). Without this a routine failure would stall
    // archiving for the whole TTL, which is worse than the replay risk the marker exists
    // for. Scoped `AND sent_at IS NULL` so a confirmed marker can never be deleted by a
    // late or misordered call. Logged, never thrown: leaving the row is fail-closed.
    async _withdrawArchiveIntent(network, batchSeq){
        try {
            await this.db.doQuery(
                'DELETE FROM anchor_published_archives WHERE network = ? AND batch_seq = ? AND sent_at IS NULL',
                [String(network), Number(batchSeq)]);
        } catch(e){
            console.warn('StateAnchorPublisher: could not withdraw the archive broadcast intent for batch ' +
                         batchSeq + '; it will hold ' + network + ' archiving until the TTL expires: ' +
                         (e && e.message));
        }
    }

    // ----- Retention for the two anchor marker tables -----
    //
    // Both tables appended one row per DOGE-spending broadcast and removed one only on
    // a definitive pre-send failure (_withdrawAnchorIntent / _withdrawArchiveIntent,
    // both `sent_at IS NULL`), so a confirmed marker persisted for the life of the
    // deployment while the oracle_published_rounds sibling was swept.
    //
    // Two invariants dominate these DELETEs, both load-bearing on a money-bearing path:
    //
    //   1. `sent_at IS NOT NULL` is mandatory. A sent_at NULL row that survived is the
    //      AMBIGUOUS-send record: _publishPendingCheckpoints deliberately keeps the
    //      intent when the failure could have reached the DOGE node (the `if(!(e &&
    //      e.anchorAmbiguousSend))` guard), and the empty-txid path keeps it too. That
    //      row is the only durable trace that DOGE may already have paid, so it is
    //      retained forever regardless of age, exactly as the oracle sibling retains
    //      its quarantine rows.
    //   2. The cutoff never rises above `now - anchorIntentTtlMs`. This is the
    //      re-presentability floor and it is exact rather than estimated, because the
    //      TTL is the SAME quantity the read paths already measure. Every read of
    //      either table goes through _anchorIntentHolds, which is false for any marker
    //      whose intent_at is older than the TTL, so a row this DELETE can reach is one
    //      that already changes no decision. anchor_published_archives is stricter
    //      still: _getLiveArchiveIntent only ever selects `settled_at IS NULL`, so a
    //      settled row is not read at all.
    //
    // The cutoff is measured on intent_at, not sent_at, because intent_at is the column
    // _anchorIntentHolds measures and the one the floor is expressed in.
    //
    // Returns the total number of rows deleted across both tables. Throws on a DB
    // error; the caller treats a retention failure as non-fatal.
    async _pruneAnchorMarkers(){
        if(!this.db) return 0;
        if(!this.anchorMarkerRetentionMs || this.anchorMarkerRetentionMs <= 0) return 0;

        // Invariant 2, as a hard clamp rather than a warning: an anchor marker pruned
        // inside the hold window lets the next flush rebuild a second PSBT for a
        // checkpoint DOGE may already have paid for.
        let ttlFloorMs = (Number.isFinite(this.anchorIntentTtlMs) && this.anchorIntentTtlMs > 0)
            ? this.anchorIntentTtlMs * ANCHOR_MARKER_RETENTION_TTL_SAFETY
            : 0;
        let windowSec = Math.ceil(Math.max(this.anchorMarkerRetentionMs, ttlFloorMs) / 1000);

        // DB-clock arithmetic on both sides: intent_at is written by CURRENT_TIMESTAMP,
        // so a Node-side cutoff would fold host/DB clock skew into the window.
        let deleted = 0;
        for(let table of ['anchor_published_checkpoints', 'anchor_published_archives']){
            let res = await this.db.doQuery(
                'DELETE FROM ' + table + ' WHERE sent_at IS NOT NULL ' +
                'AND intent_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
                [windowSec]);
            deleted += (res && res.affectedRows) ? Number(res.affectedRows) : 0;
        }
        if(deleted > 0){
            this.anchorMarkersPruned += deleted;
            console.log('StateAnchorPublisher: anchor-marker retention pruned ' + deleted +
                        ' confirmed marker row(s) older than ' + windowSec + 's (intent-only rows, which are ' +
                        'the ambiguous-send record, are never pruned)');
        }
        return deleted;
    }

    // Housekeeping hook for the retention sweep. Fire-and-forget with the rejection
    // swallowed: bounding the marker tables must never stall, fail or retry a flush
    // that has already spent DOGE.
    _sweepAnchorMarkerRetention(){
        if(!this.db || !this.anchorMarkerRetentionMs) return;
        this._retentionSweep = this._pruneAnchorMarkers()
            .catch(e => {
                console.warn('StateAnchorPublisher: anchor-marker retention sweep failed ' +
                             '(the marker tables keep growing until it succeeds): ' + (e && e.message));
                return 0;
            });
    }

    async _checkBalance(signer){
        let balance = null;
        try {
            if(signer.getBalanceFn) balance = await signer.getBalanceFn();
            else if(signer.encoder && this.dogeAddress){
                // get_utxos reports satoshis; lowBalanceThreshold, the fail-closed
                // flush gate and spendGuard.minBalance are all whole DOGE, so the
                // sum converts. Units and fallback order: lib/utxo_balance.js.
                let utxos = await signer.encoder.getUtxos(this.dogeAddress);
                if(Array.isArray(utxos)) balance = sumUtxosCoins(utxos);
            }
        } catch(e){ return null; }
        if(balance !== null){
            this._lastBalance   = balance;
            this._lastBalanceAt = Date.now();
        }
        if(balance !== null && balance < this.lowBalanceThreshold)
            console.warn('StateAnchorPublisher: DOGE balance LOW (' + Number(balance).toFixed(4) + ' DOGE)');
        return balance;
    }
}

module.exports = StateAnchorPublisher;
module.exports.XANC_SIGN_REQ  = XANC_SIGN_REQ;
module.exports.XANC_SIGN      = XANC_SIGN;
module.exports.XANC_FINALIZED = XANC_FINALIZED;
module.exports.XANC_V0_DONE   = XANC_V0_DONE;
module.exports.XANCPUB_SIGN_REQ = XANCPUB_SIGN_REQ;
module.exports.XANCPUB_SIGN     = XANCPUB_SIGN;
module.exports.XANCARCHPUB_SIGN_REQ = XANCARCHPUB_SIGN_REQ;
module.exports.XANCARCHPUB_SIGN     = XANCARCHPUB_SIGN;
module.exports.XANCREWARD           = XANCREWARD;
module.exports.MATCH_KEYS     = MATCH_KEYS;
