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
 *   ANCHOR v0: ONE bundle per network per cycle carrying every chain's latest
 *               quorum-signed state checkpoint as a SECTION (signatures come
 *               straight from state_checkpoints; no new signing round).
 *   ANCHOR v1: a checkpoint + a compressed archive of full cross_chain_matches
 *               rows (incl. their validator_signatures + the cross_chain
 *               capability_snapshots needed to re-verify them). This is what
 *               makes cross-chain match data recoverable from a full chain
 *               parse with no surviving hub DB.
 *   ANCHOR v2: continuation chunks when a v1 archive exceeds the per-action
 *               data budget.
 *
 * The version set RESTARTED at 0 pre-launch (spec anchor-v0-single-wire.md): the
 * whole legacy range is unparseable at/above ANCHOR_ACTIVATION, so no number below
 * carries meaning any more and the three wires above are the complete set. The
 * pre-restart shapes these two came from (the v7 bundle and the v6 archive head)
 * survive only in this file's method names, which are seams the suites drive.
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
 * BUNDLE elects ONE publisher (oracle_publish validators at the bundle's
 * snapshot_block ordered by SHA256(election key ‖ pubkey)
 * ascending, where the key binds network/snapshot_block). Rank 0
 * publishes; if it hasn't after ANCHOR_ELECTION_TOLERANCE_BLOCKS BTC blocks,
 * rank 1 also qualifies, and so on (the DB row's anchor_txid IS NULL is the
 * shared "still pending" signal, so a late rank-0 and an early rank-1 can both
 * publish). The on-chain state never diverges: both build byte-identical
 * commitments, and the anchor-reward rail does NOT inflate: recordAnchorReward
 * deterministically keeps a single reward per (checkpoint_seq, reward_type)
 * across distinct publisher pubkeys (see below), so the only residual cost of
 * the race is the duplicate DOGE tx fee. One validator publishes the whole
 * bundle in a cycle, FROM ITS OWN DOGE WALLET, and the election rotates that
 * work across the federation cycle by cycle. Each successful publish records an
 * `anchor_bundle` / `anchor_archive` reward on the validator_rewards rail (oracle-round
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
const { resolveCheckpointIntervalBlocks } = require('./lib/checkpoint_cadence.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const StateCheckpointEngine = require('./StateCheckpointEngine.js');
const swq                   = require('./stake_weighted_quorum.js');
const eq                    = require('./equivocation_header.js');
const ckpt                  = require('./checkpoint_commitment_activation.js');
const ccr                   = require('./cross_chain_royalty_activation.js');
const ar                    = require('./anchor_reward_activation.js');
const ark                   = require('./anchor_reward_key.js');

const XANC_SIGN_REQ  = 'XANC_SIGN_REQ';
const XANC_SIGN      = 'XANC_SIGN';
const XANC_FINALIZED = 'XANC_FINALIZED';
const XANC_BUNDLE_DONE = 'XANC_BUNDLE_DONE';
// Publisher-attestation round (anchor-reward re-derivation flag-day): the elected
// bundle publisher collects a 2f+1 oracle_publish quorum ATTESTING that it is the
// legitimate reward earner, carried on-chain in the ANCHOR v0 tail so the indexer
// DERIVES the reward instead of trusting the forgeable push. Mirrors XANC_SIGN_REQ/SIGN.
const XANCPUB_SIGN_REQ = 'XANCPUB_SIGN_REQ';
const XANCPUB_SIGN     = 'XANCPUB_SIGN';

// Archive publisher-attestation round (archive-reward re-derivation flag-day):
// the elected ARCHIVE leader collects a 2f+1 oracle_publish quorum attesting that it is
// the anchor_archive reward earner, carried on-chain in the ANCHOR v1 tail so the indexer DERIVES
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

// The hard on-chain ceiling on one action's data, from
// xchain-documentation/protocol/constants.js. The DECODER is the arbiter and silently
// DROPS a larger action, so an oversize bundle is lost fleet-wide rather than rejected
// loudly. Local copy so the hub can measure without a sibling checkout.
const MAX_ACTION_DATA_LENGTH = 8192;
// The encoder compiles the raw payload text into a push whose prefix costs 3 bytes
// (xchain-encoder/src/validator.js), so compiled size IS raw text + 3.
const OP_RETURN_PUSH_OVERHEAD = 3;
// The byte budget a v0 bundle's raw text must stay within (D10). Overflow is SPLIT
// chain-ascending, never dropped; a single section that cannot fit with the attestation
// tail its bundle will carry is refused loudly and counted (bundlesOversize).
const ANCHOR_BUNDLE_MAX_BYTES = MAX_ACTION_DATA_LENGTH - OP_RETURN_PUSH_OVERHEAD;   // 8189
// Wire cost of one (PUBKEY, SIG) pair: '|' + 64-hex pubkey + '|' + 128-hex Ed25519
// signature. Fixed width, which is what lets the split arithmetic size an attestation
// tail before the round that fills it has run.
const ANCHOR_SIG_PAIR_BYTES = 1 + 64 + 1 + 128;   // 194

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

// Parse an RFC 7231 Retry-After value to milliseconds, or null when absent or
// unparseable. Both forms are in play: the encoder's per-IP limiter sends
// delta-seconds and a proxy in front of it may rewrite that to an HTTP-date.
// A past date yields 0 (retry now), never a negative wait.
function parseRetryAfterMs(raw){
    if(raw === null || raw === undefined) return null;
    let value = Array.isArray(raw) ? raw[0] : raw;
    let text = String(value).trim();
    if(text === '') return null;
    if(/^\d+$/.test(text)) return Number(text) * 1000;
    let at = Date.parse(text);
    if(Number.isNaN(at)) return null;
    return Math.max(0, at - Date.now());
}

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
        //   rides inside the v1 HEAD next to the checkpoint prefix (four 64-hex
        //   hashes plus the chain/network/seq/index fields, ~322 B at mainnet
        //   heights) and the signature lists, at 194 B per (PUBKEY,SIG) pair; the
        //   publisher tail adds ~67 B for PUBLISHER + ATTEST_SIG_COUNT plus another
        //   194 B per attesting signer. So 8192 - 6000 - 322 leaves ~1870 B of head
        //   budget: about nine signature pairs on a tail-less head, or four wrapper
        //   plus four attestation pairs once the tail is filled. THAT RESERVE is why
        //   the value is 6000 and not something nearer 8000. It binds chunk 0 only (a
        //   v2 continuation carries ~30 B of overhead), but one uniform slice keeps
        //   _splitChunks trivial.
        //   Tuner rule: this is the knob to LOWER when the federation grows. A v1
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
        // Encoder rate-limit (429) waits, which are NOT the transient-failure retry
        // above. The encoder sheds two different ways and both answer 429 + a
        // Retry-After the caller should obey rather than guess: the per-IP limiter
        // (xchain-encoder api.js, 60s window) sends a window-length Retry-After, and
        // the concurrency gate sends Retry-After: 1. A flat chunkRetryDelayMs spends
        // the whole 5-attempt budget in ~10s inside a 60s window while adding load to
        // an already-shedding replica. rateLimitMaxWaitMs caps one honoured wait;
        // rateLimitMaxWaits caps how many a single broadcast may take before the
        // anchor defers to a later flush instead of stalling this one.
        this.rateLimitMaxWaitMs = parseInt(process.env.ANCHOR_RATELIMIT_MAX_WAIT_MS || cfg.ANCHOR_RATELIMIT_MAX_WAIT_MS || '60000');
        this.rateLimitMaxWaits  = parseInt(process.env.ANCHOR_RATELIMIT_MAX_WAITS   || cfg.ANCHOR_RATELIMIT_MAX_WAITS   || '3');
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
        // the on-chain verification wait in _handleBundleDone well inside one rank).
        // Right inequality: ranks 1-3 unlock at ~6/12/18h, so up to three backups
        // still get a slot inside one publishing cycle and a dead rank 0 cannot
        // cost the federation a whole day of anchoring. Anything in ~6..144 blocks
        // (1h..24h) preserves both bounds; below the DOGE burial window it burns
        // DOGE on duplicate anchors, above ~144 a dead leader stalls a cycle.
        // Never a divergence risk in either direction: concurrent unlocked
        // publishers build byte-identical archives (see _rankUnlocked).
        //
        // SCOPE: the ladder above unlocks on the ARCHIVE leg only, whose election
        // anchors to a STALLED batch, so its `since` grows without bound. On the v0
        // CHECKPOINT BUNDLE leg the newest ELIGIBLE checkpoint tracks the live BTC
        // tip, so `since` is bounded by CHECKPOINT_INTERVAL_BLOCKS *
        // ANCHOR_CHECKPOINT_EVERY_N, i.e. 6 at the defaults. Rank 1 needs `since` >=
        // 36, so at the default cadence NO rank above 0 is ever eligible and a bundle
        // has no failover at all; its liveness rests on per-cycle re-election plus
        // each hub's independent 24h timer, and a missed cycle costs one snapshot its
        // own anchor, which the chained hashes recover.
        // The inertness is therefore a property of the CADENCE, not of the ladder:
        // ANCHOR_CHECKPOINT_EVERY_N >= 6 puts the bound at or above 36 and the backup
        // ranks start unlocking here too. Raising that knob is not a cadence-only
        // change; re-read this stanza before doing it.
        // Lowering the tolerance is still not the fix: below the DOGE burial window it
        // buys duplicate spends. A meaningful bundle ladder must measure time or
        // flush attempts, not BTC-block age against a tip-tracking snapshot.
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
        // anchor is stamped by the BUNDLE_DONE drain that runs first inside flush), so
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
        // Bundles held back because the publisher-attestation round did not reach quorum.
        // Climbing while the federation is whole means peers are not co-signing; climbing
        // during a rolling deploy is expected and stops when the roll finishes.
        this.unattestedDeferrals      = 0;
        this.lastUnattestedDeferralAt = null;
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
        // on-chain anchor spends real DOGE. Only anchor every Nth
        // checkpoint (recovery needs just the LATEST anchored checkpoint per chain, so
        // the skipped rounds stay off-chain). N=1 keeps the original
        // anchor-every-checkpoint behaviour.
        //
        // Eligibility is a CHECKPOINT ORDINAL, not the raw seq. checkpoint_seq is the
        // round's BTC snapshot_block (deriveCheckpointSeq), and the cadence latch
        // advances it by exactly CHECKPOINT_INTERVAL_BLOCKS per round
        // (StateCheckpointEngine._tick), so `seq % N` is NOT a 1-in-N sample: it is a
        // residue class pinned by the first checkpoint after the latch is seeded.
        // Whenever N shares a factor with the interval (N=2 or 3 against the default 6)
        // every round lands in the same residue, so the federation either anchors every
        // cadence or anchors NOTHING, permanently and with no eligible row to log about.
        // Dividing by the interval first gives an ordinal that advances by 1 per round,
        // so the residues cycle: the worst case is N-1 rounds of delay, never a halt.
        // Both knobs are already required to be fleet-uniform, and checkpoint_seq is
        // consensus data, so the predicate stays deterministic fleet-wide. At the
        // default N=1 (MOD(anything,1)=0) it is a no-op, exactly as before.
        this.anchorEveryNCheckpoints = Math.max(1,
            parseInt(process.env.ANCHOR_CHECKPOINT_EVERY_N || cfg.ANCHOR_CHECKPOINT_EVERY_N || '1') || 1);
        // The engine's own cadence step (StateCheckpointEngine.js), resolved through the
        // one shared function it also calls so the two cannot drift. Always positive: a
        // zero divisor makes the SQL MOD NULL, which would silently select nothing.
        this.checkpointIntervalBlocks = resolveCheckpointIntervalBlocks(cfg);

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
        // The round whose _publishArchive is IN FLIGHT. _archiveRound covers only the
        // signature-collection phase and is cleared the moment quorum is met, which leaves
        // the whole publish unguarded: quorum can arrive on a peer message (_handleSign),
        // outside flush()'s _flushing mutex, and _publishArchive does not arm its durable
        // dedupe marker (_recordArchiveIntent) until AFTER the publisher-attestation round,
        // so a timer flush in that window rebuilds the same still-pending rows and spends
        // DOGE a second time. This field covers quorum-to-return.
        this._archivePublishing = null;
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
        // Cumulative count of checkpoint BUNDLES successfully published on-chain. The
        // name is a documented RPC field with no consumer outside the hub, so it keeps
        // it and changes what it counts (D13): one v0 per network per cycle, where the
        // retired per-chain wires counted one anchor per chain.
        this._anchorsPublished = 0;
        // Chains carried by those bundles (one per section, so this is the per-chain
        // figure), and bundles REFUSED for exceeding the byte budget with a single
        // section that cannot fit even with a zero-signature tail. Both exist for the
        // operator's post-deploy check, not for a dashboard tile.
        this._sectionsAnchored = 0;
        this._bundlesOversize  = 0;
        // Split of that count by the rank this hub held for the row it anchored.
        // A backup-rank publish means the elected rank-0 publisher did NOT anchor
        // within its ladder step, so the federation is running on failover with
        // reduced anchor redundancy. Undifferentiated, that is invisible: the
        // checkpoints still land on cadence and every staleness/balance term stays
        // green until the backups fail too. Same idea as OraclePublisher's
        // _leaderRounds/_followerRounds on the PRICE rail.
        this._anchorsAsLeader  = 0;
        this._anchorsAsBackup  = 0;
        // Counts bundles STAMPED without paying (the existence check adopted an
        // already-mined one). Kept apart from _anchorsPublished so the leader/backup
        // split keeps summing to the bundles this hub actually spent DOGE on.
        this._anchorsAdopted   = 0;
        // Rank state of the most recent successful anchor, surfaced via
        // getAnchorStats so an operator sees the CURRENT posture, not only a
        // lifetime tally that a long healthy history would dilute.
        this._lastAnchorRank   = null;   // { network, snapshotBlock, chains, myRank, publisherCount, isLeader, at }
        // Cumulative count of candidate checkpoints a flush looked at and stood
        // down from, split by why. Both skips are correct behavior and were silent,
        // which made a federation with ZERO anchors ever published indistinguishable
        // from one with nothing to anchor: every wake walked the same rows and
        // logged nothing. Exposed via getAnchorStats so getanchorstatus answers
        // "is anyone even being asked to publish this?" without a code read.
        //   notOurElection: another hub is the unlocked publisher for the bundle (or
        //                   this hub's backup rank has not unlocked yet)
        //   leaderOnWake:   this hub leads the bundle but the flush was the failover-
        //                   only wake, which never publishes a led election
        // Both count SECTIONS, not bundles, so the operator-facing figure stays "how
        // many pending checkpoints did this flush stand down from".
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
        // flag-day; derived on-chain from the ANCHOR v1 tail at/above it). Identity only,
        // re-SELECTed against our own rows, and evicted in lockstep with the leader map.
        this._observedArchiveCheckpoints = new Map();
        // Archive MEMBERSHIP observed per (batch_seq, proposer), from a SIGN_REQ body
        // this hub decompressed, CRC-checked and byte-verified against its own rows for
        // the co-sign decision. The XANCFIN canonical commits to (batch_seq, txid, match
        // COUNT) and never to WHICH rows, so _handleFinalized holds the announced id
        // lists to this set before anything is stamped. Recorded ONLY where the body was
        // already parsed, so no hub decompresses an extra archive on the p2p path.
        this._observedArchiveContents = new Map();

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
        // per-coin default idiom the cross-chain engines use (floor-clamped on
        // mainnet and testnet, see coins.resolveConfirmations).
        //
        // This is HUB-LOCAL trust policy and it is the only end of the anchor path the
        // knob moves. The BTC indexer's anchor-reward MINT gate does NOT read it: minting
        // happens inside the block transaction, so its depth is a ledger input frozen at
        // ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS (anchor_reward_activation.js), equal to the
        // per-coin default. Because the resolver's floor is that same default, a hub on
        // mainnet or testnet can never attest shallower than the fleet will mint. On
        // regtest a lowered override deliberately can: the hub attests early and the BTC
        // indexer defers the block until the anchor reaches the frozen depth, which is a
        // drill-venue property to plan around, not a divergence.
        this.dogeConfirmations = coins.resolveConfirmations(cfg, this.network).DOGE;

        // XANC_BUNDLE_DONE is broadcast the instant _broadcastWithRetry
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
        this._deferredBundleDone  = new Map();
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
            // Chains carried by those bundles, and bundles refused for exceeding the
            // 8189-byte budget. sectionsAnchored climbing at the same rate as
            // anchorsPublished means the federation is anchoring ONE chain per cycle,
            // not a bundle; bundlesOversize non-zero means a checkpoint is not on chain
            // at all and the signer count or the section width has to come down.
            sectionsAnchored:   this._sectionsAnchored,
            bundlesOversize:    this._bundlesOversize,
            // Leader-vs-failover split of anchorsPublished plus the last anchor's
            // rank posture. anchorsAsBackup climbing (or lastAnchorRank.isLeader
            // false) is the only signal that the elected rank-0 publisher is dead
            // and the ladder is absorbing its work.
            anchorsAsLeader:    this._anchorsAsLeader,
            anchorsAsBackup:    this._anchorsAsBackup,
            // Stamped without paying. Holds anchorsAsLeader + anchorsAsBackup ==
            // anchorsPublished; lastAnchorRank.adopted names the most recent one.
            anchorsAdopted:     this._anchorsAdopted,
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
            unattestedDeferrals:      this.unattestedDeferrals,
            lastUnattestedDeferralAt: this.lastUnattestedDeferralAt,
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
        // BUNDLE_DONE has to be re-checked on the order of the DOGE confirmation window,
        // not the anchor publishing window.
        this._deferTimer = setInterval(() => {
            this._drainDeferredBundleDone().catch(err => console.error('StateAnchorPublisher: deferred BUNDLE_DONE drain error:', err && err.message));
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
        // A publish in flight at teardown cannot be waited on here, but leaving the guard
        // set would refuse every round after a restart of the publisher on this instance.
        this._archivePublishing = null;
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
            await this._drainDeferredBundleDone()
                .catch(err => console.warn('StateAnchorPublisher: deferred BUNDLE_DONE drain error: ' + (err && err.message)));
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

    // The BUNDLE election key. One election per bundle, so the key binds only what a
    // bundle is identified by: its network and its snapshot_block (the MAX over the
    // sections, D6). The retired per-row key bound chain and seq as well, which is why
    // one cycle could elect a different publisher per chain and pay three DOGE fees.
    // Takes any object carrying `network` + `snapshot_block`, so a raw state_checkpoints
    // row (every row in a bundle shares the network, and the leader's row carries the
    // bundle block) resolves the same key the bundle does.
    //
    // The 'XANCV7' tag KEEPS its pre-restart spelling even though the wire is now v0
    // (D3). It never reaches the chain, and it feeds hashOrder: renaming it permutes
    // every hub's rank the moment one hub deploys ahead of another, so two elections
    // would run at once mid-rollout. It is an opaque domain separator, not a version.
    _bundleElectionKey(b){
        return 'XANCV7|' + b.network + '|' + String(b.snapshot_block);
    }

    // May THIS hub publish for `order` right now? Rank 0 always may; each
    // additional rank unlocks after ANCHOR_ELECTION_TOLERANCE_BLOCKS more BTC
    // blocks past the election anchor point (deterministic failover ladder).
    // A hub outside a non-empty eligible set never publishes, and an empty
    // (unresolved/unavailable) set means abstain (fail closed), never a
    // free-for-all where every hub double-anchors the same checkpoint.
    _mayPublish(order, sinceBlocks){
        // Single source of truth for the anchor failover ladder: delegate to _rankUnlocked
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

    // ONE ANCHOR v0 bundle per network per cycle: the LATEST un-anchored checkpoint of
    // every chain rides as a SECTION of one transaction (spec §2.2). Older un-anchored
    // seqs are superseded (the chained hashes commit to all prior history), so only the
    // newest per chain costs DOGE bytes. The bundle runs ONE election, ONE attestation
    // round and ONE UTXO spend where the retired per-chain wires ran N of each.
    //
    // The method keeps its name: flush() and the deferral suites drive it, and what
    // changed is the unit of work inside it, not the seam.
    async _publishPendingCheckpoints(signer, btcBlock, failoverOnly){
        // Pick, per chain, the latest ANCHOR-ELIGIBLE checkpoint (its checkpoint
        // ORDINAL, seq divided by the cadence step, divisible by
        // anchorEveryNCheckpoints - see the constructor for why the raw seq cannot
        // carry this) that is not yet on-chain. Selecting the max eligible seq rather
        // than the absolute max means ineligible rounds never block: they simply stay
        // off-chain. With N=1 (MOD(x,1)=0 for all) this is identical to anchoring every
        // checkpoint.
        // Scoped to this.network when one is configured (matching
        // StateCheckpointEngine's latch loader): a hub DB carrying rows from a
        // prior network deployment must never re-elect publishers for (or spend
        // a real DOGE anchor on) a dead network's perpetually-unanchored
        // checkpoints. A hub with no configured network keeps the legacy
        // unscoped behavior rather than filtering everything out.
        //
        // The SQL is unchanged from the per-chain era ON PURPOSE (D24). The
        // `anchor_txid IS NULL` predicate sits OUTSIDE the MAX subquery: pushing it in
        // would resurrect older un-anchored seqs that the chained hashes have already
        // superseded. Do not move it.
        let pendingSql =
            'SELECT sc.* FROM state_checkpoints sc JOIN (' +
            '  SELECT chain, network, MAX(checkpoint_seq) AS max_seq FROM state_checkpoints' +
            '  WHERE MOD(FLOOR(checkpoint_seq / ?), ?) = 0 GROUP BY chain, network' +
            ') t ON sc.chain = t.chain AND sc.network = t.network AND sc.checkpoint_seq = t.max_seq ' +
            'WHERE sc.anchor_txid IS NULL';
        let pendingParams = [this.checkpointIntervalBlocks, this.anchorEveryNCheckpoints];
        if(this.network){ pendingSql += ' AND sc.network = ?'; pendingParams.push(this.network); }
        let rows = await this.db.doQuery(pendingSql, pendingParams);
        let anchored = [];
        let skipped  = { rows: 0 };

        // Group the result set into ONE bundle per network. A chain absent from a
        // group is NOT an anomaly (D4): under the daily cadence the normal case is a
        // chain whose newest eligible seq is already anchored.
        let byNetwork = new Map();
        for(let row of (rows || [])){
            // D8: the bundle is root-bearing by construction, so a row with no
            // light-client roots cannot ride one. Below CHECKPOINT_COMMITMENT_ACTIVATION
            // (regtest 0, testnet 146000, mainnet 961000) no federation cutting
            // checkpoints today produces such a row, so this is a loud skip rather than
            // a rootless fallback wire.
            if(row.state_root == null || row.block_merkle_root == null ||
               row.state_root_version == null || row.block_merkle_version == null){
                console.warn('StateAnchorPublisher: checkpoint ' + row.chain + '/' + row.network + ' @ ' +
                             row.block_index + ' (seq ' + row.checkpoint_seq + ') carries no light-client roots; ' +
                             'skipped, an ANCHOR v0 section is root-bearing by construction');
                continue;
            }
            let net = String(row.network);
            if(!byNetwork.has(net)) byNetwork.set(net, []);
            byNetwork.get(net).push(row);
        }

        for(let [network, sections] of byNetwork){
            // The bundle's election and attestation block is the MAX of the sections'
            // snapshot blocks (D6); in the normal case every section shares it, and a
            // lagging chain's older un-anchored row rides at its own block.
            let snapshotBlock = sections.reduce((m, s) => Math.max(m, Number(s.snapshot_block)), 0);
            let eligible;
            try { eligible = await this._getActiveOraclePublishPubkeys(snapshotBlock); }
            catch(_e){ eligible = []; }
            // Fail closed: an empty/unresolved oracle_publish set is NOT a licence for
            // every hub to anchor independently (a guaranteed N-way double-anchor + DOGE
            // burn). Skip until the set resolves.
            if(!eligible || eligible.length === 0){
                console.warn('StateAnchorPublisher: bundle for ' + network + ' @ ' + snapshotBlock +
                             ' deferred: empty oracle_publish set (fail closed)');
                continue;
            }
            let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
            // Split BEFORE electing, so each bundle the split produces runs its own
            // election at its own SNAPSHOT_BLOCK (_publishBundle re-resolves the set there).
            // Sizing uses the max-height oracle_publish set as the attestation tail: exact
            // for an unsplit bundle, whose block IS this one, and a close estimate for a
            // split group at an older block, where the set of that height sizes the round.
            // Size the tail the bundle will ACTUALLY carry. Below the anchor-reward
            // flag-day _publishBundle attaches none at all, so charging a tail there would
            // refuse sections that anchor fine today; at/above it an unmet attestation
            // quorum DEFERS rather than degrading to a count-0 wire, so the tail is real.
            let attestTail = ar.isAnchorRewardActive(snapshotBlock, network) ? eligible.length : 0;
            let split = this._splitBundle(sections, me, attestTail);
            for(let refused of split.oversize){
                this._bundlesOversize++;
                console.error('StateAnchorPublisher: REFUSING to anchor ' + refused.chain + '/' + network +
                              ' @ ' + refused.block_index + ': the section alone is ' + refused.bytes +
                              ' bytes at ' + attestTail + ' attesting signer(s), past the ' +
                              ANCHOR_BUNDLE_MAX_BYTES + '-byte budget. The decoder DROPS an oversize ' +
                              'action silently, so this checkpoint stays off chain until the federation ' +
                              'signer count comes down');
            }
            for(let group of split.bundles)
                await this._publishBundle(signer, network, group, btcBlock, failoverOnly, anchored, skipped);
        }

        // One line per LEADER flush (daily, startup, size-trigger, anchorflush) when
        // it walked candidates and published none, so the stand-down is visible in the
        // log at its natural cadence. The 15-minute wake stays silent: its skips are
        // the designed steady state and the counters above carry them.
        if(!failoverOnly && skipped.rows > 0 && anchored.length === 0){
            console.log('StateAnchorPublisher: ' + skipped.rows + ' pending checkpoint(s) belong to another hub\'s election ' +
                        '(or our backup rank is still locked); nothing anchored by this hub');
        }
        return anchored;
    }

    // Publish ONE bundle: election, marker check, attestation round, build, broadcast,
    // per-section stamp, reward, announcement. Split out of the selector so the byte
    // budget can hand it several bundles for one network in one flush, each electing
    // independently. Never throws past a mid-flush deferral; every other failure is
    // logged and leaves the sections pending for the next flush.
    async _publishBundle(signer, network, group, btcBlock, failoverOnly, anchored, skipped){
        let chains = group.map(s => String(s.chain)).join(',');
        try {
            let snapshotBlock = group.reduce((m, s) => Math.max(m, Number(s.snapshot_block)), 0);
            // Elect over the oracle_publish set at THIS bundle's own snapshot block, never
            // the caller's network-wide MAX. A byte-budget split can leave a lagging chain's
            // sections in a group whose MAX is older, and BOTH follower verifiers resolve the
            // set at the group's own block (_handleAttestSignReq, the BUNDLE_DONE gate), as
            // does the indexer when it verifies the anchor. Ranking the leader over a
            // different population than every verifier is a divergence, not a preference:
            // the attest round refuses to co-sign, BUNDLE_DONE is rejected, and an anchor
            // that does land names a PUBLISHER outside the set the reward derives over. The
            // caller's max-height set keeps its two jobs (the pre-split fail-closed gate and
            // the split's attestation-tail sizing) and is deliberately not passed down here.
            let eligible;
            try { eligible = await this._getActiveOraclePublishPubkeys(snapshotBlock); }
            catch(_e){ eligible = []; }
            // Fail closed per bundle, the twin of the caller's gate: an unresolved set is no
            // licence for every hub to anchor independently. Defer rather than borrow a set
            // resolved at another height.
            if(!eligible || eligible.length === 0){
                console.warn('StateAnchorPublisher: bundle ' + chains + '/' + network + ' @ ' + snapshotBlock +
                             ' deferred: empty oracle_publish set at the bundle\'s own snapshot block (fail closed)');
                return;
            }
            let order = StateAnchorPublisher.hashOrder(
                this._bundleElectionKey({ network: network, snapshot_block: snapshotBlock }), eligible);
            // Bounded by CHECKPOINT_INTERVAL_BLOCKS * ANCHOR_CHECKPOINT_EVERY_N (6 at the
            // defaults), since the newest eligible snapshotBlock tracks the tip, so no rank
            // above 0 unlocks here unless that product reaches the tolerance. Intended: see
            // the ANCHOR_ELECTION_TOLERANCE_BLOCKS derivation above.
            let since = Number.isFinite(btcBlock) ? btcBlock - snapshotBlock : null;
            // Someone else's bundle (or our backup rank has not unlocked yet).
            if(!this._mayPublish(order, since)){
                this._skippedNotOurElection += group.length;
                skipped.rows += group.length;
                return;
            }
            // On a failover wake, publish only as a BACKUP. Rank 0 is always unlocked, so
            // without this the 15-minute wake would replace the leader's
            // ANCHOR_INTERVAL_MS cadence and it would anchor a fresh bundle every wake
            // instead of one per cycle (each superseding the last, all real DOGE).
            if(failoverOnly && this._isRankZero(order)){
                this._skippedLeaderOnWake += group.length;
                skipped.rows += group.length;
                return;
            }

            // The durable at-most-once marker, consulted BEFORE building a fresh PSBT and
            // before the attestation round solicits a peer quorum. The existence check
            // reads mined state only, so it cannot see a send this hub made and then
            // crashed on; the marker can. The marker table is UNCHANGED (D11): one row per
            // section, and the bundle holds if ANY section's marker holds, because any one
            // of them is evidence that DOGE may already have paid for this exact set.
            let held = null;
            for(let s of group){
                let intent = await this._getAnchorIntent(s);
                if(this._anchorIntentHolds(intent)){ held = { section: s, intent: intent }; break; }
            }
            if(held){
                let mined = null;
                try { mined = await this._findExistingBundle(group); }
                catch(_e){ mined = null; }        // undetermined indexer: hold, never spend
                if(!(mined && mined.exists)){
                    console.warn('StateAnchorPublisher: bundle ' + chains + '/' + network + ' @ ' + snapshotBlock +
                                 ' held: a broadcast intent for ' + held.section.chain + ' recorded at ' +
                                 String(held.intent.intent_at) + (held.intent.txid ? ' (txid ' + held.intent.txid + ')' : '') +
                                 ' has no mined anchor yet; not rebuilding a second transaction until it ' +
                                 'mines or the intent ages past ' + this.anchorIntentTtlMs + 'ms');
                    return;
                }
            }

            // ONE publisher-attestation round for the whole bundle (spec §2.5): a 2f+1
            // oracle_publish quorum over the XANCPUB canonical binding THIS hub as the
            // earner, carried in the v0 tail so the indexer DERIVES the reward.
            //
            // A DEGRADED ROUND DEFERS THE BUNDLE, rather than falling through to publish a
            // v0 carrying ATTEST_SIG_COUNT 0 on the reasoning that "the anchor always
            // lands and only the reward gains the quorum dependency". That reasoning is
            // false against the wire: the indexer's v0 BUNDLE parser requires
            // ATTEST_SIG_COUNT >= 1 (actions/anchor.js, the bundle publisher tail), so a
            // count-0 bundle is not a degraded anchor, it is an INVALID one. The fallback
            // therefore paid a real DOGE fee to put a permanently invalid row on chain and
            // still anchored nothing. Count 0 is legal only on the v1 ARCHIVE head, which
            // has its own `< 0` check and its own degraded path; the two are not
            // interchangeable and this site had borrowed the archive's rule.
            //
            // Deferring is safe: nothing is recorded and no transaction is built, so the
            // checkpoints stay pending and the next cycle republishes them. The failure
            // this protects against is transient by nature (peers restarting, a rolling
            // deploy, a split federation), and if it is NOT transient then publishing
            // would not have helped either, it would only have spent fees to say so.
            let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
            let bundle = { network: network, snapshot_block: snapshotBlock, sections: group };
            let attested   = false;
            let attestSigs = [];
            if(me && ar.isAnchorRewardActive(snapshotBlock, network)){
                let attest = await this._runPublisherAttestationRound(bundle, me);
                if(attest && attest.met && attest.sigs.length >= 1){
                    attested   = true;
                    attestSigs = attest.sigs;
                } else {
                    this.unattestedDeferrals++;
                    this.lastUnattestedDeferralAt = Date.now();
                    console.warn('StateAnchorPublisher: publisher-attestation quorum not reached for bundle ' +
                                 chains + '/' + network + ' @ ' + snapshotBlock +
                                 '; DEFERRING (a v0 bundle with ATTEST_SIG_COUNT 0 is rejected by the ' +
                                 'indexer, so publishing would spend a fee to land an invalid anchor). ' +
                                 'The checkpoints stay pending and the next cycle republishes them.');
                    return;
                }
            }
            let payload = this._buildV7Payload(group, me, attestSigs);
            // Last byte-budget gate, on the payload that will actually be signed and sent.
            // _splitBundle sizes an ESTIMATED tail before the attestation round runs, and
            // after a split it estimates at the caller's network-wide oracle_publish set
            // rather than this group's own block, so the estimate can come in low.
            // Downstream the encoder answers an oversize action with a RangeError that
            // _broadcastWithRetry burns its whole retry budget on, after the anchor
            // intents are already recorded and then withdrawn. Refuse here instead:
            // counted, loud, and ahead of the intent loop, with the rows left pending.
            let payloadBytes = Buffer.byteLength(payload, 'utf8');
            if(payloadBytes > ANCHOR_BUNDLE_MAX_BYTES){
                this._bundlesOversize++;
                console.error('StateAnchorPublisher: v0 bundle ' + chains + '/' + network + ' @ ' + snapshotBlock +
                              ' builds to ' + payloadBytes + ' bytes with ' + attestSigs.length +
                              ' attesting signer(s), past the ' + ANCHOR_BUNDLE_MAX_BYTES + '-byte budget; ' +
                              'NOT broadcasting (nothing recorded, the rows stay pending for the next cycle)');
                return;
            }

            let broadcaster = signer && signer.broadcastFn
                ? signer.broadcastFn : ((p) => this._defaultBroadcast(p, signer));
            for(let s of group) await this._recordAnchorIntent(s);
            // The existence check makes a lost ACK (this flush OR a previous one) adopt
            // the already-mined bundle instead of paying for a second one.
            let result;
            try {
                result = await this._broadcastWithRetry(broadcaster, payload, undefined,
                    () => this._findExistingBundle(group));
            } catch(e){
                // A definitive failure means nothing reached the DOGE node (pre-send
                // build/sign errors, a spend-ceiling refusal, an RPC rejection), so
                // withdraw the intents rather than hold the sections for the TTL over a
                // send that never happened. An AMBIGUOUS send keeps its intents: that
                // case is exactly what the markers are for.
                if(!(e && e.anchorAmbiguousSend)) for(let s of group) await this._withdrawAnchorIntent(s);
                throw e;
            }
            let txid = result && result.txid ? result.txid : null;
            if(txid && !(result && result.exists))
                this._notePendingConfirmation('anchor_bundle', txid, network + '/' + snapshotBlock);
            if(!txid){
                // A confirmed DOGE broadcast always returns a txid; a null txid is a
                // false/incomplete success (broadcastTx returned empty instead of
                // throwing). Treat it as a failed publish: leave the sections pending
                // (anchor_txid stays NULL) and do NOT stamp, reward, or announce.
                // Stamping NULL keeps the rows matching the selector so the bundle
                // re-anchors and re-burns DOGE every flush, and peers ignore a null-txid
                // announcement anyway (_handleBundleDone early-returns on !d.txid).
                // The intents are NOT withdrawn: an empty return from broadcast_tx is not
                // proof nothing was sent, so the markers hold the sections for the TTL.
                console.error('StateAnchorPublisher: v0 bundle broadcast returned no txid for ' + chains + '/' +
                              network + ' @ ' + snapshotBlock + '; treating as failed publish (rows stay pending)');
                return;
            }
            for(let s of group) await this._markAnchorSent(s, txid);
            // First-writer-wins per section, exactly like the peer path in
            // _applyBundleDone. In the documented failover race a hub may already have
            // stamped a peer's txid; without the IS NULL guard, completing our own
            // in-flight publish would overwrite it and leave the fleet holding divergent
            // anchor_txid bytes.
            for(let s of group){
                await this.db.doQuery(
                    'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL',
                    [txid, s.chain, s.network, s.block_index, s.checkpoint_seq]);
                anchored.push({ chain: String(s.chain), network: String(s.network),
                                block_index: Number(s.block_index), txid: txid });
            }
            // Name the rank this bundle was published at. A backup-rank publish is
            // otherwise byte-identical to a healthy leader publish in every observable
            // signal, so a dead rank-0 stays invisible while the ladder absorbs its work.
            // Computed from the SAME `order` _mayPublish decided on, so the label can
            // never disagree with the decision that produced the spend.
            let myRank = this._myRank(order);
            // Gate the publish counters and the log verb on whether this call actually
            // spent: an adopted bundle was paid for by a prior broadcast of ours or by a
            // peer, and must never read as an anchor this hub bought.
            let adopted = !!(result && result.exists);
            this._lastAnchorRank = { network: network, snapshotBlock: snapshotBlock,
                                     chains: group.map(s => String(s.chain)), myRank: myRank,
                                     publisherCount: order.length, isLeader: myRank === 0,
                                     adopted: adopted, at: Date.now() };
            if(adopted){
                this._anchorsAdopted++;
            } else {
                if(myRank > 0) this._anchorsAsBackup++; else this._anchorsAsLeader++;
                this._anchorsPublished++;
                this._sectionsAnchored += group.length;
            }
            console.log('StateAnchorPublisher: ' + (adopted ? 'adopted' : 'anchored') + ' bundle ' +
                        network + ' @ ' + snapshotBlock +
                        ' with ' + group.length + ' section(s) [' + chains + '] (txid ' + txid + ')' +
                        (!adopted && myRank > 0
                            ? ' [FAILOVER: published at backup rank ' + myRank + ' of ' + order.length +
                              '; the rank-0 publisher did not anchor this bundle]'
                            : ''));

            // At/above the anchor-reward flag-day the reward is DERIVED on-chain from the
            // v0 publisher attestation (the hub push is retired), and the indexer credits
            // NOTHING for a bundle whose tail carries no attestation. Recording the reward
            // on the degraded fallback would strand it in hub-local + archive bookkeeping
            // only: no live indexer credits it, but a recovering node restores the
            // archived row, forking the COLLECT-spendable ledger live-vs-recovered.
            if(result && result.exists){
                // Adoption path: we did not pay for THIS bundle in this call (a prior
                // lost-ACK broadcast or a peer did). The on-chain payload, not the one we
                // just built, names the earner. Stamp + announce, but never push.
                console.log('StateAnchorPublisher: adopted existing bundle for ' + network + ' @ ' +
                            snapshotBlock + '; reward push skipped');
            } else if(attested || !ar.isAnchorRewardActive(snapshotBlock, network)){
                // ONE anchor_bundle reward per bundle, round_reference = SNAPSHOT_BLOCK (D3, D21).
                this._recordReward('anchor_bundle', snapshotBlock, me, snapshotBlock, network);
                if(attested)
                    this._deferRewardAttestation({
                        // The identity the mined-anchor proof re-SELECTs and re-verifies
                        // against: the FIRST section (chain-ascending), which carries the
                        // same txid as every other. The attestation ROW's chain is 'DOGE'
                        // (D21), resolved in _recordRewardAttestation from the reward type.
                        chain: String(group[0].chain), network: network,
                        blockIndex: Number(group[0].block_index), checkpointSeq: Number(group[0].checkpoint_seq),
                        txid: txid, anchorVersion: 0,
                        rewardType: 'anchor_bundle', roundReference: snapshotBlock,
                        snapshotBlock: snapshotBlock,
                        publisher: String(me).toLowerCase(), attestSigs: attestSigs,
                        // We are the publisher, so we own the fan-out: once the drain proves
                        // this anchor mined, the confirmed row goes to every peer (XANCREWARD).
                        federate: true
                    });
            } else {
                console.log('StateAnchorPublisher: degraded bundle (no attestation) at/above the reward flag-day for ' +
                            network + ' @ ' + snapshotBlock + '; reward withheld (no live indexer derives it)');
            }

            // Tell peers so THEIR copies of every section stop being pending. Without
            // this, every hub whose failover rank unlocks would re-anchor a bundle
            // someone else already paid for.
            if(this.peerManager && this.identity){
                let announced = {
                    network: network, snapshot_block: snapshotBlock, txid: txid,
                    sections: group.map(s => ({ chain: String(s.chain), block_index: Number(s.block_index),
                                                checkpoint_seq: Number(s.checkpoint_seq) }))
                };
                announced.sig_pubkey = this.identity.getPubkeyHex().toLowerCase();
                announced.sig        = this.identity.sign(this._bundleDoneCanonical(announced, txid));
                this.peerManager.broadcast(XANC_BUNDLE_DONE, announced);
            }
        } catch(e){
            // A mid-flush deferral: an earlier anchor in this same pass spent the last
            // confirmed output. Not a failure of anything; the sections stay pending and
            // the next wake retries them as a normal flush.
            if(e && e.anchorNoConfirmedUtxo) this._noteNoConfirmedUtxo('the ' + network + ' bundle');
            else console.error('StateAnchorPublisher: v0 bundle publish failed for ' + network + ': ' + (e && e.message));
        }
    }

    // Anchor-publish reward: the validator that paid the DOGE earns it. Recorded
    // on EVERY hub (by the publisher at publish time and by peers from the
    // signature-verified BUNDLE_DONE / FINALIZED announcements) with blockIndex =
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

    // Option C (derive-on-BTC-side): after a v0/v1 anchor lands on-chain, publish
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
    // The mirror alone is not enough reach: HubDbSync holds ONE hubUrl
    // (xchain-indexer/src/hub_db_sync.js), the row is written only on the ELECTED publisher,
    // and the publisher rotates per bundle by hashOrder, so without federation a federation's
    // hubs would hold DISJOINT subsets and an indexer would derive only the subset its own hub
    // published. So the PRODUCER federates: `e` carries the confirmed anchor txid and, on the
    // publisher, a truthy `federate`, which broadcasts XANCREWARD after the local write so
    // every peer independently re-verifies and writes its own copy. Two notes:
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
        // anchor_reward_attestations.chain is NOT NULL and part of uq_reward_tuple, and a
        // BUNDLE spans every chain, so the bundle row writes the ANCHOR chain 'DOGE'
        // (D21) - the archive precedent already recorded in that column's comment. The
        // `chain` argument stays the checkpoint identity the mined-anchor proof ran
        // against, so the two never get conflated.
        let rowChain = (rewardType === 'anchor_bundle') ? 'DOGE' : chain;
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
                [rowChain, network, rewardType, roundReference, snapshotBlock, publisher, amount, sigsJson, txid]);
            let rows = await this.db.doQuery(
                'SELECT id, chain, network, reward_type, round_reference, snapshot_block, publisher, reward_amount, publisher_attestations, doge_anchor_txid, created_at ' +
                'FROM anchor_reward_attestations WHERE chain = ? AND network = ? AND reward_type = ? AND round_reference = ? AND snapshot_block = ? AND publisher = ? LIMIT 1',
                [rowChain, network, rewardType, roundReference, snapshotBlock, publisher]);
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
        if(![0, 1].includes(version)) return;                                // only the attestation-bearing ANCHOR versions carry a reward
        if(rewardType !== 'anchor_archive' && rewardType !== 'anchor_bundle') return;
        // BIND the two: v1 is the archive leg, v0 the checkpoint-bundle leg, which is the
        // pairing the BTC derive path enforces (indexer anchor_proof_client._judge:
        // "a v0 can never prove an archive reward and vice versa"). Checked
        // independently, a mis-paired tuple still passes everything downstream: the
        // XANCPUB canonical is rebuilt from the reward_type, so a publisher that really
        // collected a bundle quorum can federate it against the v1 archive head that
        // wraps the same checkpoint, and the drain's byte-match (four core hashes,
        // identical on both legs) confirms it. The row it writes is append-only and
        // never retracted, and the derive path rejects it forever: consensus-table
        // pollution and a permanently stranded credit. Reject at ingress instead.
        if((rewardType === 'anchor_archive') !== (version === 1)) return;
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
        // A bundle canonical binds only network + snapshot_block (the six positional
        // fields of §2.5); `chain` on this wire is the checkpoint IDENTITY the mined-anchor
        // proof re-runs against, never part of what was signed.
        let canonical = (rewardType === 'anchor_archive')
            ? this._archiveAttestationCanonical({ network: network, snapshot_block: snapshotBlock }, roundRef, publisher)
            : this._attestationCanonical({ network: network, snapshot_block: snapshotBlock }, publisher);

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
    // the announceRetryMs timer and at the head of every flush, beside the BUNDLE_DONE and
    // FINALIZED drains.
    //
    // Only 'verified' writes: _verifyAnchorOnChain binds the exact txid AND the exact
    // ANCHOR version, so neither a never-mined transaction nor a different anchor for the
    // same checkpoint can stand in as proof. A decided CONTENT verdict
    // ('rejected:status' / ':mismatch' / ':version') is terminal for this txid and drops
    // the entry. 'rejected:txid' is deliberately NOT terminal here: getanchoraction
    // reports checkpoint_anchored UNFILTERED, so that verdict also fires while our own tx
    // is merely unmined on a checkpoint that already carries an earlier anchor, which is
    // the v1 archive head's normal state. Retrying it until the TTL costs a queue slot;
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

    // ANCHOR v0, the checkpoint BUNDLE (spec §2.1). One action per network per cycle:
    //
    //   ANCHOR|0|NETWORK|SNAPSHOT_BLOCK|SECTION_COUNT
    //         |CHAIN|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH
    //          |CHECKPOINT_SEQ|SECTION_SNAPSHOT_BLOCK
    //          |STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION
    //          |SIG_COUNT|PUBKEY|SIG|...                    (x SECTION_COUNT)
    //         |PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
    //
    // Each section is the retired per-chain body minus NETWORK: the indexer rebuilds every
    // section's XCHECKPOINT canonical with the HEADER network, so nothing about
    // per-chain checkpoint verification changes and the stored signatures still verify.
    //
    // TWO ORDERING RULES, and both are load-bearing (D5):
    //   - sections by CHAIN ascending;
    //   - within a section, the (PUBKEY, SIG) pairs by PUBKEY ascending.
    // _parseSigs returns the stored JSON order UNSORTED, so without the inner sort two
    // publishers racing the same bundle emit different bytes for identical state, and
    // the attestation round's DB byte-match (§2.5) becomes non-deterministic. The frozen
    // vector deliberately feeds this builder out-of-order input to prove both sorts run.
    //
    // NETWORK comes from the sections (every row in a bundle shares it) and
    // SNAPSHOT_BLOCK is the MAX of the sections' own snapshot blocks (D6).
    //
    // Builds the v0 bundle. The method KEEPS its pre-restart name (it built the v7
    // bundle before the version set restarted at 0): it is the seam the attestation
    // round, the split arithmetic, the follower byte-match and the golden-vector suite
    // all drive, and renaming it would touch every one of them to say nothing new.
    _buildV7Payload(sections, publisher, attestSigs){
        let ordered = (sections || []).slice().sort((a, b) => {
            let x = String(a.chain), y = String(b.chain);
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        let network = ordered.length > 0 ? String(ordered[0].network) : '';
        let snapshotBlock = ordered.reduce((m, s) => Math.max(m, Number(s.snapshot_block)), 0);
        let parts = ['ANCHOR', '0', network, String(snapshotBlock), String(ordered.length)];
        for(let s of ordered){
            let sigs = this._parseSigs(s.validator_signatures).slice().sort((a, b) => {
                let x = String(a.pubkey), y = String(b.pubkey);
                return x < y ? -1 : (x > y ? 1 : 0);
            });
            parts.push(String(s.chain), String(s.block_index), s.block_hash,
                       s.ledger_hash, s.actions_hash, s.contract_hash,
                       String(s.checkpoint_seq), String(s.snapshot_block),
                       String(s.state_root || '').toLowerCase(), String(s.state_root_version),
                       String(s.block_merkle_root || '').toLowerCase(), String(s.block_merkle_version),
                       String(sigs.length));
            for(let sg of sigs) parts.push(sg.pubkey, sg.sig);
        }
        parts.push(String(publisher || '').toLowerCase(), String((attestSigs || []).length));
        for(let s of (attestSigs || [])) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
        return parts.join('|');
    }

    // Wire bytes a bundle would occupy with `attestSigCount` attesting signers, WITHOUT
    // the signatures existing yet. The split has to run before the attestation round (each
    // split bundle elects and attests on its own), and a (PUBKEY, SIG) pair is fixed width,
    // so the tail is arithmetic: measure the body with an empty tail, then widen
    // ATTEST_SIG_COUNT from its '0' to the real decimal and add one pair per signer.
    _v7Bytes(sections, publisher, attestSigCount){
        let n    = Math.max(0, Number(attestSigCount) || 0);
        let base = Buffer.byteLength(this._buildV7Payload(sections, publisher, []), 'utf8');
        return base - 1 + String(n).length + (n * ANCHOR_SIG_PAIR_BYTES);
    }

    // The byte budget and its split rule (D10). Sections are packed chain-ascending into
    // as many bundles as fit under ANCHOR_BUNDLE_MAX_BYTES; overflow is SPLIT, never
    // dropped, because the decoder discards an oversize action silently and a dropped
    // checkpoint is invisible fleet-wide. Returns { bundles, oversize }:
    //   bundles  - section groups, each of which fits with `attestSigCount` attesting
    //              signers, in chain order;
    //   oversize - sections REFUSED because one alone exceeds the budget with that SAME
    //              tail. The caller counts them (bundlesOversize) and says so loudly;
    //              nothing is sent.
    // Both checks size the same tail deliberately. Sizing the lone-section refusal at a
    // zero tail admitted a section that only fits empty-tailed: the splitter passed it,
    // the attestation round filled the tail, and the oversize payload died at the
    // encoder's RangeError instead of being refused here - a checkpoint silently off
    // chain, with bundlesOversize still reading 0. That asymmetry rode on a degraded
    // ATTEST_SIG_COUNT 0 fallback that no longer exists: _publishBundle DEFERS an unmet
    // publisher-attestation quorum, because the indexer's v0 parser rejects a count-0
    // bundle outright. The caller passes 0 only below the anchor-reward flag-day, where
    // the payload genuinely carries no tail.
    _splitBundle(sections, publisher, attestSigCount){
        let ordered = (sections || []).slice().sort((a, b) => {
            let x = String(a.chain), y = String(b.chain);
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        let bundles = [], oversize = [], current = [];
        for(let s of ordered){
            let alone = this._v7Bytes([s], publisher, attestSigCount);
            if(alone > ANCHOR_BUNDLE_MAX_BYTES){
                oversize.push({ chain: String(s.chain), block_index: Number(s.block_index), bytes: alone });
                continue;
            }
            if(current.length > 0 && this._v7Bytes(current.concat([s]), publisher, attestSigCount) > ANCHOR_BUNDLE_MAX_BYTES){
                bundles.push(current);
                current = [];
            }
            current.push(s);
        }
        if(current.length > 0) bundles.push(current);
        if(bundles.length > 1)
            console.log('StateAnchorPublisher: bundle for ' + (ordered[0] ? ordered[0].network : '') +
                        ' exceeds the ' + ANCHOR_BUNDLE_MAX_BYTES + '-byte budget at ' + attestSigCount +
                        ' attesting signers; split chain-ascending into ' + bundles.length + ' bundles [' +
                        bundles.map(b => b.map(s => String(s.chain)).join('+')).join(', ') + ']');
        return { bundles: bundles, oversize: oversize };
    }

    // Publisher-attestation canonical (XANCPUB): the string the 2f+1 oracle_publish quorum
    // signs to ATTEST which validator earns the anchor reward. MUST be BYTE-IDENTICAL to the
    // indexer's Anchor._rewardCanonical (a divergence forks the derived reward row). The
    // amount is the FROZEN consensus constant (ar.ANCHOR_REWARD_AMOUNT, read from the twin
    // module, NOT the operator-tunable ANCHOR_REWARD_PER_PUBLISH env). The EQUIV wrapper uses
    // the bundle's NETWORK (b.network) like _canonical/_archiveCanonical, NOT this.network,
    // and a distinct 'XANCPUB|...' roundId gives the attestation its own equivocation family so
    // a validator that signs both the checkpoint root canonical and this reward attestation in
    // the same round is never falsely slashable.
    //
    // SIX positional fields, unchanged in COUNT from the retired per-chain form (D22):
    // slash.js reads snapshot_block at field index 3 for every XANCPUB family, so a
    // five-field bundle canonical would have made every bundle equivocation read
    // 'invalid: snapshot_block'. Field 2 is round_reference, which for a bundle IS the
    // snapshot block, hence the repeat.
    //
    //   XANCPUB|anchor_bundle|SNAPSHOT_BLOCK|SNAPSHOT_BLOCK|PUBLISHER|ANCHOR_REWARD_AMOUNT
    //
    // The roundId 'XANCPUB|bundle|NETWORK|SNAPSHOT_BLOCK' is disjoint from the archive
    // family ('XANCPUB|archive|...'), so the two can never equivocation-collide.
    _attestationCanonical(b, publisher){
        let base = ['XANCPUB', 'anchor_bundle', String(b.snapshot_block),
                    String(b.snapshot_block), String(publisher || '').toLowerCase(),
                    ar.ANCHOR_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(b.snapshot_block, b.network)){
            let roundId = 'XANCPUB|bundle|' + b.network + '|' + b.snapshot_block;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    }

    // Run the publisher-attestation round for a BUNDLE this hub is publishing (spec §2.5).
    // Resolves { met, sigs:[{pubkey,sig}], publisher } once a 2f+1 oracle_publish quorum
    // (stake-weighted at/above STAKE_WEIGHTED_QUORUM, else count) co-signs XANCPUB, or
    // { met:false } on timeout / short quorum. ONE round per bundle, where the retired
    // per-chain path ran one per row. The SIGNING/QUORUM set is resolved at the bundle's
    // snapshot_block, the SAME set the indexer (anchor.js) verifies the attestation
    // against, so the hub never collects a quorum the chain then rejects.
    async _runPublisherAttestationRound(b, publisher){
        if(!this.identity) return { met: false, sigs: [] };

        // _resolveCapabilitySet FAILS CLOSED off regtest (it throws when the
        // deterministic snapshot is unavailable), which is right for the callers that
        // must not build on a divergent set. Here it would abort the whole anchor: this
        // round is awaited inside _publishBundle, whose catch only logs the failure and
        // drops the bundle, so a transient snapshot outage would withhold the ANCHOR
        // itself rather than just its reward. Degrade instead, byte-identically to the
        // snapCount === 0 abstain below: no attestation, a v0 with ATTEST_SIG_COUNT 0
        // lands, no reward is recorded. Scoped to the resolve call only, so an unrelated
        // throw inside the round still surfaces.
        let signingSet;
        try {
            signingSet = await this._resolveCapabilitySet('oracle_publish', Number(b.snapshot_block), resolveQuorumNetwork(b, this.network));
        } catch(e){
            console.warn('StateAnchorPublisher: oracle_publish set unresolvable at snapshot_block ' +
                         Number(b.snapshot_block) + ' (' + (e && e.message) + '); abstaining from the ' +
                         'publisher-attestation round (unattested bundle, no reward) rather than blocking the anchor');
            return { met: false, sigs: [] };
        }
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let weighted       = swq.isStakeWeightedQuorumActive(Number(b.snapshot_block), resolveQuorumNetwork(b, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let me        = this.identity.getPubkeyHex().toLowerCase();
        let canonical = this._attestationCanonical(b, publisher);
        let mySig     = this.identity.sign(canonical);

        // An UNRESOLVED (empty) signing set is not a quorum of one: abstain. The rest of
        // this file fails closed on an unresolved set, and the two resolvers used across
        // one round can legitimately disagree (_getActiveOraclePublishPubkeys reads the
        // capability snapshot, _resolveCapabilitySet may take the weighted one), so a
        // hub can pass the eligible.length fail-closed gate in _publishPendingCheckpoints
        // and still resolve snapCount 0 here. Self-attesting on that would emit a v0
        // carrying one signature that every indexer rejects (it resolves a non-empty set),
        // while THIS hub banks and archives an anchor reward no live indexer credits: the
        // live-vs-recovered ledger fork the reward gates exist to prevent. An unattested
        // bundle is degraded, not divergent.
        if(snapCount === 0){
            console.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(b.snapshot_block) + '; abstaining from the publisher-attestation round ' +
                         '(unattested bundle, no reward) rather than self-attesting');
            return { met: false, sigs: [] };
        }
        // The publisher must itself hold oracle_publish at snapshot_block, or the indexer
        // drops the reward (PUBLISHER must be in the verified set). Fall back to an
        // unattested bundle rather than emit one whose reward can never be credited.
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
            // oracle_publish snapshot, identical to the archive round. Without this the
            // publisher-attestation quorum fail-OPENS on a truncated set, emitting a v0
            // whose reward the indexer would drop (stranded credit).
            if(signingSet.truncated === true) roundValidators.truncated = true;
            let round = {
                bundle: b, publisher, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            this._attestRound = round;
            round.timer = setTimeout(() => {
                if(this._attestRound === round && !round.done){
                    round.done = true;
                    this._attestRound = null;
                    console.warn('StateAnchorPublisher: publisher-attestation round (bundle ' + b.network + ' @ ' +
                                 b.snapshot_block + ') timed out at ' + round.signatures.size + '/' + quorum +
                                 ' sigs; unattested fallback');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })) });
                }
            }, this.roundTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            // The followers re-derive everything; the wire carries identity plus the BODY
            // they byte-match their own rebuild against (§2.5). `body` is the v0 with an
            // EMPTY attestation tail, which is exactly the part a follower can reproduce
            // from its own state_checkpoints rows before any signature exists.
            this.peerManager.broadcast(XANCPUB_SIGN_REQ, {
                network: String(b.network), snapshot_block: Number(b.snapshot_block),
                sections: b.sections.map(s => ({ chain: String(s.chain), block_index: Number(s.block_index),
                                                 checkpoint_seq: Number(s.checkpoint_seq) })),
                body: this._buildV7Payload(b.sections, publisher, []),
                publisher: publisher, sig_pubkey: me, sig: mySig
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

    // Follower: co-sign the BUNDLE publisher attestation ONLY when the proposer is the
    // legitimately rank-unlocked publisher of a bundle that BYTE-MATCHES the one we
    // rebuild from our own state_checkpoints rows, and we ourselves hold oracle_publish
    // at its snapshot_block. The frozen amount is enforced implicitly: we rebuild the
    // canonical with ar.ANCHOR_REWARD_AMOUNT, so a wire-supplied amount can never be
    // co-signed.
    async _handleAttestSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !Array.isArray(d.sections) || d.sections.length === 0) return;
        let network       = String(d.network || '');
        let snapshotBlock = Number(d.snapshot_block);
        if(!network || !Number.isFinite(snapshotBlock)) return;
        let myPubkey  = this.identity.getPubkeyHex().toLowerCase();
        let sender    = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;
        // The publisher attests ITSELF: the proposer must be the rewarded publisher, or it
        // is binding a pubkey it is not entitled to.
        let publisher = String(d.publisher || '').toLowerCase();
        if(publisher !== sender) return;

        // Re-run the BUNDLE publisher election (oracle_publish @ snapshot_block,
        // hash-ordered by the bundle election key) and confirm the proposer is
        // rank-unlocked on the SAME failover ladder _publishBundle used, bounded to our own
        // BTC tip (anti-spam; the binding security is the byte-match below).
        let eligible = await this._getActiveOraclePublishPubkeys(snapshotBlock);
        if(eligible.length === 0) return;
        {
            // Run the ladder check for EVERY set size: a single-member set must
            // still bind sender === eligible[0] (rank 0), or any current member
            // could impersonate the sole elected publisher.
            let order = StateAnchorPublisher.hashOrder(
                this._bundleElectionKey({ network: network, snapshot_block: snapshotBlock }), eligible);
            let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - snapshotBlock : null;
            if(!this._rankUnlocked(order, sender, since)) return;          // proposer not unlocked
        }
        // Only co-sign if WE hold oracle_publish at snapshot_block, or the indexer would drop
        // our attestation signature anyway (same gate the archive follower applies).
        if(!eligible.includes(myPubkey)) return;

        // THE byte-match (§2.5). Rebuild every announced section from OUR OWN
        // state_checkpoints row and rebuild the bundle body with the 2.1 ordering rules.
        // One rebuild covers every claim the wire makes at once: hashes, roots, per-section
        // seq and snapshot block, the section set, the MAX snapshot block, and both sorts.
        // A reorg-superseded row, a missing section, an extra section or a single flipped
        // hex digit all fail here.
        let mine = [];
        for(let sec of d.sections){
            let local = await this.db.doQuery(
                'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
                [String(sec.chain), network, Number(sec.block_index), Number(sec.checkpoint_seq)]);
            if(!local || local.length === 0) return;                       // we cannot vouch for a section we do not hold
            mine.push(local[0]);
        }
        if(this._buildV7Payload(mine, publisher, []) !== String(d.body || '')) return;
        // The proposer's own SNAPSHOT_BLOCK claim has to be the one our rows produce, or
        // the canonical we co-sign would name a block the bundle does not commit to.
        if(mine.reduce((m, r) => Math.max(m, Number(r.snapshot_block)), 0) !== snapshotBlock) return;

        let canonical = this._attestationCanonical({ network: network, snapshot_block: snapshotBlock }, publisher);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;   // proposer's own sig

        this.peerManager.broadcast(XANCPUB_SIGN, {
            network: network, snapshot_block: snapshotBlock,
            sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    async _handleAttestSign(envelope){
        let d = envelope.data;
        let round = this._attestRound;
        if(!round || round.done || !d) return;
        // Match the active round by bundle identity (network/snapshot_block), the same
        // pair the election key and the canonical are built from.
        if(String(d.network) !== String(round.bundle.network) ||
           Number(d.snapshot_block) !== Number(round.bundle.snapshot_block)) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this._checkAttestQuorum();
    }

    // Archive publisher-attestation canonical: the string the 2f+1 oracle_publish
    // quorum signs to ATTEST which validator earns the anchor_archive reward. MUST be
    // BYTE-IDENTICAL to the indexer's Anchor._rewardCanonical for FORMAT 1 (a divergence
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
    // (anchor.js formats[1]) verifies the attestation against.
    async _runArchiveAttestationRound(cp, batchSeq, publisher){
        if(!this.identity) return { met: false, sigs: [] };

        // Same fail-closed resolver, same reason to degrade rather than propagate (see
        // _runPublisherAttestationRound): this round is awaited in _publishArchive AFTER
        // the wrapper co-sign quorum has already been collected, so a throw here discards
        // a completed round instead of publishing the count-0 head the archive's own
        // liveness note promises. Abstaining matches the snapCount === 0 branch below.
        let signingSet;
        try {
            signingSet = await this._resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));
        } catch(e){
            console.warn('StateAnchorPublisher: oracle_publish set unresolvable at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (' + (e && e.message) + '); abstaining from the ' +
                         'archive publisher-attestation round (ATTEST_SIG_COUNT 0, no reward) rather than ' +
                         'discarding the archive');
            return { met: false, sigs: [] };
        }
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let me        = this.identity.getPubkeyHex().toLowerCase();
        let canonical = this._archiveAttestationCanonical(cp, batchSeq, publisher);
        let mySig     = this.identity.sign(canonical);

        // Unresolved (empty) set: abstain, exactly as the v0 bundle round does. Self-attesting
        // here would emit a v1 whose lone signature every indexer rejects while this hub
        // banks and archives the archive-anchor reward locally.
        if(snapCount === 0){
            console.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + '; abstaining from the archive publisher-attestation ' +
                         'round (ATTEST_SIG_COUNT 0, no reward) rather than self-attesting');
            return { met: false, sigs: [] };
        }
        // The publisher must itself hold oracle_publish at snapshot_block, or the indexer
        // drops the reward (PUBLISHER must be in the verified set). Fall back to a count-0
        // tail rather than emit an attestation whose reward can never be credited.
        if(!signingPubkeys.includes(me)) return { met: false, sigs: [] };

        let signatures = new Map();
        signatures.set(me, mySig);

        // Genuine single-node set (snapCount === 1, membership proven above).
        if(snapCount <= 1 || !this.peerManager)
            return { met: true, sigs: [{ pubkey: me, sig: mySig }], publisher: publisher };

        return await new Promise((resolve) => {
            let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
            // Preserve the truncation flag so the weighted quorum fails closed on an
            // over-cap oracle_publish snapshot (same reasoning as the v0 bundle round: a
            // fail-open would emit a tail whose reward the indexer drops).
            if(signingSet.truncated === true) roundValidators.truncated = true;
            let round = {
                cp, batchSeq, publisher, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            // Settle whatever this round displaces. The timer below is guarded on
            // `this._archiveAttestRound === round`, so a displaced round's timer no-ops
            // and _checkArchiveAttestQuorum only ever looks at the live field: without
            // this, the _publishArchive awaiting the displaced round waits forever. Same
            // shape as the stop() teardown. The archive leg is the reachable one: the v0
            // twin's caller runs only inside flush(), which _flushing serializes.
            let displaced = this._archiveAttestRound;
            if(displaced && !displaced.done){
                displaced.done = true;
                if(displaced.timer) clearTimeout(displaced.timer);
                console.warn('StateAnchorPublisher: archive publisher-attestation round (batch ' +
                             displaced.batchSeq + ') displaced by batch ' + batchSeq +
                             '; settling it unattested so its publish is not stranded');
                if(displaced.resolve) displaced.resolve({ met: false, sigs: [] });
            }
            this._archiveAttestRound = round;
            round.timer = setTimeout(() => {
                // Fire on !round.done alone. A round that has been displaced is already
                // marked done above, so the identity check only ever cost the round that
                // still needed settling.
                if(!round.done){
                    round.done = true;
                    if(this._archiveAttestRound === round) this._archiveAttestRound = null;
                    console.warn('StateAnchorPublisher: archive publisher-attestation round (batch ' + batchSeq +
                                 ') timed out at ' + round.signatures.size + '/' + quorum +
                                 ' sigs; ATTEST_SIG_COUNT 0 fallback');
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
    // failover ladder as the checkpoint leg: the election key is anchored on the archive
    // CONTENT (wrapper checkpoint + batch seq; deterministic + identical on
    // every hub, and stable while the batch is stalled), and each further rank
    // unlocks after another ANCHOR_ELECTION_TOLERANCE_BLOCKS past the wrapper
    // checkpoint's snapshot_block. Without the ladder a signer-less elected
    // leader stalled archiving (live on a 3-hub test cluster: only 1-of-3 elections could
    // publish; on a static regtest tip the same leader won forever). Returns
    // the flush summary's archive status.
    async _startArchiveRound(signer, electionBlock, failoverOnly){
        // One at a time across BOTH phases: a round collecting signatures, and a round
        // whose publish is already in flight (see _archivePublishing).
        if(this._archiveRound || this._archivePublishing) return 'round_pending';

        // Fail closed on an unresolved BTC tip. flush() passes whatever
        // hub._resolveBtcLatestBlock() returned, and that is null whenever the pushed tip
        // is stale, the indexer lags past MAX_INDEXER_LAG_BLOCKS, or the RPC fails. A null
        // block makes _getActiveOraclePublishPubkeys take its block-UNPINNED branch, whose
        // own contract scopes it to the coarse BUNDLE_DONE / FINALIZED sender pre-filter: it
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
        //     on-chain from the v0/v1 XANCPUB publisher attestation (anchor.js
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
            rewardIds:  rewardRows.map(({row}) => ({ reward_type: String(row.reward_type), round_number: Number(row.round_number), validator_pubkey: String(row.validator_pubkey).toLowerCase(), round_qualifier: Number(row.round_qualifier || 0) })),
            validators: roundValidators,
            signatures: signatures,
            done:       false,
            timer:      null
        };

        if(snapCount <= 1){                                                   // single-node: self-sign suffices
            // A held publish never archived anything, so the pending counter must NOT be
            // cleared: the rows really are still pending and the next flush re-checks.
            let result;
            this._archivePublishing = round;
            try {
                result = await this._publishArchive(round);
            } finally {
                this._archivePublishing = null;
            }
            if(result === 'intent_held') return 'intent_held';
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
            case XANC_BUNDLE_DONE:   this._handleBundleDone(envelope).catch(e => console.error('StateAnchorPublisher: BUNDLE_DONE error: ' + (e && e.message)));     break;
            case XANCPUB_SIGN_REQ: this._handleAttestSignReq(envelope).catch(e => console.error('StateAnchorPublisher: XANCPUB_SIGN_REQ error: ' + (e && e.message))); break;
            case XANCPUB_SIGN:     this._handleAttestSign(envelope).catch(e => console.error('StateAnchorPublisher: XANCPUB_SIGN error: ' + (e && e.message)));         break;
            case XANCARCHPUB_SIGN_REQ: this._handleArchiveAttestSignReq(envelope).catch(e => console.error('StateAnchorPublisher: XANCARCHPUB_SIGN_REQ error: ' + (e && e.message))); break;
            case XANCARCHPUB_SIGN:     this._handleArchiveAttestSign(envelope).catch(e => console.error('StateAnchorPublisher: XANCARCHPUB_SIGN error: ' + (e && e.message)));         break;
            case XANCREWARD:           this._handleRewardAttestation(envelope).catch(e => console.error('StateAnchorPublisher: XANCREWARD error: ' + (e && e.message)));               break;
        }
    }

    // Peer back-fill for a published ANCHOR v0 BUNDLE. Gated on membership + signature +
    // the sender being the rank-unlocked ELECTED bundle publisher for the referenced
    // snapshot block (see the election re-derivation below); a non-elected member can
    // no longer suppress the anchor or mirror itself the reward. The residual
    // (a Byzantine elected publisher announcing a fake txid) is closed by the per-section
    // on-chain verification below. First writer wins per section (IS NULL guard).
    async _handleBundleDone(envelope){
        let d = envelope.data;
        if(!d || !d.txid || !Array.isArray(d.sections) || d.sections.length === 0) return;
        let network = String(d.network || '');
        if(!network) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set: d.sig_pubkey is self-asserted and the sig is
        // verified against it, so membership in the oracle_publish set is the ONLY
        // thing tying this announcement to a federation member. An empty set (startup /
        // registry hiccup) must reject, not admit anyone -- otherwise a forged BUNDLE_DONE
        // stamps a bogus anchor_txid (suppressing the real anchor) and mirrors rewards.
        if(pubkeys.length === 0 || !pubkeys.includes(sender)) return;
        if(!ValidatorIdentity.verify(this._bundleDoneCanonical(d, String(d.txid)), String(d.sig || ''), sender)) return;

        // Our OWN copy of every announced section. Without all of them we cannot vet the
        // election: the bundle's snapshot_block is the MAX over the sections' own, read
        // from quorum-agreed rows, never from the wire.
        let rows = [];
        for(let sec of d.sections){
            let r = await this.db.doQuery(
                'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
                [String(sec.chain), network, Number(sec.block_index), Number(sec.checkpoint_seq)]);
            if(!r || r.length === 0) return;   // no local copy of a section: cannot vet the election
            rows.push(r[0]);
        }
        let snapshotBlock = rows.reduce((m, r) => Math.max(m, Number(r.snapshot_block)), 0);
        // The announced block is signed into the canonical, so a mismatch against what our
        // own rows produce is either a forge or a state divergence; either way, abstain.
        if(Number(d.snapshot_block) !== snapshotBlock) return;

        // Membership + signature alone let ANY oracle_publish member self-assert a bundle
        // it never published, stamping bogus anchor_txids (suppressing the real anchor
        // fleet-wide via the `anchor_txid IS NULL` selector) and mirroring itself the
        // reward. Re-run the SAME bundle election the real publisher ran and require the
        // sender to be rank-unlocked on the failover ladder. Rejecting a BUNDLE_DONE only
        // ever risks a redundant re-anchor (benign, the direction the code already
        // tolerates), never a fork, so using the receiver's own BTC-tip view is safe here.
        let electionSet = await this._getActiveOraclePublishPubkeys(snapshotBlock);
        if(electionSet.length === 0) return;             // fail closed: unresolved election set
        {
            let order = StateAnchorPublisher.hashOrder(
                this._bundleElectionKey({ network: network, snapshot_block: snapshotBlock }), electionSet);
            let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - snapshotBlock : null;
            if(!this._rankUnlocked(order, sender, since)) return;   // sender is not a rank-unlocked elected publisher
        }
        // The election gate proves the SENDER is an elected publisher, NOT that it ever
        // published this anchor. Confirm the bundle is really on DOGE at >=
        // XCHAIN_CONFIRMATIONS_DOGE depth by asking OUR OWN DOGE indexer for the DECODED
        // row of EVERY section (payload hashes must byte-match our own copies), which is
        // also what proves the txid carries the whole announced set rather than one chain.
        // ABSTAIN (queue) when the indexer is unwired/unreachable or the anchor is
        // absent/shallow; REJECT on a decoded-invalid status or a hash mismatch.
        let verdicts = [];
        for(let row of rows)
            verdicts.push(await this._verifyAnchorOnChain(row, { txid: String(d.txid), rejectVersions: [1, 2] }));
        let rejected = verdicts.find(v => String(v).startsWith('rejected'));
        if(rejected){
            console.warn('StateAnchorPublisher: BUNDLE_DONE for ' + network + ' @ ' + snapshotBlock +
                         ' REJECTED on-chain (' + rejected + '); skipping stamp + reward');
            return;
        }
        let unproven = verdicts.find(v => v !== 'verified');
        if(unproven){
            // NOT a rejection: the publisher announces at 0 confirmations (the broadcast
            // returns a mempool txid), so 'absent' / 'shallow' is the NORMAL first answer
            // for a perfectly honest bundle, and 'unreachable' / 'no-indexer' /
            // 'no-txid-support' are local-wiring faults that clear on their own. Dropping
            // those is what left anchor_txid NULL fleet-wide. Queue for re-verification;
            // the queued entry is re-verified in full before it can stamp anything, so
            // queuing grants no authority.
            this._deferBundleDone(d, sender, unproven);
            return;
        }
        await this._applyBundleDone(d, sender, rows);
    }

    // Queue an authenticated-but-not-yet-buried BUNDLE_DONE for re-verification. Keyed on
    // the announcement's identity INCLUDING the txid, so two competing txids for one
    // bundle are tracked separately and whichever actually confirms wins.
    _deferBundleDone(d, sender, reason){
        let key = [String(d.network), Number(d.snapshot_block), String(d.txid)].join('|');
        if(this._deferredBundleDone.has(key)) return;
        // Bounded: drop the OLDEST entry rather than the new one (Map preserves
        // insertion order), so a flood cannot pin the queue on stale announcements.
        if(this._deferredBundleDone.size >= this.announceQueueMax){
            let oldest = this._deferredBundleDone.keys().next().value;
            this._deferredBundleDone.delete(oldest);
            console.warn('StateAnchorPublisher: deferred BUNDLE_DONE queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        this._deferredBundleDone.set(key, { d: d, sender: sender, at: Date.now() });
        console.log('StateAnchorPublisher: BUNDLE_DONE for ' + d.network + ' @ ' + d.snapshot_block +
                    ' not yet buried (' + reason + '); queued for re-verification (' +
                    this._deferredBundleDone.size + ' pending)');
    }

    // Re-verify queued BUNDLE_DONE announcements and stamp the ones that have since been
    // buried. Runs on its own timer (announceRetryMs) and at the head of every flush.
    // The announcement's authenticity (membership, signature over the txid-bearing
    // canonical, publisher election at the bundle's immutable snapshot_block) was settled
    // at receipt and cannot change; what is re-checked is the ONE thing that does change,
    // namely whether the bundle is really on DOGE at depth.
    async _drainDeferredBundleDone(){
        if(this._deferredBundleDone.size === 0) return;
        for(let [key, entry] of [...this._deferredBundleDone]){
            let d = entry.d;
            if(Date.now() - entry.at > this.announceRetryTtlMs){
                this._deferredBundleDone.delete(key);
                console.warn('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' expired after ' +
                             this.announceRetryTtlMs + 'ms without confirming; dropping so the failover ' +
                             'ladder can re-anchor if the bundle is still pending');
                continue;
            }
            try {
                let rows = [], allStamped = true;
                for(let sec of d.sections){
                    let r = await this.db.doQuery(
                        'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1',
                        [String(sec.chain), String(d.network), Number(sec.block_index), Number(sec.checkpoint_seq)]);
                    if(!r || r.length === 0){ rows = null; break; }   // section gone (reorg): let the TTL clear it
                    if(r[0].anchor_txid == null) allStamped = false;
                    rows.push(r[0]);
                }
                if(!rows) continue;
                if(allStamped){                    // our own publish or another announcement got there
                    this._deferredBundleDone.delete(key);
                    continue;
                }
                let verdicts = [];
                for(let row of rows)
                    verdicts.push(await this._verifyAnchorOnChain(row, { txid: String(d.txid), rejectVersions: [1, 2] }));
                let rejected = verdicts.find(v => String(v).startsWith('rejected'));
                if(rejected){
                    this._deferredBundleDone.delete(key);
                    console.warn('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' REJECTED on re-verification (' +
                                 rejected + '); dropped');
                    continue;
                }
                if(verdicts.every(v => v === 'verified')){
                    this._deferredBundleDone.delete(key);
                    await this._applyBundleDone(d, entry.sender, rows);
                    console.log('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' confirmed on DOGE; stamped');
                }
            } catch(e){
                console.warn('StateAnchorPublisher: deferred BUNDLE_DONE ' + key + ' re-verification error: ' + (e && e.message));
            }
        }
    }

    // Apply a fully-verified BUNDLE_DONE: stamp anchor_txid on EVERY section and mirror
    // the reward. Shared by the immediate receipt path and the deferred re-verification
    // drain, so an announcement that arrives at 0 confirmations lands EXACTLY the same
    // rows as one that arrives already buried.
    async _applyBundleDone(d, sender, rows){
        // Key each stamp on checkpoint_seq exactly as the publisher's own stamp does:
        // the section list is part of the signed _bundleDoneCanonical, so binding seq here
        // stops one BUNDLE_DONE from marking a DIFFERENT (or multiple) seq row(s) at the
        // same height.
        for(let row of rows){
            await this.db.doQuery(
                'UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL',
                [String(d.txid), String(row.chain), String(d.network), Number(row.block_index), Number(row.checkpoint_seq)]);
        }
        // The bundle's own block, re-derived from OUR copies of the rows (quorum-agreed
        // state, identical on every hub), never from the wire.
        let snapshotBlock = rows.reduce((m, r) => Math.max(m, Number(r.snapshot_block)), 0);
        // At/above the anchor-reward flag-day the reward is indexer-DERIVED from the
        // on-chain v0 attestation. BUNDLE_DONE does not say (and its signed canonical does
        // not bind) whether the tail carried an attestation at all, so a mirror here could
        // mint a reward for a degraded ATTEST_SIG_COUNT 0 bundle that no live indexer
        // credits (a stranded archive-only credit; the live-vs-recovered fork). Skip the
        // mirror at/above the flag-day: the attested publisher records its own row and
        // live + recovering indexers both derive the credit from the on-chain attestation.
        // Below the flag-day the mirror remains the only transport.
        if(!ar.isAnchorRewardActive(snapshotBlock, String(d.network)))
            this._recordReward('anchor_bundle', snapshotBlock, sender, snapshotBlock, String(d.network));
    }

    // The string a BUNDLE_DONE sender signs. It binds the network, the bundle's block,
    // the announced txid AND the full section list (chain:block_index:checkpoint_seq,
    // chain-ascending), so a sender cannot re-point a signed announcement at a different
    // set of checkpoint rows than the one it published.
    _bundleDoneCanonical(d, txid){
        let sections = (d.sections || []).slice().sort((a, b) => {
            let x = String(a.chain), y = String(b.chain);
            return x < y ? -1 : (x > y ? 1 : 0);
        }).map(s => [String(s.chain), String(s.block_index), String(s.checkpoint_seq)].join(':')).join(',');
        return 'XANCBUNDLEDONE|' + String(d.network) + '|' + String(d.snapshot_block) + '|' +
               sections + '|' + String(txid || '');
    }

    // On-chain ANCHOR verification (XANC-ELECTED-FORGE-1 / XANC-V0DONE-SUPPRESS-1
    // residual). A peer's BUNDLE_DONE / FINALIZED announcement is authenticated (signed
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
    //   expect.txid    - the txid the peer announced (signed into the BUNDLE_DONE /
    //                    FINALIZED canonical), so an elected-but-Byzantine publisher
    //                    cannot point at a real-but-different anchor, nor at a
    //                    never-mined one (XANC-ELECTED-FORGE-1).
    //   expect.version - narrows to a specific ANCHOR version (the archive gate binds
    //                    the v1 head), since one checkpoint_seq carries both the v0
    //                    checkpoint bundle and the v1 archive anchor.
    //   expect.rejectVersions - a set of ANCHOR versions to REJECT when no single
    //                    exact version is expected (the BUNDLE_DONE checkpoint path passes
    //                    {1,2}, the archive-carrying set ARCHIVE_VERSIONS names in
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
        // expected. The BUNDLE_DONE path accepts the CHECKPOINT-anchor version
        // ({0}) but must not accept an ARCHIVE anchor ({1,2}): one
        // checkpoint_seq carries both, and the 4-core-hash byte-match below
        // passes for a v1 archive whose wrapper is this same checkpoint, so
        // without this a Byzantine bundle publisher could name a confirmed v1
        // archive txid as proof of a v0 anchor (stamping the row fleet-wide and
        // mirroring a reward it never earned).
        if(Array.isArray(want.rejectVersions) &&
           want.rejectVersions.map(Number).includes(Number(res.version))) return 'rejected:version';
        // Byte-match the decoded on-chain payload against our own checkpoint. The
        // four core hashes are present on every checkpoint version; state_root and
        // block_merkle_root are compared only when the on-chain anchor is a
        // root-bearing version (v0, the bundle), matching the payload the publisher
        // signed. The v1 archive heads carry no roots and are rejected by
        // rejectVersions above.
        if(!this._anchorHashEq(res.block_hash,    cp.block_hash)    ||
           !this._anchorHashEq(res.ledger_hash,   cp.ledger_hash)   ||
           !this._anchorHashEq(res.actions_hash,  cp.actions_hash)  ||
           !this._anchorHashEq(res.contract_hash, cp.contract_hash)) return 'rejected:mismatch';
        if(Number(res.version) === 0){
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
        // _handleBundleDone already do. The old fall-through skipped BOTH the rank ladder and
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
        // The body byte-matches our own rows, so its membership is the authority on which
        // rows this batch may later mark archived. Record it BEFORE co-signing: the
        // signature about to go out is part of what carries this exact archive to DOGE,
        // and the FINALIZED that closes the round is checked against it.
        this._recordObservedArchiveContent(Number(d.batch_seq), sender, archive);

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
            // anchor_bundle is the ONLY per-anchor reward the v0 bundle rail records, and it takes the
            // per-chain form's frozen amount and flag-day (RewardTracker isDerivedBundle). Omit
            // it here and every bundle row falls through to the operator-tunable
            // ANCHOR_REWARD_PER_PUBLISH, so a hub carrying that override refuses to co-sign a
            // correct archive (quorum stalls) or signs a non-frozen amount into COLLECT
            // bookkeeping. Keep this branch in lockstep with RewardTracker.
            let isDerivedBundle  = String(rr.reward_type || '') === 'anchor_bundle' &&
                                   ar.isAnchorRewardActive(Number(rr.block_index), recordNetwork);
            let isDerivedArchive = String(rr.reward_type || '') === 'anchor_archive' &&
                                   ar.isArchiveRewardActive(Number(rr.block_index), recordNetwork);
            let expectedAmount = (isDerivedChain || isDerivedBundle)
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
            // round_number, round_qualifier). The qualifier is the archive leg's
            // snapshot block: round_number is a reissuable MATCH_BATCH_SEQ, so without
            // it a rebase-reissued seq matched an OLDER archive's rows and this guard
            // refused to co-sign a perfectly valid archive.
            // Reward rows are written independently by every hub
            // from the same on-chain anchor-publish events, so an honest hub that
            // saw this round derives the SAME winner set. The table's UNIQUE key
            // is (validator_pubkey, round_number, reward_type, round_qualifier), so two pubkeys can
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
                'SELECT validator_pubkey, amount, block_index FROM validator_rewards WHERE reward_type = ? AND round_number = ? AND round_qualifier = ?',
                [String(rr.reward_type), Number(rr.round_number),
                 ark.rewardRoundQualifier(rr.reward_type, rr.block_index)]);
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
        // Hand the guard over BEFORE releasing _archiveRound, so no window exists in
        // which neither field is set. This runs from _handleSign, outside flush()'s
        // mutex, and the publish below awaits a peer round wide enough for several
        // flush ticks to fire inside it.
        this._archivePublishing = round;
        this._archiveRound = null;
        // Same rule as the single-node path: a round held by a surviving broadcast
        // intent published nothing, so the pending counter stays as it was.
        let result;
        try {
            result = await this._publishArchive(round);
        } finally {
            this._archivePublishing = null;
        }
        if(result !== 'intent_held') this._pendingMatches = 0;
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
        // canonical binding THIS hub as the earner) so the indexer DERIVES the
        // anchor_archive reward and the last key-authenticated push is retired.
        // LIVENESS-SAFE: a degraded round (timeout / short quorum / not a snapshot member)
        // still emits the SAME v1 wire, with ATTEST_SIG_COUNT 0 (D4), so the archive
        // always lands; only reward issuance gains the quorum dependency.
        let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let attested = false;   // a reward-derivable attestation tail was actually collected
        let attestSigs = [];
        if(me && ar.isArchiveRewardActive(Number(cp.snapshot_block), cp.network)){
            let attest = await this._runArchiveAttestationRound(cp, round.batchSeq, me);
            if(attest && attest.met && attest.sigs.length >= 1){
                attestSigs = attest.sigs;
                attested = true;
            } else {
                console.warn('StateAnchorPublisher: archive publisher-attestation quorum not reached for batch ' +
                             round.batchSeq + '; publishing v1 with ATTEST_SIG_COUNT 0 (archive lands, no reward)');
            }
        }
        // ONE archive-head wire, always v1 (D4). The version byte no longer encodes
        // whether the attestation round met quorum: the degraded round emits the same v1
        // with ATTEST_SIG_COUNT 0, exactly as the v0 bundle leg already does. A second
        // tail-less shape would need its own parser branch on every consumer and buys
        // nothing the count field does not already say.
        let parts = ['ANCHOR', '1', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                     cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                     String(cp.checkpoint_seq), String(cp.snapshot_block),
                     String(round.batchSeq), String(round.count), round.crc,
                     String(round.chunks.length), round.chunks[0], String(sigs.length)];
        for(let s of sigs) parts.push(s.pubkey, s.sig);
        // The publisher tail is UNCONDITIONAL. Field order MUST match the indexer parser
        // (anchor.js formats[1]):
        // ...|SIG_COUNT|PUBKEY|SIG|...|PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
        // Mirrors _buildV7Payload's tail, empty-publisher fallback included, so the two
        // legs degrade identically.
        parts.push(String(me || '').toLowerCase(), String(attestSigs.length));
        for(let s of attestSigs) parts.push(String(s.pubkey).toLowerCase(), String(s.sig).toLowerCase());
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
            // v1 publisher attestation, and the indexer credits NOTHING for a v1 whose
            // ATTEST_SIG_COUNT is 0. Recording it anyway would strand the credit in
            // hub-local + archive bookkeeping only, forking the COLLECT rail
            // live-vs-recovered (same reasoning as the v0 degraded-fallback withhold).
            if(attested || !ar.isArchiveRewardActive(Number(round.cp.snapshot_block), round.cp.network)){
                this._recordReward('anchor_archive', round.batchSeq,
                                   this.identity ? this.identity.getPubkeyHex() : null,
                                   Number(round.cp.snapshot_block), round.cp.network);
                // Option C: mirror the archive XANCPUB quorum so the BTC indexer derives
                // the anchor_archive reward (only when the attestation tail actually landed).
                // Same confirm-then-write rule as the v0 bundle site. onChainValid above
                // is a signature-quorum verdict, not proof the v1 head was mined, and `txid` is
                // the mempool txid _broadcastWithRetry returned, so the row is queued until the
                // head is buried at version 1.
                if(attested){
                    let mePk = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
                    if(mePk)
                        this._deferRewardAttestation({
                            chain: round.cp.chain, network: round.cp.network,
                            blockIndex: Number(round.cp.block_index), checkpointSeq: Number(round.cp.checkpoint_seq),
                            txid: txid, anchorVersion: 1,
                            rewardType: 'anchor_archive', roundReference: Number(round.batchSeq),
                            snapshotBlock: Number(round.cp.snapshot_block),
                            publisher: mePk, attestSigs: attestSigs,
                            federate: true      // archive leader owns the fan-out, same as the v0 bundle site
                        });
                }
            } else {
                console.log('StateAnchorPublisher: degraded v1 archive (ATTEST_SIG_COUNT 0) at/above the ' +
                            'archive-reward flag-day for batch ' + round.batchSeq +
                            '; reward withheld (no live indexer derives it)');
            }
        }
    }

    // Back-fills batch metadata from the archive leader so a rotated leader doesn't re-archive.
    async _handleFinalized(envelope){
        let d = envelope.data;
        if(!d || !Array.isArray(d.matches)) return;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(null);
        // Fail CLOSED on an empty set (see _handleBundleDone): membership is the only tie
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
        // XANC-FINALIZED-MEMBER-1. The check above asks only that each announced row
        // exist locally at the announced status, and the XANCFIN canonical commits to the
        // match COUNT, never to WHICH rows. An elected leader can therefore archive a
        // handful of rows and announce hundreds of other real, correctly-statused ones:
        // the back-fill stamps archived_status = status on every one, and the pending
        // selectors (`batch_seq IS NULL OR archived_status <> status`) then skip a
        // TERMINAL row forever, so rows no archive on DOGE ever carried are suppressed
        // and unreachable to full-parse recovery. Hold the announcement to the archive
        // body this hub decompressed and byte-verified for its co-sign. An honest leader
        // announces exactly round.matchIds, the same array _buildArchive serialized, so
        // this costs no liveness; a stray row leaves the WHOLE back-fill unstamped and
        // the rows re-archive under a fresh seq.
        //
        // A hub that never parsed a body for this (batch_seq, proposer) abstains, so the
        // gate binds the co-signers rather than every listener. Closing the residual (the
        // co-signed body is the one that reached DOGE) needs the archive head's crc32 and
        // match_count read back from an author-agnostic getarchiveanchor, which today
        // scopes its lookup to the CALLER's own DOGE address and so cannot answer for a
        // peer's head.
        let stray = this._finalizedOutsideObservedArchive(Number(d.batch_seq), sender, d.matches, calls, rewards);
        if(stray){
            console.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') announces ' + stray +
                         ', which the archive we co-signed for this batch does not carry; ignoring the ' +
                         'back-fill (rows stay pending and re-archive under a fresh seq)');
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
        // (mempool) exactly like XANC_BUNDLE_DONE, so it needs the same defer-and-re-verify
        // queue (_deferBundleDone / _drainDeferredBundleDone), plus an archive-head version SET
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
        // Archive-head version SET {1}: _publishArchive emits a v1 head at every height,
        // attested or not (D4). This gate runs at ALL heights (row suppression has nothing
        // to do with reward retirement), so it keeps the reject-set form rather than the
        // reward gate's exact-v1 expectation. Rejecting {0,2} still stops a v0 checkpoint
        // bundle or a v2 continuation chunk standing in for the head. v0 MUST be in the
        // reject set and MUST NOT be the emitted head version: the bundle is the wire this
        // gate exists to keep out.
        let archiveOnChain = await this._verifyArchiveCheckpointOnChain(
            Number(d.batch_seq), String(d.txid), { rejectVersions: [0, 2] });
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
        // BUNDLE_DONE mirror). Only a COMPLETE publish earns it (the leader skips
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
                // on-chain from the v1 publisher attestation; the FINALIZED does not say whether
                // the leader's publish carried it (a count-0 tail earns nothing), so
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
    // flush, alongside the BUNDLE_DONE drain. Authenticity (membership, signature over the
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
                                                                   { rejectVersions: [0, 2] });
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
            this._observedArchiveContents.delete(oldest);
        }
    }

    _isObservedArchiveLeader(batchSeq, pubkey){
        let set = this._observedArchiveLeaders.get(batchSeq);
        return !!set && set.has(String(pubkey || '').toLowerCase());
    }

    // Reward identity shared by the archive body and the FINALIZED reward list. The
    // archived record carries no round_qualifier, so the key stops at the three fields
    // both shapes hold.
    static _archiveRewardKey(r){
        return String(r.reward_type) + '|' + String(Number(r.round_number)) + '|' +
               String(r.validator_pubkey).toLowerCase();
    }

    // Record the member ids of an archive body this hub verified against its own rows
    // (called from _handleSignReq once _verifyArchiveAgainstLocal passes, so the parse
    // is already paid for). Keyed by PROPOSER, because the failover ladder legitimately
    // unlocks several ranks for one batch_seq and each proposes its own body. UNIONED
    // across proposals from the same proposer: a round that times out stamps nothing, so
    // _getNextBatchSeq hands the retry the same seq with the rows that accumulated
    // since, and the FINALIZED that follows names the later set.
    _recordObservedArchiveContent(batchSeq, pubkey, archive){
        if(!Number.isFinite(batchSeq) || !pubkey || !archive) return;
        let byProposer = this._observedArchiveContents.get(batchSeq);
        if(!byProposer){ byProposer = new Map(); this._observedArchiveContents.set(batchSeq, byProposer); }
        let key = String(pubkey).toLowerCase();
        let entry = byProposer.get(key);
        if(!entry){ entry = { matches: new Set(), calls: new Set(), rewards: new Set() }; byProposer.set(key, entry); }
        for(let m of (archive.matches || []))
            if(m && m.match_id != null) entry.matches.add(String(m.match_id));
        for(let c of (archive.calls || []))
            if(c && c.call_id != null) entry.calls.add(String(c.call_id) + '|' + String(c.phase));
        for(let r of (archive.rewards || []))
            if(r && r.reward_type != null) entry.rewards.add(StateAnchorPublisher._archiveRewardKey(r));
        // Bounded on its own terms as well as through the leader map's lockstep evict,
        // so a body recorded for a seq whose leader entry is already gone cannot pin
        // memory.
        while(this._observedArchiveContents.size > this._observedArchiveLeadersCap){
            let oldest = null;
            for(let k of this._observedArchiveContents.keys()) if(oldest === null || k < oldest) oldest = k;
            if(oldest === null) break;
            this._observedArchiveContents.delete(oldest);
        }
    }

    // Name the first row a FINALIZED announces that the archive body we co-signed for
    // this (batch_seq, proposer) does not carry, or null when every announced row is a
    // member. ABSTAINS (null) when we hold no body for that pair: a hub outside the
    // snapshot_block signing set never decompresses one, and decompressing on its behalf
    // would hand every p2p peer a per-message gzip and CPU amplifier for the sake of
    // local bookkeeping.
    _finalizedOutsideObservedArchive(batchSeq, sender, matches, calls, rewards){
        let byProposer = this._observedArchiveContents.get(Number(batchSeq));
        let entry = byProposer && byProposer.get(String(sender || '').toLowerCase());
        if(!entry) return null;
        for(let m of (matches || []))
            if(m && m.match_id != null && !entry.matches.has(String(m.match_id)))
                return 'match ' + String(m.match_id).substring(0, 16) + '...';
        for(let c of (calls || []))
            if(c && c.call_id != null && !entry.calls.has(String(c.call_id) + '|' + String(c.phase)))
                return 'call ' + String(c.call_id).substring(0, 16) + '... (' + c.phase + ')';
        for(let r of (rewards || []))
            if(r && r.reward_type != null && !entry.rewards.has(StateAnchorPublisher._archiveRewardKey(r)))
                return 'reward ' + String(r.reward_type) + '/#' + String(r.round_number);
        return null;
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
    // (_publishArchive broadcasts the v1 payload first, then the v2 continuation
    // chunks). Binding it, plus the archive-head version set {1}, closes the archive
    // half of XANC-ELECTED-FORGE-1: proving the CHECKPOINT is anchored is not enough,
    // because an elected leader could reference a real-but-different anchored checkpoint
    // and still mirror itself the anchor_archive reward (below the flag-day;
    // at/above it the mirror is retired outright).
    // `expect` overrides the version expectation for callers that run at ALL heights
    // (the back-fill gate passes rejectVersions [0,2], i.e. the archive-head
    // SET {1}); omitted, it keeps the reward gate's exact-v1 expectation below.
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
            // Rows are immutable; batch_seq is the only archive bookkeeping. Qualify the
            // stamp so a rebase-reissued archive seq cannot mark its twin archived and
            // strand it (the archive selector only picks up batch_seq IS NULL). A
            // FINALIZED from a peer predating the qualifier carries none, so fall back to
            // the unqualified stamp rather than matching nothing during a rolling deploy.
            let qualified = (r.round_qualifier !== undefined && r.round_qualifier !== null);
            let args = [batchSeq, String(r.reward_type), Number(r.round_number), String(r.validator_pubkey).toLowerCase()];
            if(qualified) args.push(Number(r.round_qualifier));
            await this.db.doQuery(
                'UPDATE validator_rewards SET batch_seq = ? WHERE reward_type = ? AND round_number = ? AND validator_pubkey = ? ' +
                (qualified ? 'AND round_qualifier = ? ' : '') + 'AND batch_seq IS NULL',
                args);
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
        // Unpinned CURRENT-membership query (blockIndex null): the coarse BUNDLE_DONE /
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
        // Explicit attempt counter rather than a `for` step: a rate-limit wait below
        // retries WITHOUT consuming an attempt (the encoder is telling us when to come
        // back, which is not a transient send failure), and `delayMs` carries the wait
        // that branch chose so the loop top never double-sleeps it with the flat delay.
        let attempt = 0;
        let delayMs = 0;
        let rateLimitWaits = 0;
        while(attempt < attempts){
            if(delayMs > 0) await this._sleep(delayMs);
            delayMs = this.chunkRetryDelayMs;
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
                // Encoder rate limiting. Safe to retry by the shared classifier's own
                // rule: a sub-500 response is a definitive refusal, so nothing reached
                // the coin node and no double spend is possible. The spend guard was
                // consumed once at method entry and record() only fires on a successful
                // fresh send, so a free retry here re-charges neither.
                let rlWaitMs = this._rateLimitWaitMs(e);
                if(rlWaitMs !== null){
                    if(rateLimitWaits >= this.rateLimitMaxWaits) throw e;
                    rateLimitWaits++;
                    delayMs = rlWaitMs;
                    console.warn('StateAnchorPublisher: encoder rate-limited the anchor broadcast; ' +
                                 'waiting ' + rlWaitMs + 'ms (Retry-After honoured, capped at ' +
                                 this.rateLimitMaxWaitMs + 'ms), ' +
                                 (this.rateLimitMaxWaits - rateLimitWaits) + ' rate-limit wait(s) left ' +
                                 'before this anchor defers to a later flush');
                    continue;   // deliberately does NOT consume an attempt
                }
                attempt++;
            }
        }
        throw lastErr || new Error('broadcast failed');
    }

    // Sleep indirection so the retry paths above are testable without real waits
    // (the test tree's blind-sleep gate rejects fixed waits in tests).
    async _sleep(ms){
        return new Promise(r => setTimeout(r, ms));
    }

    // Rate-limit wait for a failed encoder call, or null when the error is not a
    // rate limit. Reads the encoder's own signal rather than guessing a curve: the
    // per-IP limiter and the concurrency gate both answer 429/-32029 but want waits
    // ~60x apart. A missing or unparseable header falls back to the flat retry delay
    // (still a wait, never an unbounded one), and every result is clamped.
    _rateLimitWaitMs(e){
        if(!e) return null;
        let status = e.response ? Number(e.response.status) : NaN;
        if(status !== 429 && Number(e.rpcCode) !== -32029) return null;
        let headers = (e.response && e.response.headers) || {};
        let raw = headers['retry-after'];
        if(raw === undefined) raw = headers['Retry-After'];
        let ms = parseRetryAfterMs(raw);
        if(ms === null) ms = this.chunkRetryDelayMs;
        let cap = Number(this.rateLimitMaxWaitMs);
        if(!Number.isFinite(cap) || cap < 0) cap = 60000;
        return Math.min(Math.max(ms, 0), cap);
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

    // Existence check for ONE SECTION of a checkpoint anchor (v0): asks our own
    // DOGE indexer whether this checkpoint already has a mined, non-invalid
    // anchor. Returns { exists: true, txid } / null (definitively absent);
    // THROWS when undetermined (no indexer wired, unreachable, error reply), so
    // _broadcastWithRetry can distinguish "absent" from "can't tell". Any depth
    // counts: even a 1-conf anchor spent our DOGE, so re-broadcasting would
    // double-spend regardless of whether it is deep enough to 'verify' yet.
    //
    // getanchoraction does NOT serve checkpoint anchors only. Its
    // CHECKPOINT_VERSIONS set (indexer anchor-action-query.js: [0,1])
    // carries the v1 ARCHIVE HEADS as well, and an archive head wraps a
    // checkpoint under the SAME (chain, network, block_index, checkpoint_seq)
    // identity it is keyed on, so an UNFILTERED lookup answers with whichever
    // row landed at the higher action_index. Adopting an archive head as this
    // checkpoint's anchor stamps the archive txid, skips the real v0 publish
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
        // ANCHOR versions carrying an archive batch (v1 head, v2 continuation
        // chunk) and the ones that really anchor a checkpoint. Mirrors the
        // rejectVersions/{0} split the receiver paths already use. The version set
        // RESTARTED at 0 pre-launch (spec anchor-v0-single-wire.md): {0,1,2} is the
        // complete set, and every legacy number is unparseable at/above
        // ANCHOR_ACTIVATION, so asking for one would be a lookup that can only ever
        // answer absent.
        const ARCHIVE_VERSIONS    = [1, 2];
        const CHECKPOINT_VERSIONS = [0];
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
        // fanning out a lookup it would answer identically.
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

    // Existence check for a whole BUNDLE (spec §2.4), the failover-race guard on the
    // checkpoint leg. Needs NO new RPC and no new index: it calls the per-section lookup
    // above once per section, on the section's own (chain, network, block_index,
    // checkpoint_seq), which is exactly the key `getanchoraction` already serves.
    //
    // Adopts ONLY when EVERY section resolves to a mined, non-invalid v0 row sharing ONE
    // txid. Anything less is not this bundle: a partial answer would stamp some sections
    // from a transaction that does not carry the others, and a second spend for the
    // missing ones is the correct outcome. THROWS when any section is undetermined (no
    // indexer, unreachable), so _broadcastWithRetry keeps its "absent" vs "can't tell"
    // distinction and never re-broadcasts on an unreadable view.
    //
    // The byte-determinism rule (D5) is what makes this sound in a race: two publishers
    // building the same bundle emit identical bytes, so a section adopted here is the
    // section we would have published.
    async _findExistingBundle(sections){
        let txid = null;
        for(let s of sections || []){
            let r = await this._findExistingCheckpointAnchor(s);   // throws when undetermined
            if(!(r && r.exists)) return null;                      // one section absent: not this bundle
            let t = r.txid ? String(r.txid).toLowerCase() : null;
            if(!t) return null;                                    // cannot prove one transaction carried the set
            if(txid === null) txid = t;
            else if(txid !== t) return null;                       // sections anchored by DIFFERENT transactions
        }
        return txid ? { exists: true, txid: txid } : null;
    }

    // CONTENT-ADDRESSED existence check for an ARCHIVE anchor (v1 head + its v2
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

    // existsCheck for the ARCHIVE HEAD broadcast (v1). The head landing is the spend
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
module.exports.XANC_BUNDLE_DONE   = XANC_BUNDLE_DONE;
module.exports.XANCPUB_SIGN_REQ = XANCPUB_SIGN_REQ;
module.exports.XANCPUB_SIGN     = XANCPUB_SIGN;
module.exports.XANCARCHPUB_SIGN_REQ = XANCARCHPUB_SIGN_REQ;
module.exports.XANCARCHPUB_SIGN     = XANCARCHPUB_SIGN;
module.exports.XANCREWARD           = XANCREWARD;
module.exports.MATCH_KEYS     = MATCH_KEYS;
