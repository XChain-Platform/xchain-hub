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
const coins             = require('../coins');
const EncoderClient     = require('../peers/encoder_client.js');
const SpendGuard        = require('../lib/spend_guard.js');
const { bftQuorumOrSingle } = require('../lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('./quorum_network.js');
const { isAmbiguousSendError } = require('../lib/idempotent_broadcast.js');
const { sumUtxosCoins, summarizeUtxoConfirmations } = require('../lib/utxo_balance.js');
const { forwardableUtxos } = require('../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../lib/two_phase_guard.js');
const { abandonBuild }           = require('../lib/encoder_reservation.js');
const { resolveCheckpointIntervalBlocks } = require('./checkpoint_cadence.js');
const ValidatorIdentity = require('../validators/identity.js');
const StateCheckpointEngine = require('./checkpoint_engine.js');
const swq                   = require('../stake_weighted_quorum.js');
const eq                    = require('../equivocation_header.js');
const ckpt                  = require('../checkpoint_commitment_activation.js');
const ccr                   = require('../cross_chain_royalty_activation.js');
const ar                    = require('../anchor_reward_activation.js');
const ark                   = require('./anchor_reward_key.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { installParts } = require('./install_parts.js');
const { ANCHOR_BUNDLE_MAX_BYTES, DEFAULT_ANCHOR_MARKER_RETENTION_MS,
        MATCH_KEYS, CALL_KEYS, XANC_SIGN_REQ, XANC_SIGN, XANC_FINALIZED, XANC_BUNDLE_DONE,
        XANCPUB_SIGN_REQ, XANCPUB_SIGN, XANCARCHPUB_SIGN_REQ, XANCARCHPUB_SIGN,
        XANCREWARD } = require('./publisher/constants.js');
const { getLogger } = require('../observability');
const logger = getLogger();


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
        // test/unit/state_anchor_publisher_constant_derivations.test.js, so a retune
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
        //   splitChunks trivial.
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
        this.enabled       = String(hubConfig.ANCHOR_ENABLED || cfg.ANCHOR_ENABLED || 'true') !== 'false';
        this.intervalMs    = parseInt(hubConfig.ANCHOR_INTERVAL_MS      || cfg.ANCHOR_INTERVAL_MS      || '86400000'); // daily
        this.batchSize     = parseInt(hubConfig.ANCHOR_MATCH_BATCH_SIZE || cfg.ANCHOR_MATCH_BATCH_SIZE || '200');
        this.maxBatch      = parseInt(hubConfig.ANCHOR_MAX_BATCH        || cfg.ANCHOR_MAX_BATCH        || '1000');
        this.chunkMaxBytes = parseInt(hubConfig.ANCHOR_CHUNK_MAX_BYTES  || cfg.ANCHOR_CHUNK_MAX_BYTES  || '6000');
        this.roundTimeoutMs = parseInt(hubConfig.ANCHOR_ROUND_TIMEOUT_MS || cfg.ANCHOR_ROUND_TIMEOUT_MS || '120000');
        this.chunkRetryDelayMs = parseInt(hubConfig.ANCHOR_CHUNK_RETRY_MS || cfg.ANCHOR_CHUNK_RETRY_MS || '2500');
        // Encoder rate-limit (429) waits, which are NOT the transient-failure retry
        // above. The encoder sheds two different ways and both answer 429 + a
        // Retry-After the caller should obey rather than guess: the per-IP limiter
        // (xchain-encoder api.js, 60s window) sends a window-length Retry-After, and
        // the concurrency gate sends Retry-After: 1. A flat chunkRetryDelayMs spends
        // the whole 5-attempt budget in ~10s inside a 60s window while adding load to
        // an already-shedding replica. rateLimitMaxWaitMs caps one honoured wait;
        // rateLimitMaxWaits caps how many a single broadcast may take before the
        // anchor defers to a later flush instead of stalling this one.
        this.rateLimitMaxWaitMs = parseInt(hubConfig.ANCHOR_RATELIMIT_MAX_WAIT_MS || cfg.ANCHOR_RATELIMIT_MAX_WAIT_MS || '60000');
        this.rateLimitMaxWaits  = parseInt(hubConfig.ANCHOR_RATELIMIT_MAX_WAITS   || cfg.ANCHOR_RATELIMIT_MAX_WAITS   || '3');
        // Ambiguous-send existence poll: how long to wait for a maybe-
        // accepted anchor to reach the indexer's mined view before deferring.
        this.ambiguousPollAttempts = parseInt(hubConfig.ANCHOR_AMBIGUOUS_POLL_ATTEMPTS || cfg.ANCHOR_AMBIGUOUS_POLL_ATTEMPTS || '3');
        this.ambiguousPollDelayMs  = parseInt(hubConfig.ANCHOR_AMBIGUOUS_POLL_MS       || cfg.ANCHOR_AMBIGUOUS_POLL_MS       || '5000');
        // Failover-ladder step (see the derivation above; the ladder itself is in
        // _rankUnlocked). The unit is BTC BLOCKS, not wall clock, precisely so
        // every hub computes the same rank unlock without clock sync; 36 blocks is
        // ~6h at the 10-minute target. The ORDERING is the load-bearing part:
        //   round timeout (120s) + DOGE burial (60 confs, ~1h)
        //     <<  36 blocks (~6h)  <<  ANCHOR_INTERVAL_MS (24h)
        // Left inequality: a healthy but slow leader is never overtaken, so the
        // federation does not pay DOGE twice for the same checkpoint (it also keeps
        // the on-chain verification wait in handleBundleDone well inside one rank).
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
        // sit from our own BTC tip in handleSignReq (anti-spam only; the security
        // property there is the DB byte-match).
        this.electionToleranceBlocks = parseInt(hubConfig.ANCHOR_ELECTION_TOLERANCE_BLOCKS || cfg.ANCHOR_ELECTION_TOLERANCE_BLOCKS || '36');
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
        this.rankWakeMs = parseInt(hubConfig.ANCHOR_RANK_WAKE_MS || cfg.ANCHOR_RANK_WAKE_MS || '900000');  // 15 min
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
        this.startupFlushMs = parseInt(hubConfig.ANCHOR_STARTUP_FLUSH_MS || cfg.ANCHOR_STARTUP_FLUSH_MS, 10);
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
            String(hubConfig.ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS ||
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
        this.confirmCheckIntervalMs  = parseInt(hubConfig.ANCHOR_CONFIRM_CHECK_MS || cfg.ANCHOR_CONFIRM_CHECK_MS, 10);
        if(!Number.isFinite(this.confirmCheckIntervalMs) || this.confirmCheckIntervalMs < 0) this.confirmCheckIntervalMs = 300000;   // 5 min
        this.confirmStaleMs = parseInt(hubConfig.ANCHOR_CONFIRM_STALE_MS || cfg.ANCHOR_CONFIRM_STALE_MS, 10);
        if(!Number.isFinite(this.confirmStaleMs) || this.confirmStaleMs < 0) this.confirmStaleMs = 1800000;   // 30 min
        this._confirmTimer            = null;
        this.confirmedPublishes       = 0;
        this.confirmationCheckFailures = 0;
        this.lastConfirmationCheckAt  = null;
        this.lowBalanceThreshold = parseFloat(hubConfig.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
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
            parseInt(hubConfig.ANCHOR_CHECKPOINT_EVERY_N || cfg.ANCHOR_CHECKPOINT_EVERY_N || '1') || 1);
        // The engine's own cadence step (StateCheckpointEngine.js), resolved through the
        // one shared function it also calls so the two cannot drift. Always positive: a
        // zero divisor makes the SQL MOD NULL, which would silently select nothing.
        this.checkpointIntervalBlocks = resolveCheckpointIntervalBlocks(cfg);

        this.dogeAddress   = hubConfig.DOGE_ADDRESS    || cfg.DOGE_ADDRESS    || '';
        this.dogePubkeyHex = hubConfig.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        let encoderUrl = hubConfig.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = hubConfig.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks; unset -> borrow the price publisher's DOGE signer.
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        this._archiveRound     = null;  // leader-side archive signing round (one at a time)
        // The round whose _publishArchive is IN FLIGHT. _archiveRound covers only the
        // signature-collection phase and is cleared the moment quorum is met, which leaves
        // the whole publish unguarded: quorum can arrive on a peer message (handleSign),
        // outside flush()'s _flushing mutex, and _publishArchive does not arm its durable
        // dedupe marker (recordArchiveIntent) until AFTER the publisher-attestation round,
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
        // Last DOGE balance observed by checkBalance (refreshed each flush) and
        // when, surfaced via getAnchorStats so an operator/monitor can watch the
        // publisher wallet's runway (it spends real DOGE on every anchor cycle)
        // without log-grepping the low-balance warning. null until the first
        // balance read (no pipeline / before first flush).
        this._lastBalance   = null;
        this._lastBalanceAt = null;
        // Locally-observed archive-round leaders: batch_seq -> Set(elected leader
        // pubkeys). Populated in handleSignReq once a SIGN_REQ sender has validated
        // as the (rank-unlocked) elected archive leader for that batch_seq AND its
        // signature over the archive canonical verifies (the rank ladder alone is
        // wire-keyed, so the signature is what proves the sender holds the key it
        // names), and consulted in handleFinalized to authenticate the
        // FINALIZED sender. The archive election is keyed on election_block (the
        // BTC tip at archive time), which the FINALIZED canonical does NOT carry,
        // so it cannot be re-derived at finalize time; this binds it from the
        // round we actually observed. Bounded (batch_seq is monotonic, evict the
        // smallest keys) so a long-lived hub never grows this without limit.
        this._observedArchiveLeaders = new Map();
        this._observedArchiveLeadersCap = 256;
        // Checkpoint IDENTITY observed per batch_seq (from the SIGN_REQ, recorded
        // alongside the leader). FINALIZED carries only batch_seq, not the
        // checkpoint identity getanchoraction needs, so handleFinalized reads this
        // to verify the batch's archive checkpoint landed on DOGE before mirroring
        // the anchor_archive reward (mirrored below the archive-reward
        // flag-day; derived on-chain from the ANCHOR v1 tail at/above it). Identity only,
        // re-SELECTed against our own rows, and evicted in lockstep with the leader map.
        this._observedArchiveCheckpoints = new Map();
        // Archive MEMBERSHIP observed per (batch_seq, proposer), from a SIGN_REQ body
        // this hub decompressed, CRC-checked and byte-verified against its own rows for
        // the co-sign decision. The XANCFIN canonical commits to (batch_seq, txid, match
        // COUNT) and never to WHICH rows, so handleFinalized holds the announced id
        // lists to this set before anything is stamped. Recorded ONLY where the body was
        // already parsed, so no hub decompresses an extra archive on the p2p path.
        this._observedArchiveContents = new Map();
        // Highest batch_seq this hub has learned the FEDERATION already consumed, from
        // evidence other than its own rows: an authenticated XANC_FINALIZED, a co-sign
        // refusal naming the refuser's own consumed seq, or an archive head resolved
        // on-chain. -1 means "nothing beyond what our tables show".
        //
        // _getNextBatchSeq is MAX(batch_seq)+1 over THIS hub's rows, which equals the
        // federation's next seq only while every back-fill has landed. A hub that missed
        // one (a withheld/dropped XANC_FINALIZED) draws a seq the federation already
        // spent and rebuilds rows it already archived. This floor carries that knowledge
        // until the missed back-fill actually arrives, so the stale hub converges on the
        // leader's seq without a schema change (there is no table to persist it in, so it
        // is deliberately process-local and re-learned after a restart from the next
        // FINALIZED, refusal or on-chain adopt).
        this._observedConsumedBatchSeq = -1;
        // Sanity bound on that floor. A Byzantine (but signature-verified) member could
        // otherwise announce an absurd seq and permanently skip the numbering; a jump
        // wider than this is logged and ignored, and the honest floor arrives with the
        // next announcement.
        this._archiveSeqFloorMaxJump = 1024;

        // Per-coin indexer JSON-RPC clients (same env -> p2pConfig surface as
        // ReorgHandler / CrossChainCallEngine). Used ONLY for on-chain ANCHOR
        // verification, which always queries the DOGE indexer: every ANCHOR (for a
        // BTC/LTC/DOGE checkpoint) is a DOGE transaction, and only the DOGE
        // decoder+indexer decode the P2SH anchor payload (a raw getrawtransaction
        // cannot bind the tx to the checkpoint). Unset -> verifyAnchorOnChain
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

        // XANC_BUNDLE_DONE is broadcast the instant broadcastWithRetry
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
        this.announceRetryMs      = parseInt(hubConfig.ANCHOR_ANNOUNCE_RETRY_MS      || cfg.ANCHOR_ANNOUNCE_RETRY_MS      || '300000');    // 5 min
        this.announceRetryTtlMs   = parseInt(hubConfig.ANCHOR_ANNOUNCE_RETRY_TTL_MS  || cfg.ANCHOR_ANNOUNCE_RETRY_TTL_MS  || '21600000');  // 6 h, ~6x the 60-conf DOGE window
        this.announceQueueMax     = parseInt(hubConfig.ANCHOR_ANNOUNCE_QUEUE_MAX     || cfg.ANCHOR_ANNOUNCE_QUEUE_MAX     || '500');
        this._deferTimer          = null;
        this._rankWakeTimer       = null;   // failover wake, see rankWakeMs
        // How long a durable broadcast intent with no mined anchor HOLDS its
        // checkpoint (see the anchor_published_checkpoints block below). Same bound and
        // same reasoning as announceRetryTtlMs above: ~6x the 60-conf DOGE window, past
        // which a send that never relayed is not coming back and holding the row costs
        // more than re-broadcasting it.
        this.anchorIntentTtlMs    = parseInt(hubConfig.ANCHOR_INTENT_TTL_MS || cfg.ANCHOR_INTENT_TTL_MS || '21600000');   // 6 h
        // Retention window for the two durable anchor marker tables. Both appended one
        // row per DOGE-spending broadcast and never removed one, so they grew for the
        // life of the deployment while their oracle_published_rounds sibling was swept.
        // Only CONFIRMED rows are pruned, and only past a floor derived from
        // anchorIntentTtlMs; see pruneAnchorMarkers for both invariants. 0 disables
        // pruning; garbage or a negative value falls back to the default.
        this.anchorMarkerRetentionMs = parseInt(hubConfig.ANCHOR_MARKER_RETENTION_MS ||
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

    // The peer 'message' subscription stays in this file rather than in a part.
    // PeerManager.MESSAGE_SUBSCRIBERS names this subscriber StateAnchorPublisher, and
    // the listener-ceiling parity check reads that name off the class exported by
    // the file holding the registration, so the registration lives with the class.
    listenToPeers(){
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
    }

    stopListeningToPeers(){
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
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

    // Reward identity shared by the archive body and the FINALIZED reward list. The
    // archived record carries no round_qualifier, so the key stops at the three fields
    // both shapes hold.
    static archiveRewardKey(r){
        return String(r.reward_type) + '|' + String(Number(r.round_number)) + '|' +
               String(r.validator_pubkey).toLowerCase();
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
    callCanonical(c){
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
    quorumVerified(canonical, sigs, validatorSet, weighted){
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

    async backfillBatch(batchSeq, matchIds, txid, callIds, rewardIds){
        // Every stamp is guarded by the archive-eligibility predicate the
        // pending selectors use (batch_seq IS NULL OR archived_status <> status):
        // a row that is already fully archived can never be re-stamped onto a
        // different batch by a replayed/forged FINALIZED, while legitimate
        // __partial__ re-archives (archived_status <> status) still stamp their
        // fresh seq. Reward rows are immutable, so batch_seq IS NULL is their
        // only pending test (mirrors the reward selector).
        for(let m of matchIds){
            await this.db.updateCrossChainMatchByMatchIdAndBatchSeq(batchSeq, m.status, txid, m.match_id);
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
                let rows = await this.db.findLiveCrossChainMatchesByMatchIds(ids);
                for(let row of rows)
                    this.hub.hubDbBroadcaster.broadcastRow({ table: 'cross_chain_matches', row: row });
            } catch(e){
                logger.warn(nodeUtil.format('StateAnchorPublisher: anchor-stamp re-broadcast failed (mirrors converge on next bootstrap):', e.message));
            }
        }
        for(let c of (callIds || [])){
            await this.db.updateCrossChainCall(batchSeq, c.status, txid, c.call_id, c.phase);
        }
        for(let r of (rewardIds || [])){
            // Rows are immutable; batch_seq is the only archive bookkeeping. Qualify the
            // stamp so a rebase-reissued archive seq cannot mark its twin archived and
            // strand it (the archive selector only picks up batch_seq IS NULL). A
            // FINALIZED from a peer predating the qualifier carries none, so fall back to
            // the unqualified stamp rather than matching nothing during a rolling deploy.
            let qualified = (r.round_qualifier !== undefined && r.round_qualifier !== null);
            let rewardType  = String(r.reward_type);
            let roundNumber = Number(r.round_number);
            let pubkey      = String(r.validator_pubkey).toLowerCase();
            if(qualified)
                await this.db.updateValidatorRewardArchiveBatchSeqByQualifier(batchSeq, rewardType, roundNumber, pubkey, Number(r.round_qualifier));
            else
                await this.db.updateValidatorRewardArchiveBatchSeq(batchSeq, rewardType, roundNumber, pubkey);
        }
    }

    async _getNextBatchSeq(){
        // Spans every batch_seq-bearing table so a fresh seq is unique across
        // matches, calls AND rewards (consensus-uniform: all hubs compute the
        // same next seq from quorum-agreed rows).
        let r = await this.db.getNextAnchorBatchSeq();
        let local = (r && r.length > 0) ? Number(r[0].next_seq) : 0;
        // The rows above are consensus-uniform only once every back-fill has
        // landed. _observedConsumedBatchSeq carries the seqs the federation demonstrably
        // spent while this hub was missing one, so the stale hub converges on the
        // leader's numbering instead of re-proposing a taken seq until the withheld
        // XANC_FINALIZED (which re-stamps the real rows) finally arrives.
        let floor = this._observedConsumedBatchSeq + 1;
        if(!(floor > local)) return local;
        if(floor - local > this._archiveSeqFloorMaxJump){
            logger.warn('StateAnchorPublisher: observed consumed batch seq ' + this._observedConsumedBatchSeq +
                         ' is more than ' + this._archiveSeqFloorMaxJump + ' above our own next seq ' + local +
                         '; ignoring it as implausible and keeping the row-derived seq');
            return local;
        }
        logger.warn('StateAnchorPublisher: own rows give next batch seq ' + local + ' but the federation has ' +
                     'already consumed ' + this._observedConsumedBatchSeq + '; drawing ' + floor +
                     ' (this hub is behind on an archive back-fill)');
        return floor;
    }

    // Maps a state_checkpoints row to the 9 identity fields only; deliberately OMITS
    // state_root / state_root_version / block_merkle_root / block_merkle_version.
    // The co-sign guards that consume this compare via rawCanonicalCheckpoint, so the
    // omission is safe; adding the root fields to only one operand of a guard would flip
    // it fail-closed post-flag-day. Never carry roots here one-sided.
    cpFromRow(row){
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
    crc32Hex(str){
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(str, 'utf8')) : this.crc32Fallback(Buffer.from(str, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    }
    crc32Fallback(buf){
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
                    let rows = await this.db.findCapabilitySnapshotsBySnapshotBlockAndCapability(Number(blockIndex), 'oracle_publish');
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
            logger.warn('StateAnchorPublisher: oracle_publish membership unresolved at block ' +
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

    resolveSigner(){
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
    // (fetchPendingRequestIds): when the caller can answer "did this anchor
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
    //   - ambiguous send err (tagged `anchorAmbiguousSend` by defaultBroadcast)
    //     -> the tx may sit in the DOGE mempool where the indexer cannot see it
    //     yet; poll existsCheck briefly, then DEFER (throw) instead of
    //     re-broadcasting. The row stays pending; the next flush's pre-broadcast
    //     existence check settles it once mined (adopt) or confirms absence
    //     (safe re-broadcast). Same defer-over-risk choice AttestationPublisher
    //     makes when its indexer is unreachable.
    async broadcastWithRetry(broadcaster, payload, attempts, existsCheck){
        attempts = attempts || 5;
        // flush() checks the pause + per-window
        // ceiling ONCE, but a single flush broadcasts N times (one per pending
        // checkpoint plus one per archive chunk), each spending a fee. Gate per
        // broadcast here so the ceiling and the runtime pause bind every send, not
        // just the first (fail-closed, like the sibling AttestationPublisher).
        //
        // The gate is a RESERVATION, not the old allow()/await/record() pair:
        // allow() and record() straddle the awaited send, so concurrent flushes all
        // read the same pre-send budget and all spend, and every exit that did not
        // reach record() charged nothing even when the transaction had gone out
        // (a lost ACK spends a real fee). reserve() runs the same gates, consumes
        // the budget in one synchronous turn and PERSISTS it before the send
        // (spend_guard.js:259-268); the reservation IS the record, so record() must
        // never be called on this path or the spend is counted twice.
        //
        // Retries of the SAME payload do not re-reserve: one call publishes at most
        // one transaction, so the reservation is per row/chunk and is settled exactly
        // once on whichever exit the call takes. commit() on every outcome where the
        // transaction may have reached the node (including both ambiguous exits:
        // over-charging a send that never landed fails closed and ages out within one
        // window), release() only on definitive never-sent exits.
        let token = this.spendGuard.reserve();
        if(!token){
            let err = new Error(this.spendGuard.noteBlocked() + '; skipping remaining broadcasts this flush');
            err.spendBlocked = true;
            throw err;
        }
        try {
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
                        logger.info('StateAnchorPublisher: anchor already on-chain (txid ' +
                                    (found.txid || '?') + '); adopting instead of re-broadcasting');
                        this.spendGuard.release(token);   // nothing was sent in this call
                        return found;
                    }
                    // Undetermined + a send may already have gone out: never risk it.
                    if(found === undefined && lastErr && lastErr.anchorAmbiguousSend){
                        this.spendGuard.commit(token);    // the send may have landed
                        throw lastErr;
                    }
                }
                // Re-read the operator pause before EVERY attempt. The pause is an
                // out-of-band runtime toggle (the control RPC flips an in-memory flag),
                // so the entry reservation cannot see one asserted during the awaited
                // retry delay or existence check above, and an operator halt has to stop
                // the sends that have not gone out yet. Only the PAUSE is re-read: the
                // ceiling stays gated once per row/chunk because a retry of the same
                // payload consumes no new budget, and re-gating it would refuse
                // legitimate retries. Same idiom as RollcallRound's per-chunk re-check.
                if(this.spendGuard.isPaused()){
                    // An earlier ambiguous attempt keeps its own error: the caller
                    // withdraws the anchor intent markers for every failure NOT flagged
                    // anchorAmbiguousSend, and dropping them after a send that may have
                    // reached the network invites a second anchor for the same payload.
                    if(lastErr && lastErr.anchorAmbiguousSend){
                        this.spendGuard.commit(token);
                        throw lastErr;
                    }
                    this.spendGuard.release(token);       // this attempt never went out
                    let err = new Error(this.spendGuard.noteBlocked() + '; skipping remaining broadcasts this flush');
                    err.spendBlocked = true;
                    throw err;
                }
                try {
                    let sent = await broadcaster(payload);
                    // A fresh broadcast actually spent a fee; keep the reserved budget
                    // as the recorded spend. The adopt path above returns an already
                    // on-chain tx and deliberately releases instead (no new spend).
                    this.spendGuard.commit(token);
                    return sent;
                }
                catch(e){
                    lastErr = e;
                    // No confirmed input to build from. Pre-send, nothing was signed or
                    // sent, and a 2.5 s retry cannot confirm an output; surface it as the
                    // deferral it is instead of burning the attempt budget on it.
                    if(e && e.anchorNoConfirmedUtxo){
                        this.spendGuard.release(token);   // pre-send; nothing left the hub
                        throw e;
                    }
                    if(e && e.anchorAmbiguousSend){
                        // The send may have been accepted; give the anchor a bounded
                        // window to reach the indexer's mined view, then defer. Either
                        // way the fee is treated as spent.
                        if(existsCheck){
                            for(let p = 0; p < this.ambiguousPollAttempts; p++){
                                await new Promise(r => setTimeout(r, this.ambiguousPollDelayMs));
                                let found = null;
                                try { found = await existsCheck(); } catch(_e){ found = null; }
                                if(found && found.exists){
                                    logger.info('StateAnchorPublisher: ambiguous send confirmed on-chain (txid ' +
                                                (found.txid || '?') + '); adopting');
                                    this.spendGuard.commit(token);   // our send is what landed
                                    return found;
                                }
                            }
                        }
                        this.spendGuard.commit(token);
                        throw e;   // defer to a later flush; never rebuild+re-broadcast
                    }
                    // Encoder rate limiting. Safe to retry by the shared classifier's own
                    // rule: a sub-500 response is a definitive refusal, so nothing reached
                    // the coin node and no double spend is possible. The reservation was
                    // taken once at method entry and covers the whole call, so a free
                    // retry here re-charges nothing.
                    let rlWaitMs = this.rateLimitWaitMs(e);
                    if(rlWaitMs !== null){
                        if(rateLimitWaits >= this.rateLimitMaxWaits){
                            this.spendGuard.release(token);   // definitive refusal; never sent
                            throw e;
                        }
                        rateLimitWaits++;
                        delayMs = rlWaitMs;
                        logger.warn('StateAnchorPublisher: encoder rate-limited the anchor broadcast; ' +
                                     'waiting ' + rlWaitMs + 'ms (Retry-After honoured, capped at ' +
                                     this.rateLimitMaxWaitMs + 'ms), ' +
                                     (this.rateLimitMaxWaits - rateLimitWaits) + ' rate-limit wait(s) left ' +
                                     'before this anchor defers to a later flush');
                        continue;   // deliberately does NOT consume an attempt
                    }
                    attempt++;
                }
            }
            // Retries only continue on definitive failures, so an exhausted loop sent
            // nothing; the release below hands the budget back.
            throw lastErr || new Error('broadcast failed');
        }
        finally {
            // Backstop, not the settle point: release() is a no-op on a token already
            // committed or released, so an exit that forgot to settle gives the budget
            // back rather than leaking a reservation that over-counts the window.
            this.spendGuard.release(token);
        }
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
    rateLimitWaitMs(e){
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

    startConfirmationWatchdog(){
        if(this._confirmTimer) return;
        if(!this.confirmCheckIntervalMs) return;
        this._confirmTimer = setInterval(() => {
            this.checkPublishedConfirmations().catch(e =>
                logger.warn('StateAnchorPublisher: confirmation watchdog tick failed: ' + (e && e.message)));
        }, this.confirmCheckIntervalMs);
        if(this._confirmTimer.unref) this._confirmTimer.unref();
    }

    // Record a broadcast as awaiting confirmation. A broadcaster that returns no
    // txid cannot be watched, so it is not tracked: an untrackable send must not
    // masquerade as a stalled one. Adopted (already-mined) anchors are not sent here.
    notePendingConfirmation(kind, txid, ref){
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
    async checkPublishedConfirmations(){
        if(this._pendingConfirmations.size === 0) return;
        let summary = null;
        try { summary = await this.readUtxoReserve(); } catch(e){ summary = null; }
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
            logger.warn('StateAnchorPublisher: UNCONFIRMED_ANCHOR - ' + this._pendingConfirmations.size +
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
    isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    }

    async defaultBroadcast(payload, signer, opts){
        signer = signer || this.resolveSigner();
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
        // A successful create_tx RESERVED the inputs it selected (receipt on
        // psbtResult.reservation, 5-minute encoder TTL), so an abandoned build must hand
        // them back or this address is unavailable to every other publisher until the TTL
        // expires. Scoped strictly to the pre-broadcast section below: past the send,
        // holding the inputs is what stops a second build double-spending a transaction
        // that may already have landed. See lib/encoder_reservation.js.
        let txHex;
        try {
            // Refuse phase 1 of a two-transaction encoding before anything is signed: this
            // pipeline has no reveal, so broadcasting the P2SH funding tx would publish an
            // ANCHOR no indexer can decode and strand the carrier value (lib/two_phase_guard.js).
            assertSingleTxEncoding(psbtResult, 'StateAnchorPublisher');
            txHex = await signer.walletSignFn(psbtResult.psbt);
            if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        } catch(e){
            await abandonBuild(signer.encoder, psbtResult, 'StateAnchorPublisher');
            throw e;
        }
        // Everything above is pre-send (building/signing; no money has moved).
        // Only broadcast_tx has a side effect, so only ITS failures get the
        // ambiguity classification broadcastWithRetry keys the no-double-
        // broadcast guard on.
        try {
            return (await signer.encoder.broadcastTx(txHex)) || { txid: null };
        } catch(e){
            if(this.isAmbiguousSendError(e)) e.anchorAmbiguousSend = true;
            throw e;
        }
    }

    // Durable at-most-once for the anchor spend (anchor_published_checkpoints).
    //
    // The existence check above closes a lost ACK only where it can SEE the earlier send,
    // and getanchoraction resolves a txid through mined blocks, so an anchor sitting in
    // the DOGE mempool reads as DEFINITIVELY ABSENT. Everything else that knows a send
    // went out is in memory (broadcastWithRetry's lastErr / ambiguous-poll loop) and
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
    async getAnchorIntent(row){
        let rows = await this.db.findAnchorPublishedCheckpoints(row.chain, row.network, Number(row.checkpoint_seq));
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    // Does this marker still cover a send that might be live? Measured from intent_at,
    // which is written BEFORE the broadcast, so the window starts at the earliest moment
    // money could have moved. An unreadable stamp holds (fail closed): the TTL is a
    // liveness bound, not a licence to spend.
    anchorIntentHolds(marker){
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
    async recordAnchorIntent(row){
        await this.db.setAnchorPublishedCheckpoint(row.chain, row.network, Number(row.checkpoint_seq));
    }

    // Record that the broadcast returned a txid. Logged, never thrown: the DOGE fee is
    // already spent, and the surviving intent-only row makes the next flush HOLD instead
    // of re-broadcasting, which is the fail-safe direction.
    async markAnchorSent(row, txid){
        try {
            await this.db.updateAnchorPublishedCheckpoint(txid || null, row.chain, row.network, Number(row.checkpoint_seq));
        } catch(e){
            logger.error(nodeUtil.format('StateAnchorPublisher: anchor for ' + row.chain + '/' + row.network + ' @ ' +
                          row.block_index + ' broadcast as ' + txid + ' but its durable sent marker could not be ' +
                          'persisted; the intent still holds the row, so nothing re-broadcasts. Error:', e && e.message));
        }
    }

    // Withdraw an intent for a send that DEFINITIVELY never went out (a pre-send build,
    // sign, ceiling or RPC-rejection failure). Without this a routine failure would hold
    // the checkpoint for the whole TTL, which is worse than the replay risk the marker
    // exists for. Scoped `AND sent_at IS NULL` so a confirmed marker can never be deleted
    // by a late or misordered call. Logged, never thrown: leaving the row is fail-closed.
    async withdrawAnchorIntent(row){
        try {
            await this.db.deleteAnchorPublishedCheckpoint(row.chain, row.network, Number(row.checkpoint_seq));
        } catch(e){
            logger.warn('StateAnchorPublisher: could not withdraw the broadcast intent for ' + row.chain + '/' +
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
    // broadcastWithRetry as the head's existsCheck via findExistingArchiveAnchor, plus
    // findExistingArchiveChunk per continuation chunk. What that lookup cannot see is a
    // send that has not mined yet: it answers from parsed on-chain actions, so an archive
    // still in the DOGE mempool reads as definitively absent. This marker covers exactly
    // that window, together with the ambiguous-send defer, and it is read before the
    // batch seq is even drawn, which is why the hold is unconditional within the TTL
    // rather than conditional on a mined lookup.

    // Read the newest unsettled marker for a network, or null when none exists. Throws on
    // a DB error so the caller FAILS CLOSED (rows stay pending) rather than spending on a
    // batch whose publish history it could not read.
    async getLiveArchiveIntent(network){
        let rows = await this.db.getAnchorPublishedArchive(String(network));
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    // Durably arm archive-broadcast intent before the v1 send. The upsert form matches the
    // checkpoint twin: the caller reaches this only when no unexpired intent holds the
    // network, so an existing row for this seq is a stale one and the write is this round
    // opening its own window. Throws on a DB error so the caller fails closed.
    async recordArchiveIntent(network, batchSeq){
        await this.db.setAnchorPublishedArchive(String(network), Number(batchSeq));
    }

    // Record that the v1 broadcast returned a txid. Logged, never thrown: the DOGE fee is
    // already spent, and an intent-only row left behind makes the next round HOLD instead
    // of re-archiving, which is the fail-safe direction.
    async markArchiveSent(network, batchSeq, txid){
        try {
            await this.db.updateAnchorPublishedArchiveByNetwork(txid || null, String(network), Number(batchSeq));
        } catch(e){
            logger.error(nodeUtil.format('StateAnchorPublisher: archive batch ' + batchSeq + ' broadcast as ' + txid +
                          ' but its durable sent marker could not be persisted; the intent still holds the ' +
                          'network, so nothing re-archives. Error:', e && e.message));
        }
    }

    // Close the window once the round's bookkeeping has landed, so the next round is not
    // blocked for the full TTL by a batch that completed normally. Scoped `AND sent_at IS
    // NOT NULL` so it can only ever close a marker whose broadcast actually returned.
    // Logged, never thrown: an unsettled marker costs latency (the TTL), never money.
    async settleArchiveIntent(network, batchSeq){
        try {
            await this.db.updateAnchorPublishedArchiveByNetworkAndBatchSeq(String(network), Number(batchSeq));
        } catch(e){
            logger.warn('StateAnchorPublisher: could not settle the archive intent for batch ' + batchSeq +
                         '; it will hold ' + network + ' archiving until the TTL expires: ' + (e && e.message));
        }
    }

    // Withdraw an intent for a v1 send that DEFINITIVELY never went out (a pre-send build,
    // sign, ceiling or RPC-rejection failure). Without this a routine failure would stall
    // archiving for the whole TTL, which is worse than the replay risk the marker exists
    // for. Scoped `AND sent_at IS NULL` so a confirmed marker can never be deleted by a
    // late or misordered call. Logged, never thrown: leaving the row is fail-closed.
    async withdrawArchiveIntent(network, batchSeq){
        try {
            await this.db.deleteAnchorPublishedArchive(String(network), Number(batchSeq));
        } catch(e){
            logger.warn('StateAnchorPublisher: could not withdraw the archive broadcast intent for batch ' +
                         batchSeq + '; it will hold ' + network + ' archiving until the TTL expires: ' +
                         (e && e.message));
        }
    }

    // ----- Retention for the two anchor marker tables -----
    //
    // Both tables appended one row per DOGE-spending broadcast and removed one only on
    // a definitive pre-send failure (withdrawAnchorIntent / withdrawArchiveIntent,
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
    //      either table goes through anchorIntentHolds, which is false for any marker
    //      whose intent_at is older than the TTL, so a row this DELETE can reach is one
    //      that already changes no decision. anchor_published_archives is stricter
    //      still: getLiveArchiveIntent only ever selects `settled_at IS NULL`, so a
    //      settled row is not read at all.
    //
    // The cutoff is measured on intent_at, not sent_at, because intent_at is the column
    // anchorIntentHolds measures and the one the floor is expressed in.
    //
    // Returns the total number of rows deleted across both tables. Throws on a DB
    // error; the caller treats a retention failure as non-fatal.
    async pruneAnchorMarkers(){
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
        // Checkpoints first, then archives, the order the sweep has always run in; each
        // table has its own fixed statement, so no table name is assembled into SQL here.
        let deleted = 0;
        let res = await this.db.deleteAnchorPublishedCheckpointsSentBefore(windowSec);
        deleted += (res && res.affectedRows) ? Number(res.affectedRows) : 0;
        res = await this.db.deleteAnchorPublishedArchivesSentBefore(windowSec);
        deleted += (res && res.affectedRows) ? Number(res.affectedRows) : 0;
        if(deleted > 0){
            this.anchorMarkersPruned += deleted;
            logger.info('StateAnchorPublisher: anchor-marker retention pruned ' + deleted +
                        ' confirmed marker row(s) older than ' + windowSec + 's (intent-only rows, which are ' +
                        'the ambiguous-send record, are never pruned)');
        }
        return deleted;
    }

    // Housekeeping hook for the retention sweep. Fire-and-forget with the rejection
    // swallowed: bounding the marker tables must never stall, fail or retry a flush
    // that has already spent DOGE.
    sweepAnchorMarkerRetention(){
        if(!this.db || !this.anchorMarkerRetentionMs) return;
        this._retentionSweep = this.pruneAnchorMarkers()
            .catch(e => {
                logger.warn('StateAnchorPublisher: anchor-marker retention sweep failed ' +
                             '(the marker tables keep growing until it succeeds): ' + (e && e.message));
                return 0;
            });
    }

    async checkBalance(signer){
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
            logger.warn('StateAnchorPublisher: DOGE balance LOW (' + Number(balance).toFixed(4) + ' DOGE)');
        return balance;
    }
}

module.exports = Object.assign(StateAnchorPublisher, {
    XANC_SIGN_REQ,
    XANC_SIGN,
    XANC_FINALIZED,
    XANC_BUNDLE_DONE,
    XANCPUB_SIGN_REQ,
    XANCPUB_SIGN,
    XANCARCHPUB_SIGN_REQ,
    XANCARCHPUB_SIGN,
    XANCREWARD,
    MATCH_KEYS
});

// The method groups live in publisher/ by behaviour, and this installs them on the
// prototype. It runs AFTER module.exports is assigned because a part that calls one of
// the statics above requires this file back, and a circular require sees only what
// module.exports already holds.
installParts(StateAnchorPublisher.prototype, [
    require('./publisher/lifecycle.js'),
    require('./publisher/bundle.js'),
    require('./publisher/publish_bundle.js'),
    require('./publisher/reward.js'),
    require('./publisher/reward_defer.js'),
    require('./publisher/attest_round.js'),
    require('./publisher/archive/attest.js'),
    require('./publisher/archive/round.js'),
    require('./publisher/archive/build.js'),
    require('./publisher/bundle_done.js'),
    require('./publisher/lookups.js'),
    require('./publisher/archive/sign.js'),
    require('./publisher/archive/verify.js'),
    require('./publisher/archive/publish.js'),
    require('./publisher/archive/finalized.js'),
    require('./publisher/archive/finalized_apply.js'),
    require('./publisher/archive/observed.js'),
]);
