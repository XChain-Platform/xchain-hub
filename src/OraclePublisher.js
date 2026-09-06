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
 * XChain Hub - Oracle Publisher (`oracle_publish` capability)
 *
 * Validators with the `oracle_publish` capability active publish finalized
 * PRICE v0 rounds to the DOGE chain as the immutable backup/audit trail.
 * Leader rotation is deterministic:
 *   leader_index = round % active_oracle_publish_count
 *
 * Active validators are sorted by signing_pubkey for stable ordering
 * across all nodes. First valid PRICE tx on-chain for a given round wins
 * (and earns the reward).
 *
 * LEADER FAILOVER: opt-in, off by default. A window's leader publishes it; a
 * follower arms a timer staggered by its DISTANCE from that leader in the
 * rotation and, if the window is still not on chain when the timer fires,
 * re-assembles the identical batch itself (_scheduleTakeover / _attemptTakeover).
 * Set ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS to arm it. Before this existed a
 * silent leader meant the window was never published by anyone, however healthy
 * the rest of the set was.
 *
 * The safety property is that a hub only steps in when it can PROVE it would
 * have seen the leader succeed. That proof is the indexer pushing landed PRICE
 * actions back to this hub (the same feed _pruneObservedWindow reads). A hub
 * that has never observed one declines every takeover, because on that hub
 * "not on chain" and "on chain but I was not told" are the same observation,
 * and guessing wrong pays DOGE twice for a duplicate on-chain batch.
 *
 * "On chain" is a MINED view, so it has a second blind spot: a leader whose tx was
 * accepted by the DOGE node but has not been mined looks exactly like a leader that
 * never sent. An armed follower therefore also honours an ambiguity cooldown before it
 * steps in, started by either its own ambiguous send for the window or the
 * co-signature it handed that window's leader, and defers until the cooldown has
 * elapsed with the window still absent - the point at which the in-flight tx is
 * provably gone. This is AttestationPublisher's _ambiguousSends deferral, on this rail.
 *
 * The off-hub control still applies and is not replaced: the dashboard's
 * publish-coverage rail detects a gap from the chain side, backed by the
 * _lastRankState / _leaderRounds / _followerRounds counters below.
 *
 * A round that exhausts its broadcast attempts is written to an append-only
 * dead-letter file (never silently dropped) so the finalized round can be
 * inspected and replayed by hand rather than vanishing from the durable queue.
 *
 * This module handles:
 *   - Leader rotation calculation
 *   - Persistent queue (JSONL with fsync)
 *   - PRICE v0 payload construction (matches indexer parser format)
 *   - PRICE batch assembly (buffer, window scheduler, splitting, signing round)
 *   - DOGE balance monitoring with WARN/ERROR log thresholds
 *
 * PRICE v0 BATCH RAIL (spec section 7).
 * A finalized round is never broadcast on its own. It is appended to a SEPARATE
 * durable buffer file and leaves this hub only as part of an hourly batch that a
 * quorum of the price-capable set has co-signed. The two files are deliberately
 * distinct: the publish queue broadcasts every entry it reads, so a "buffered"
 * round parked there would go out as the very v0 the batch replaces.
 *
 * Every hub buffers every round it finalizes, leader or not, because window
 * leadership is resolved at the window's anchor and that anchor is unknown when
 * the window's first round finalizes. Non-leaders shed their copies once an
 * on-chain batch covering the window shows up in their own price_snapshots, and
 * unconditionally at ORACLE_BATCH_BUFFER_MAX_ROUNDS.
 *
 * The actual DOGE broadcast is delegated to a `broadcastFn` hook that
 * the operator wires up to their preferred signer (xchain-sdk, xchain-encoder
 * REST API, or local DOGE node). This keeps the publisher decoupled from
 * the underlying transport.
 *
 ********************************************************************/

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');
const EncoderClient = require('./EncoderClient.js');
const SpendGuard    = require('./lib/spend_guard.js');
const OracleBatchSigner = require('./OracleBatchSigner.js');
const swq           = require('./stake_weighted_quorum.js');
const pst           = require('./price_sig_tally_activation.js');
const { AtMostOnce, isAmbiguousSendError } = require('./lib/idempotent_broadcast.js');
const { sumUtxosCoins } = require('./lib/utxo_balance.js');
const { forwardableUtxos } = require('./lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('./lib/two_phase_guard.js');

// ~10 min. Translates the rank-staggered takeover window from BTC blocks (the
// unit the window anchor is denominated in) into wall-clock, the same way
// AttestationPublisher does for its own failover.
const APPROX_BTC_BLOCK_MS = 600000;
const { positiveIntConfig } = require('./lib/config_int.js');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS } = require('./constants.js');
const { worstCaseSnapshotAgeMs, maxBatchWindowRounds, pinnedMaxPriceAgeMs,
        DEFAULT_BATCH_LANDING_RESERVE_MS,
        LEGACY_BATCH_WINDOW_ROUNDS } = require('./lib/price_batch_cadence.js');
const { compressPriceBatchBody, PRICE_BATCH_COMPRESSION_MARKER,
        PRICE_BATCH_MAX_ROUND_COUNT } = require('./price_batch_compression.js');

// PRICE v0 wire ceiling. Must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js
// (mirrors ATTEST_WIRE_MAX_BYTES in AttestationPublisher.js): an oversized wire is
// rejected by createTx with a RangeError, so we drop it before it lands on the durable
// queue rather than letting the queue retry sweep replay it forever. (Named for
// what _processQueue does: this class has no failover sweep, see the header.)
const PRICE_WIRE_MAX_BYTES = 8189;

// Bound on the assembled-window memo below. It only exists to stop one process
// re-assembling a window it already handled, so it needs to cover the buffer's
// own horizon and nothing more; the durable per-round markers are the real
// at-most-once guard.
const ASSEMBLED_WINDOW_MEMO_MAX = 4096;
// Bound on the ambiguous-send memo. Each entry only has to outlive one
// takeoverAmbiguousCooldownMs, so this is generous by orders of magnitude.
const AMBIGUOUS_WINDOW_MEMO_MAX = 256;
// Windows re-proposed per catch-up sweep. Assemblies are serialized on
// _windowChain and each one can hold it for a whole ORACLE_BATCH_SIGN_TIMEOUT_MS, so a
// backlog of a hundred windows must not be attempted in one pass: the live window
// queued behind it would wait out every one of them.
const CATCHUP_WINDOWS_PER_SWEEP = 4;
// How often that sweep runs. An hour at the shipped defaults: the refusals it recovers
// from are either transient or content drift that reconciliation repairs, and neither
// gets better by asking again sooner. See _startBufferCatchupSweep.
const DEFAULT_BATCH_CATCHUP_INTERVAL_MS = 3600000;

// Confirmation depth at which the watchdog calls a broadcast landed. One block is
// the whole question here: the failure being watched for is a transaction that never
// mines at all, not a shallow one that could reorg out.
const CONFIRMED_DEPTH = 1;

// Millisecond knobs where 0 is a meaningful setting (it disables the timer it sizes),
// which positiveIntConfig cannot express because it rejects 0 as out of range.
function nonNegativeIntConfig(raw, dflt, name) {
    if (raw === undefined || raw === null || raw === '') return dflt;
    let n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 0) return n;
    console.warn('config: ' + name + '="' + raw + '" is not a non-negative integer; using the default (' + dflt + ')');
    return dflt;
}

class OraclePublisher {

    constructor(hub) {
        this.hub      = hub;
        this.db       = hub.db;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        // Config (read from env or hub p2pConfig)
        let cfg = hub.p2pConfig || {};
        this.queuePath          = process.env.PUBLISHER_QUEUE_PATH || cfg.PUBLISHER_QUEUE_PATH || './data/publisher-queue.jsonl';
        // Append-only sink for rounds that exhaust maxAttempts. Kept next to the
        // queue so operators find both together; never truncated (open 'a').
        this.deadLetterPath     = this.queuePath.replace(/\.jsonl$/, '') + '.deadletter.jsonl';
        // PRICE v0 round buffer, a third sibling file. Rounds wait here between
        // finalization and the window close that turns them into one signed batch.
        // Deliberately NOT the publish queue: see the header.
        this.bufferPath         = this.queuePath.replace(/\.jsonl$/, '') + '.buffer.jsonl';
        // Lifetime counter of rounds moved to the dead-letter file. Makes a
        // give-up event countable instead of only a console.error.
        this.abandonedCount     = 0;
        // Lifetime count of finalized rounds dropped pre-enqueue because their encoded
        // PRICE v0 wire exceeded PRICE_WIRE_MAX_BYTES. Kept separate from abandonedCount
        // so operators can tell an oversized drop apart from an attempts-exhausted abandon.
        this.oversizedDrops     = 0;
        // Transition-only guard so a persistent capability-snapshot resolution failure
        // (which darks the publisher) is logged once per dark spell, not every round.
        this._snapshotDark      = false;
        // Lifetime published count + last-published markers + last-observed balance,
        // surfaced via getStats() so an operator RPC can see the publish rail's
        // health (a stalled rail is otherwise invisible: every price_snapshots row
        // still reads finalized while nothing lands on-chain).
        this.publishedCount     = 0;
        this.lastPublishedRound = null;
        this.lastPublishedTxid  = null;
        // In-process at-most-once guard. Round ids broadcast this process lifetime
        // are recorded here the instant broadcaster(payload) succeeds. If the
        // post-broadcast queue rewrite fails (disk full, permissions, transient I/O),
        // the just-published round stays on the durable queue file; without this set
        // the next _processQueue tick would re-read and RE-BROADCAST it, spending real
        // DOGE twice for the same round. Consulted before every broadcast so a failed
        // rewrite can never turn into a duplicate on-chain PRICE. Cleared once the
        // durable queue is confirmed rewritten (no published round can still be on it).
        this._publishedRounds   = new AtMostOnce();
        // Durable at-most-once. The in-process tracker above vanishes on restart, but
        // the finalized round can still be on the durable JSONL queue, so a restart
        // before the queue rewrite is repaired would re-broadcast an already-paid round
        // (duplicate DOGE spend). The `oracle_published_rounds` table (src/sql/) records
        // an intent row BEFORE broadcast and a sent marker AFTER, on the hub DB, a disk
        // decoupled from the queue file whose exhaustion triggers the rewrite failure.
        // start() hydrates _publishedRounds from sent markers and quarantines any
        // intent-only rows (a crash between intent and confirmation left the on-chain
        // state unknown): those are NEVER auto-rebroadcast, only surfaced for an operator
        // to verify on-chain and replay by hand. When no hub DB is wired (dev/test), the
        // durable guard is inert and the in-process tracker is the only at-most-once cover.
        this._quarantinedRounds = new Set();
        this.lastObservedBalance = null;
        this.dogeAddress        = process.env.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
        this.dogePubkeyHex      = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10'); // DOGE
        this.maxAttempts        = parseInt(process.env.PUBLISHER_MAX_ATTEMPTS || cfg.PUBLISHER_MAX_ATTEMPTS || '5');
        // Retention window (in rounds) for the durable oracle_published_rounds marker
        // table. One row lands per published round forever, so on a money-bearing
        // broadcast path the table grows without bound for the life of the deployment.
        // PRICE batching does NOT change that rate: a batch writes one marker row
        // per CONTAINED round, not one per wire, so the rows-per-day figure the window
        // below is sized against is identical either side of the flag day (D26).
        // Only CONFIRMED rows (sent_at IS NOT NULL) are ever pruned: a sent_at NULL row
        // is the quarantine marker for a round whose on-chain state is unknown, which an
        // operator reconciles by hand, so those must survive forever (see
        // _hydratePublishedMarkers). Keep the most recent N rounds; 0 disables pruning.
        // Default ~90 days at the 10-minute round default, mirroring the
        // ORACLE_SUBMISSIONS_RETENTION_ROUNDS window on the sibling audit table.
        // The window counts ROUNDS, never wires, so it means the same 90 days under
        // v2 batching even though the wire count per day falls by ORACLE_BATCH_WINDOW_ROUNDS.
        this.publishedRoundsRetentionRounds = parseInt(
            process.env.ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS ||
            cfg.ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS);
        if (!Number.isFinite(this.publishedRoundsRetentionRounds) || this.publishedRoundsRetentionRounds < 0) {
            this.publishedRoundsRetentionRounds = 12960;
        }
        // Lifetime count of confirmed marker rows pruned by the retention sweep, and
        // the promise of the in-flight sweep. The sweep is fire-and-forget on the
        // publish path (a retention failure must never stall a broadcast), so the
        // handle is what makes it awaitable in tests and diagnosable in getStats.
        this.publishedRoundsPruned = 0;
        this._retentionSweep       = null;

        // item 2677 - operator kill switch. Mirrors StateAnchorPublisher's
        // ANCHOR_ENABLED gate: a first-class lever to halt outbound DOGE spend
        // during an incident (bad price feed, runaway fees, compromised signer)
        // without tearing down the broadcast pipeline config. Default: enabled.
        this.enabled = String(process.env.ORACLE_PUBLISH_ENABLED || cfg.ORACLE_PUBLISH_ENABLED || 'true') !== 'false';

        // Shared SpendGuard (supersedes the old per-publisher SpendCeiling).
        // Composes the per-window spend ceiling (count + a $2000-clamped USD-cents
        // budget, default-ON), the wallet balance floor, and a per-capability runtime
        // pause. Folding the pause into allow() is what lets an operator halt this
        // publisher's PRIMARY (leader) DOGE spend at runtime, not just its sweep.
        this.spendGuard = new SpendGuard('ORACLE_PUBLISH', cfg, 'OraclePublisher');
        // Keep the guard's balance floor in step with the publisher's existing
        // DOGE_LOW_BALANCE_THRESHOLD so guard stats read the same floor the
        // pre-loop balance gate enforces.
        this.spendGuard.minBalance = this.lowBalanceThreshold;

        // Per-round state
        //
        // Rank-staggered window takeover. Without it a window whose leader never
        // broadcasts stays unpublished forever, because this class publishes only the
        // windows it leads and the peers holding the identical buffered rounds have no
        // way in. A follower re-assembles a window its leader left dark, ordered by
        // rank so the set takes over one at a time rather than all at once.
        //
        // Default 0 = OFF. Takeover pays DOGE for a window a peer may already have
        // paid for, so it stays an opt-in an operator arms per deployment once the
        // observation feed below is known to work.
        this.failoverWindowBlocks = parseInt(
            process.env.ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS ||
            cfg.ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS || '0');
        if (!Number.isFinite(this.failoverWindowBlocks) || this.failoverWindowBlocks < 0) this.failoverWindowBlocks = 0;
        this.approxBlockMs = parseInt(
            process.env.ORACLE_PUBLISH_BLOCK_MS || cfg.ORACLE_PUBLISH_BLOCK_MS || APPROX_BTC_BLOCK_MS);
        if (!Number.isFinite(this.approxBlockMs) || this.approxBlockMs <= 0) this.approxBlockMs = APPROX_BTC_BLOCK_MS;
        // Timers for windows this hub may take over, keyed by window index.
        this._takeoverTimers   = new Map();
        // Memoized proof that landed batches actually reach this hub (see
        // _observationFeedProven). Never cached as false: a feed can come up later.
        this._observationProven = false;
        this._takeoverDarkWarned = false;
        this.takeoverAttempts  = 0;
        this.takeoverPublished = 0;
        this.takeoverDeferred  = 0;
        // How long an armed follower waits, once something says a batch for
        // the window may ALREADY be on the wire, before it treats that tx as gone and
        // publishes its own. Mirrors AttestationPublisher's
        // ATTESTATION_AMBIGUOUS_COOLDOWN_MS, down to the default: one full failover
        // window, which is the same horizon the rank stagger is denominated in. A DOGE
        // tx that has not reached this hub's observed-on-chain view in that long did
        // not land, so re-publishing then costs nothing that was not already lost.
        this.takeoverAmbiguousCooldownMs = parseInt(
            process.env.ORACLE_TAKEOVER_AMBIGUOUS_COOLDOWN_MS ||
            cfg.ORACLE_TAKEOVER_AMBIGUOUS_COOLDOWN_MS ||
            String(this.failoverWindowBlocks * this.approxBlockMs), 10);
        if (!Number.isFinite(this.takeoverAmbiguousCooldownMs) || this.takeoverAmbiguousCooldownMs < 0) {
            this.takeoverAmbiguousCooldownMs = this.failoverWindowBlocks * this.approxBlockMs;
        }
        // windowIndex -> ms timestamp of this hub's OWN ambiguous send for that window
        // (the dead-letter branch in _processQueue). Insertion-ordered and bounded.
        this._ambiguousWindows = new Map();

        // Whether a publish may spend this address's own unconfirmed change. Default
        // FALSE: chaining is what lets one underpaid batch strand every later one,
        // because miners score by ancestor package. The escape hatch exists for a
        // venue that mines on demand (regtest), where chaining is free and waiting
        // for a confirmation would stall the harness.
        this.allowUnconfirmedInputs =
            String(process.env.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS ||
                   cfg.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS || 'false') === 'true';
        // Leader-rotation observability (item 3218). A dark peer publisher is
        // otherwise invisible: this hub's own status stays perfect while 1/N of
        // rounds never land on-chain. Track the rank state of the most recent
        // finalized round plus lifetime leader/follower-window counts so getStats
        // (getoraclepublisherstatus) exposes the rotation the dashboard can watch.
        this._lastRankState  = null; // { round, myRank, leaderRank, isLeader, publisherCount }
        this._leaderRounds   = 0;    // rounds this hub was the elected leader
        this._followerRounds = 0;    // finalized rounds this hub deferred (not leader)

        // Auto-create EncoderClient if DOGE_ENCODER_URL env var is set
        // This is the JSON-RPC endpoint of an xchain-encoder instance configured for DOGE.
        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks (wired by the operator at startup)
        // broadcastFn(payload) → Promise<{txid}>: full custom broadcast pipeline (overrides default)
        // walletSignFn(psbtHex) → Promise<txHex>: sign a PSBT with the DOGE_ADDRESS private key
        // getBalanceFn() → Promise<number>: return DOGE balance for the configured address
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        // Publish-pass self-overlap guard, see _processQueue(). Named for the sibling
        // publishers' house convention (AttestationPublisher._sweeping,
        // AttestationSpotChecker._schedulerTick).
        this._sweeping = false;

        // ---------------- PRICE batch rail (spec section 7) ----------------

        // The network name still keys the remaining per-network rules the batch rail
        // reads (pair widening, sig tally, stake-weighted quorum).
        this.network = (hub && hub.network) ? String(hub.network) : '';

        // Read BEFORE the window size: the window ceiling is derived from the grace,
        // the round cadence and the pinned staleness bound (see below).
        this.batchGraceMs         = positiveIntConfig(
            process.env.ORACLE_BATCH_GRACE_MS || cfg.ORACLE_BATCH_GRACE_MS,
            300000, 'ORACLE_BATCH_GRACE_MS');
        this.batchBufferMaxRounds = positiveIntConfig(
            process.env.ORACLE_BATCH_BUFFER_MAX_ROUNDS || cfg.ORACLE_BATCH_BUFFER_MAX_ROUNDS,
            4032, 'ORACLE_BATCH_BUFFER_MAX_ROUNDS');
        this.batchCatchupIntervalMs = positiveIntConfig(
            process.env.ORACLE_BATCH_CATCHUP_INTERVAL_MS || cfg.ORACLE_BATCH_CATCHUP_INTERVAL_MS,
            DEFAULT_BATCH_CATCHUP_INTERVAL_MS, 'ORACLE_BATCH_CATCHUP_INTERVAL_MS');

        // ---- The window ceiling, and why the window is not just a number
        //
        // A window's rounds are invisible to the chain until the batch lands, so the
        // freshest snapshot a fee-paying action can be priced against is the LAST round
        // of the most recently landed batch. Its age therefore sawtooths, resetting on
        // each landing and climbing a whole window before the next one, and the peak is
        // what the indexer's ORACLE_MAX_PRICE_AGE_SECONDS gate judges.
        //
        // Sized at the shipped 6 rounds that peak is 4200s against a 1800s bound, so
        // for the majority of every window NOTHING on LTC or DOGE can pay a native fee.
        // Measured exactly that way on public testnet 2026-09-01: TDOGE PRICE landed on
        // a steady 3600s cadence and fee-bearing actions failed about half the time,
        // with no fault anywhere in the publisher, the aggregator or the wire.
        //
        // So the window is DERIVED, not chosen: the largest that still fits the bound.
        // An operator value above the ceiling is clamped rather than honoured, because
        // honouring it does not give the operator a cheaper rail, it gives them a chain
        // whose fees cannot be priced.
        this.roundIntervalMs      = positiveIntConfig(
            process.env.ORACLE_ROUND_INTERVAL || cfg.ORACLE_ROUND_INTERVAL,
            DEFAULT_ORACLE_ROUND_INTERVAL_MS, 'ORACLE_ROUND_INTERVAL');
        this.batchLandingReserveMs = nonNegativeIntConfig(
            process.env.ORACLE_BATCH_LANDING_RESERVE_MS || cfg.ORACLE_BATCH_LANDING_RESERVE_MS,
            DEFAULT_BATCH_LANDING_RESERVE_MS, 'ORACLE_BATCH_LANDING_RESERVE_MS');
        this.oracleMaxPriceAgeMs  = pinnedMaxPriceAgeMs(this.network);

        let cadence = maxBatchWindowRounds({
            maxPriceAgeMs:    this.oracleMaxPriceAgeMs,
            roundIntervalMs:  this.roundIntervalMs,
            graceMs:          this.batchGraceMs,
            landingReserveMs: this.batchLandingReserveMs
        });
        this.batchWindowRoundsCeiling = cadence.ceiling;

        this.batchWindowRounds    = positiveIntConfig(
            process.env.ORACLE_BATCH_WINDOW_ROUNDS || cfg.ORACLE_BATCH_WINDOW_ROUNDS,
            cadence.ceiling === null ? LEGACY_BATCH_WINDOW_ROUNDS : cadence.ceiling,
            'ORACLE_BATCH_WINDOW_ROUNDS');
        if (cadence.ceiling !== null && this.batchWindowRounds > cadence.ceiling) {
            console.warn('config: ORACLE_BATCH_WINDOW_ROUNDS=' + this.batchWindowRounds +
                ' would leave the newest price snapshot up to ' +
                Math.round(worstCaseSnapshotAgeMs(this.batchWindowRounds, {
                    roundIntervalMs: this.roundIntervalMs, graceMs: this.batchGraceMs,
                    landingReserveMs: this.batchLandingReserveMs }) / 1000) +
                's old against a ' + Math.round(this.oracleMaxPriceAgeMs / 1000) +
                's fee-price staleness bound; clamping to ' + cadence.ceiling +
                ' round(s) per batch so native-coin fees stay priceable.');
            this.batchWindowRounds = cadence.ceiling;
        }
        if (cadence.ceiling !== null && !cadence.satisfiable) {
            console.warn('OraclePublisher: no batch window fits the ' +
                Math.round(this.oracleMaxPriceAgeMs / 1000) + 's fee-price staleness bound at a ' +
                Math.round(this.roundIntervalMs / 1000) + 's round interval with a ' +
                Math.round(this.batchGraceMs / 1000) + 's grace and a ' +
                Math.round(this.batchLandingReserveMs / 1000) + 's landing reserve. ' +
                'Publishing one round per batch anyway; native-coin fees will still go ' +
                'unpriceable between batches until the round interval or the grace comes down.');
        }

        // In-memory mirror of bufferPath, round -> the canonical builder's input shape
        // { round, timestamp, btcBlockHeight, pairs }. The file is the durable copy;
        // this Map is what the window scheduler and the self-check read.
        this._buffer = new Map();
        // windowIndex -> { timer }. One grace timer per window, armed once and never
        // extended: a late round arriving inside the grace still lands in the buffer
        // and is picked up by the assembly that timer fires.
        this._windows = new Map();
        // Windows this process has already assembled, insertion-ordered and bounded.
        // Prevents the catch-up sweep and a late round from re-running a window the
        // durable markers would then have to refuse.
        this._assembledWindows = new Map();
        // Window assemblies run strictly one at a time. Two overlapping assemblies
        // would run two signing rounds against one OracleBatchSigner, whose single
        // _signRound slot supports exactly one.
        this._windowChain  = Promise.resolve();
        this._catchupTimer = null;
        // The recurring re-proposal sweep, armed in start() and released in
        // stop(). Separate from _catchupTimer, which is the one-shot restart pass.
        this._catchupSweepTimer = null;
        // A signer this instance created because the hub wired none. Owned means
        // started and stopped here; a hub-wired signer is neither.
        this._ownedBatchSigner = null;

        // Batch stats (spec section 7). batchWindowsPublished and lastPublishedWindow
        // move when a wire actually lands, batchSplitCount when assembly decides to
        // split, batchUnpublishableCount when even one round cannot fit a wire.
        this.batchWindowsPublished   = 0;
        this.lastPublishedWindow     = null;
        this.batchSplitCount         = 0;
        this.batchUnpublishableCount = 0;
        this.batchCatchupSweeps      = 0;

        // ---------------- Landing, not just sending (confirmed-UTXO reserve + watchdog) ----------------
        //
        // Every guard above answers "did this round's wire leave the process". A wire
        // that leaves and then never mines satisfies all of them: the round is marked
        // sent, the queue drains, and lastPublishedTxid reports a healthy rail forever
        // while the address's entire balance is change trapped behind the stuck
        // package. The next window then either chains onto that package (stalling
        // identically) or fails funding outright, because Dogecoin inherits Core's
        // 25-transaction / 101 kB ancestor limits and refuses the chain past them.
        //
        // Two independent pieces answer that: a pre-broadcast reserve check that
        // refuses to build a wire nothing can mine, and a periodic watchdog that
        // tracks a broadcast to CONFIRMATION. Neither spends: the watchdog reports,
        // and the fee decision for a stuck package stays with the operator.

        // Last reading of the publisher address's UTXO set, split by confirmation
        // depth: { total, confirmed, unconfirmed, known, at }. `known` is false when
        // the source served no confirmations field at all, which must never be read
        // as "nothing is confirmed" (that would wedge publishing on a field change).
        this.lastUtxoReserve          = null;
        // Lifetime count of publish passes deferred because the address held no
        // confirmed UTXO, plus when the last one happened. A deferral is not a
        // broadcast failure: nothing is dead-lettered and no attempt is burned.
        this.noConfirmedUtxoDeferrals = 0;
        this.lastNoConfirmedUtxoAt    = null;

        // txid -> { txid, round, sentAt }. Broadcast this process lifetime and not yet
        // observed confirmed. Deliberately in-memory: through get_utxos a long-confirmed
        // transaction whose change has since been spent looks exactly like a stuck one,
        // so hydrating this from the marker table would report stalls that are not
        // happening.
        this._pendingConfirmations    = new Map();
        // Bound on that map so a chain of broadcasts nothing ever confirms cannot grow
        // it without limit. The OLDEST entry is the diagnostic worth keeping, so the
        // cap drops the oldest only once every one of them is already reported.
        this.pendingConfirmationsMax  = 512;
        this.confirmedPublishes       = 0;
        this.confirmationCheckFailures = 0;
        this.lastConfirmationCheckAt  = null;
        this._confirmTimer            = null;
        // Watchdog cadence. 0 disables the timer entirely (the counters stay live for
        // a caller that drives _checkPublishedConfirmations itself).
        this.confirmCheckIntervalMs   = nonNegativeIntConfig(
            process.env.ORACLE_PUBLISH_CONFIRM_CHECK_MS || cfg.ORACLE_PUBLISH_CONFIRM_CHECK_MS,
            300000, 'ORACLE_PUBLISH_CONFIRM_CHECK_MS');
        // Age past which a still-unconfirmed broadcast is logged rather than only
        // counted. DOGE targets one-minute blocks, so half an hour of silence is a
        // stall an operator should see, not ordinary latency.
        this.confirmStaleMs           = nonNegativeIntConfig(
            process.env.ORACLE_PUBLISH_CONFIRM_STALE_MS || cfg.ORACLE_PUBLISH_CONFIRM_STALE_MS,
            1800000, 'ORACLE_PUBLISH_CONFIRM_STALE_MS');
    }

    // Set a custom broadcast hook (overrides the default encoder-based pipeline)
    // The function receives the PRICE v0 wire payload string and should return { txid }
    setBroadcastHook(fn) {
        this.broadcastFn = fn;
    }

    // Set the wallet signing hook (required for the default broadcast pipeline)
    // The function receives a PSBT hex string and should return a signed transaction hex string
    // Operators wire this to xchain-sdk's wallet.signPsbt() or any equivalent signer
    setWalletSignHook(fn) {
        this.walletSignFn = fn;
    }

    // Set the balance query hook
    setBalanceHook(fn) {
        this.getBalanceFn = fn;
    }

    // Default broadcast pipeline: uses the EncoderClient + walletSignFn to construct, sign, and broadcast
    // a PRICE v0 transaction to the DOGE chain. Returns { txid } on success.
    // This is used automatically when no custom broadcastFn is set but encoder + walletSignFn are configured.
    async _defaultBroadcast(payload) {
        // Everything down to step 4 builds and signs: no money has moved and nothing has
        // left this process, so every failure here is DEFINITIVELY never-sent whatever it
        // looks like on the socket. Tag them, because the shared classifier answers
        // "ambiguous" for any error it does not recognise (isAmbiguousSendError's final
        // `return true`), which is the right default for a broadcaster this module knows
        // nothing about and the wrong one for a stage it knows cannot send. Untagged, a
        // get_utxos timeout dead-lettered a round that was never broadcast, permanently
        // removing it from automatic retry. Same convention and same reason as
        // AttestationRelay's _relayPreSend.
        return await this._runDefaultBroadcast(payload);
    }

    async _runDefaultBroadcast(payload) {
        let txHex;
        try {
            txHex = await this._buildSignedTx(payload);
        } catch (e) {
            if (e) e.oraclePreSend = true;
            throw e;
        }

        // 4. Broadcast the signed transaction. Only this call has a side effect, so only
        // ITS failures are classified for ambiguity (item 2675): a timeout / mid-flight
        // reset / 5xx AFTER the request left the wire may mean the DOGE node actually
        // accepted the tx, so a blind retry would spend a second fee and double-anchor
        // the round.
        try {
            let broadcastResult = await this.encoder.broadcastTx(txHex);
            return broadcastResult || { txid: null };
        } catch (e) {
            if (this._isAmbiguousSendError(e)) e.oracleAmbiguousSend = true;
            throw e;
        }
    }

    // Steps 1-3 of the default pipeline: fetch, build, sign. Returns the signed tx hex.
    async _buildSignedTx(payload) {
        if (!this.encoder)         throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if (!this.walletSignFn)    throw new Error('no wallet sign hook configured (call setWalletSignHook)');
        if (!this.dogeAddress)     throw new Error('no DOGE_ADDRESS configured');
        if (!this.dogePubkeyHex)   throw new Error('no DOGE_PUBKEY_HEX configured');

        // 1. Fetch UTXOs for the publisher's DOGE address
        let utxos = await this.encoder.getUtxos(this.dogeAddress);
        if (!utxos || (Array.isArray(utxos) && utxos.length === 0)) {
            throw new Error('no UTXOs available for ' + this.dogeAddress);
        }

        // 2. Create an unsigned PSBT with the PRICE v0 payload
        // PRICE v0 payloads are typically ~900-1100 bytes (well above the 80-byte OP_RETURN limit),
        // so we use P2SH encoding which is what xchain-encoder supports for large payloads.
        let psbtResult = await this.encoder.createTx({
            // Forwarded only while the set is inside the encoder's caller-facing
            // MAX_UTXO_COUNT; past it the param is omitted so the encoder selects
            // from its own uncapped fetch of this same address. See
            // lib/encoder_utxo_forward.js.
            utxos:    forwardableUtxos(utxos, 'OraclePublisher'),
            // The encoder's P2SH path runs bitcoin.address.fromBase58Check() on this
            // field, so it must be the base58check address (not the raw hex pubkey).
            pubkey:   this.dogeAddress,
            data:     payload,
            change:   this.dogeAddress,
            encoding: 'P2SH',
            // CONFIRMED INPUTS ONLY. Spending our own unconfirmed change chains every
            // batch onto the one before it, and miners score a transaction by its whole
            // ancestor package: one cheap early transaction then holds down every batch
            // published after it, however much the newest one pays. That is what turned
            // a single underpaid batch into a nine-hour backlog of nine transactions,
            // where the newest paid 1.36 per kB and still could not move a package
            // anchored to ancestors paying 0.003. Each batch must stand alone and be
            // judged on its own fee rate. When no confirmed output is available the
            // pass defers (see the NO_CONFIRMED_UTXO gate), which is the correct
            // outcome: a deferred window is recoverable, a chained package is not.
            unconfirmed: this.allowUnconfirmedInputs
        });
        if (!psbtResult || !psbtResult.psbt) {
            throw new Error('encoder returned no PSBT');
        }
        // 2b. Refuse phase 1 of a two-transaction encoding. P2SH answers a FUNDING tx
        // whose payload only becomes readable when a reveal spends it, and this pipeline
        // has no reveal: broadcasting it publishes an undecodable PRICE and strands the
        // carrier value. Thrown BEFORE the wallet hook, so nothing is signed and no fee
        // is spent. See lib/two_phase_guard.js.
        assertSingleTxEncoding(psbtResult, 'OraclePublisher');

        // 3. Sign the PSBT via the operator-provided wallet hook
        let txHex = await this.walletSignFn(psbtResult.psbt);
        if (!txHex || typeof txHex !== 'string') {
            throw new Error('wallet sign hook returned invalid tx hex');
        }
        return txHex;
    }

    // Classify a broadcast failure (delegates to the shared classifier so
    // all four hub effectors answer "could this send have landed?" identically).
    _isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    }

    // ----- Landing: confirmed-UTXO reserve -----

    // Split a get_utxos list by confirmation depth. `known` reports whether the
    // source served a usable confirmations field at all: an entry without one is
    // counted in `total` and in neither bucket, so a source that stops serving the
    // field reads as unknown rather than as "everything is unconfirmed".
    // byTxid holds the deepest confirmation seen per transaction, which is what the
    // watchdog matches a broadcast against.
    _summarizeUtxos(utxos) {
        let summary = { total: 0, confirmed: 0, unconfirmed: 0, known: false,
                        byTxid: new Map(), at: Date.now() };
        for (let u of utxos) {
            if (!u || typeof u !== 'object') continue;
            summary.total++;
            let conf = Number(u.confirmations);
            if (!Number.isFinite(conf) || conf < 0) continue;
            summary.known = true;
            if (conf >= CONFIRMED_DEPTH) summary.confirmed++;
            else                         summary.unconfirmed++;
            let txid = u.txid ? String(u.txid) : null;
            if (!txid) continue;
            let seen = summary.byTxid.get(txid);
            if (seen === undefined || conf > seen) summary.byTxid.set(txid, conf);
        }
        return summary;
    }

    // Read the publisher address's UTXO set and summarize it, or null when the set
    // cannot be read. FAIL SOFT, unlike the balance gate: this reading only ever
    // withholds a broadcast, so an unreachable encoder must leave the decision to the
    // guards that already fail closed rather than add a second way to stall publishing.
    async _readUtxoReserve() {
        if (!this.encoder || !this.dogeAddress) return null;
        let utxos;
        try {
            utxos = await this.encoder.getUtxos(this.dogeAddress);
        } catch (err) {
            console.warn('OraclePublisher: UTXO reserve check failed (confirmation state unknown ' +
                'this pass; publishing is not blocked on it): ', err);
            return null;
        }
        if (!Array.isArray(utxos)) return null;
        let summary = this._summarizeUtxos(utxos);
        this.lastUtxoReserve = { total: summary.total, confirmed: summary.confirmed,
                                 unconfirmed: summary.unconfirmed, known: summary.known,
                                 at: summary.at };
        return summary;
    }

    // May a publish pass build a wire right now? False only for the one provable
    // condition: the address holds outputs, their confirmation state is known, and
    // NOT ONE of them is confirmed. That means every spendable input is change
    // trapped behind an unconfirmed chain, so any wire built here inherits the stuck
    // package's fate: it either chains onto it and stalls the same way, or is refused
    // once the chain hits Dogecoin's inherited 25-transaction / 101 kB ancestor limits.
    // Deferring costs one window; broadcasting costs a fee for a wire that cannot mine.
    async _confirmedUtxoAvailable() {
        let summary = await this._readUtxoReserve();
        if (!summary)                       return true;   // unreadable: not our call to block
        if (!summary.known)                 return true;   // no confirmations field served
        if (summary.total === 0)            return true;   // empty wallet is the balance gate's call
        return summary.confirmed > 0;
    }

    // ----- Landing: confirmation watchdog -----

    // Start watching broadcasts to confirmation. Unref'd so it never holds the process
    // open, and a no-op when the cadence is disabled or nothing could ever be read.
    _startConfirmationWatchdog() {
        if (this._confirmTimer) return;
        if (!this.confirmCheckIntervalMs) return;
        if (!this.encoder || !this.dogeAddress) return;
        this._confirmTimer = setInterval(() => {
            this._checkPublishedConfirmations().catch((e) => {
                // Unreachable in practice (the check swallows its own faults); kept so a
                // future edit inside it can never reject into an unhandled rejection.
                console.warn('OraclePublisher: confirmation watchdog tick failed: ', e);
            });
        }, this.confirmCheckIntervalMs);
        if (this._confirmTimer.unref) this._confirmTimer.unref();
    }

    // Record a broadcast as awaiting confirmation. A broadcaster that returns no txid
    // cannot be watched, so it is not tracked: an untrackable send must not masquerade
    // as a stalled one.
    _notePendingConfirmation(round, txid) {
        if (!txid) return;
        let key = String(txid);
        if (this._pendingConfirmations.has(key)) return;
        this._pendingConfirmations.set(key, { txid: key, round: round, sentAt: Date.now() });
        while (this._pendingConfirmations.size > this.pendingConfirmationsMax) {
            let oldest = this._pendingConfirmations.keys().next().value;
            this._pendingConfirmations.delete(oldest);
        }
    }

    // One watchdog pass. Resolves what has landed and leaves the rest ageing.
    //
    // Two shapes count as landed, because the publisher spends only its own address:
    //   - the transaction's own output is in the set at CONFIRMED_DEPTH or deeper
    //   - the transaction is absent from the set while some output IS confirmed: its
    //     change was spent by a descendant, and a confirmed output at this address
    //     cannot descend from an unmined ancestor
    // Everything else stays pending, which is exactly the stuck case: a package whose
    // change is still sitting unconfirmed in the mempool.
    //
    // Fail soft end to end. An unreadable encoder returns early with the tail intact,
    // and nothing here throws, blocks publishing, or spends.
    async _checkPublishedConfirmations() {
        if (this._pendingConfirmations.size === 0) return;
        let summary;
        try {
            summary = await this._readUtxoReserve();
        } catch (e) {
            summary = null;
        }
        if (!summary || !summary.known) {
            this.confirmationCheckFailures++;
            return;
        }
        this.lastConfirmationCheckAt = Date.now();

        for (let entry of Array.from(this._pendingConfirmations.values())) {
            let depth = summary.byTxid.get(entry.txid);
            if (depth !== undefined) {
                if (depth >= CONFIRMED_DEPTH) {
                    this._pendingConfirmations.delete(entry.txid);
                    this.confirmedPublishes++;
                }
                continue;
            }
            if (summary.confirmed > 0) {
                this._pendingConfirmations.delete(entry.txid);
                this.confirmedPublishes++;
            }
        }

        let oldest = this.oldestUnconfirmedPublish();
        if (oldest && oldest.ageMs >= this.confirmStaleMs) {
            console.warn('OraclePublisher: UNCONFIRMED_PUBLISH - ' + this._pendingConfirmations.size +
                ' broadcast(s) have never been seen confirmed; oldest is round ' + oldest.round +
                ' txid ' + oldest.txid + ' sent ' + Math.round(oldest.ageMs / 1000) + 's ago. ' +
                'The publisher address holds ' + summary.confirmed + ' confirmed and ' +
                summary.unconfirmed + ' unconfirmed output(s). Nothing is re-broadcast or fee-bumped ' +
                'automatically; an operator decides how to unstick the package.');
        }
    }

    // The oldest broadcast still awaiting confirmation, or null. Cheap, in-memory,
    // and safe to call from getStats.
    oldestUnconfirmedPublish() {
        let oldest = null;
        for (let entry of this._pendingConfirmations.values()) {
            if (!oldest || entry.sentAt < oldest.sentAt) oldest = entry;
        }
        if (!oldest) return null;
        return { txid: oldest.txid, round: oldest.round, sentAt: oldest.sentAt,
                 ageMs: Math.max(0, Date.now() - oldest.sentAt) };
    }

    // Initialize the publisher: ensure queue directory exists, load any pending rounds
    async start() {
        // The per-window spend ceilings were memory-only, so every restart
        // restored a full allowance. Reload the saved window before anything publishes.
        this.spendGuard.persistTo();
        // Ensure queue directory exists
        let dir = path.dirname(this.queuePath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            console.warn('OraclePublisher: failed to create queue directory ' + dir + ':', e);
        }

        // Touch queue file
        try {
            if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '');
        } catch (e) {
            console.warn('OraclePublisher: queue file unwritable at ' + this.queuePath + ':', e);
        }

        // Reload the v2 round buffer. A restart between a round finalizing and its
        // window closing must not lose the round: it is the sole hub-side copy of an
        // hour of price data that has not reached a chain yet.
        this._hydrateBuffer();

        // ...and re-register the window those rounds belong to, because the grace timers
        // themselves did not survive the restart.
        this._rearmBufferedWindows();

        // Hydrate the durable at-most-once guard before subscribing to new rounds:
        // load confirmed rounds into the in-process guard and quarantine any
        // intent-only rounds so a restart can never re-broadcast an already-published
        // (or ambiguously-published) round. Best-effort; a DB error is logged inside.
        if (this.db) {
            try {
                await this._hydratePublishedMarkers();
            } catch (e) {
                console.error('OraclePublisher: failed to hydrate durable publish markers on startup ' +
                    '(the in-process guard still covers this lifetime): ', e);
            }
        }

        // Subscribe to oracle finalization events
        if (this.hub.oracleConsensus) {
            this.hub.oracleConsensus.on('round:finalized', (event) => {
                this.onRoundFinalized(event).catch(err => {
                    console.error('OraclePublisher: onRoundFinalized error:', err);
                });
            });
        }

        // Catch-up for windows that closed while this hub was down. Every buffered
        // window except the newest is closed by definition (a higher round exists), and
        // the newest joins them when the buffer holds its last slot, so one
        // delayed sweep re-arms exactly what the restart dropped. Delayed by the
        // grace so a hub restarting mid-window still gives its peers time to come up
        // before it proposes a batch they cannot yet co-sign.
        //
        // Bounded, rather than queuing every closed window at once. A hub coming
        // back to a long backlog therefore drains it over several sweeps rather than in
        // one pass; that is the trade the bound buys, and it is the right way round,
        // because assemblies are serialized and a failing one holds the chain for a
        // whole sign timeout, so the unbounded form put the LIVE window behind every
        // stale one.
        this._scheduleBufferCatchup();

        // ...and the recurring pass, because a window that fails its signing round is
        // left un-memoized precisely so it can be re-proposed, and until now nothing
        // ever did.
        this._startBufferCatchupSweep();

        // Watch broadcasts through to a block. Without it a wire that never mines
        // leaves the rail reporting a healthy lastPublishedTxid indefinitely.
        this._startConfirmationWatchdog();

        console.log('OraclePublisher started (queue: ' + this.queuePath + ', address: ' + (this.dogeAddress || '<unset>') + ')');
        // The publish cadence next to the bound it has to fit inside, because a rail
        // that is publishing perfectly on a cadence too slow for the fee gate looks
        // healthy in every other line this class logs.
        let peakMs = worstCaseSnapshotAgeMs(this.batchWindowRounds, {
            roundIntervalMs:  this.roundIntervalMs,
            graceMs:          this.batchGraceMs,
            landingReserveMs: this.batchLandingReserveMs });
        console.log('OraclePublisher PRICE batch cadence: ' + this.batchWindowRounds +
            ' round(s)/batch = one wire per ' +
            Math.round((this.batchWindowRounds * this.roundIntervalMs) / 1000) + 's' +
            (this.batchWindowRoundsCeiling === null
                ? ' (no staleness bound resolved; window not capped)'
                : ', ceiling ' + this.batchWindowRoundsCeiling + '; newest snapshot peaks at ' +
                  (peakMs === null ? '?' : Math.round(peakMs / 1000)) + 's against a ' +
                  Math.round(this.oracleMaxPriceAgeMs / 1000) + 's fee-price staleness bound'));
    }

    // Release every timer this class owns, plus a batch signer it created itself.
    // The class had no stop() before the batch rail, because it had no timers.
    stop() {
        for (let state of this._windows.values()) {
            if (state.timer) clearTimeout(state.timer);
        }
        this._windows.clear();
        for (let timer of this._takeoverTimers.values()) clearTimeout(timer);
        this._takeoverTimers.clear();
        if (this._catchupTimer) { clearTimeout(this._catchupTimer); this._catchupTimer = null; }
        if (this._catchupSweepTimer) { clearInterval(this._catchupSweepTimer); this._catchupSweepTimer = null; }
        if (this._confirmTimer) { clearInterval(this._confirmTimer); this._confirmTimer = null; }
        if (this._ownedBatchSigner) {
            try { this._ownedBatchSigner.stop(); } catch (e) { /* stopping is best-effort */ }
            this._ownedBatchSigner = null;
        }
    }

    // Called when a round is finalized. Enqueue if this node is the leader.
    async onRoundFinalized(event) {
        // item 2677 kill switch: when disabled, do not enqueue or broadcast.
        // Skip rather than queue-for-later so a disabled publisher does not silently
        // build a backlog that floods on-chain the moment it is re-enabled.
        if (!this.enabled) {
            console.log('OraclePublisher: disabled (ORACLE_PUBLISH_ENABLED=false); skipping round ' + event.round);
            return;
        }
        // PRICE v0 BATCH RAIL, unconditional. A finalized round never rides its own
        // transaction: it goes into the buffer and leaves as part of a signed batch. There
        // is no activation gate and no v0 fallback rail here, so this hub cannot be one
        // stamp away from emitting a wire its peers index differently.
        //
        // No leader check here, deliberately: EVERY hub buffers EVERY round it finalizes,
        // because window leadership is decided at the window's anchor and that anchor is
        // not known when the window's first round finalizes. Leader election, the durable
        // queue and the broadcast happen at window assembly (_assembleWindow).
        await this._bufferFinalizedRound(event);
        this._noteWindowRound(event.round);
    }

    // Determine this node's rank in the sorted oracle_publish validator list, or null if not active
    // Sort order: signing_pubkey ascending (deterministic across all nodes that share the active set)
    async _getMyRank(blockIndex) {
        if (!this.identity) return null;
        let myPubkey = String(this.identity.getPubkeyHex()).toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(blockIndex);
        let idx = pubkeys.indexOf(myPubkey);
        return idx >= 0 ? idx : null;
    }

    // Transition-only warn for the capability-snapshot fail-closed paths. Called
    // once per finalized round, so a persistent fault would otherwise log every
    // round; emit only on the transition INTO dark and reset on the next successful
    // resolution. The fail-closed [] return itself is never changed by this.
    _logSnapshotDark(detail, err) {
        if (this._snapshotDark) return;
        this._snapshotDark = true;
        let suffix = err ? (': ' + (err && err.message ? err.message : err)) : '';
        console.warn('OraclePublisher: oracle_publish capability snapshot ' + detail +
            '; failing closed, this hub will not publish until it resolves' + suffix);
    }

    // Get the count of active oracle_publish validators
    async _getActiveOraclePublishCount(blockIndex) {
        let pubkeys = await this._getActiveOraclePublishPubkeys(blockIndex);
        return pubkeys.length;
    }

    // Get the sorted list of active oracle_publish validator signing pubkeys at
    // the given block boundary. Uses the on-chain snapshot (via CapabilitySnapshot)
    // so every hub that has processed identical on-chain data through blockIndex
    // returns the same array regardless of when gossip messages arrived.
    // Fails closed (returns []) when the block-pinned snapshot is unresolved.
    // Returns: array of 64-hex pubkey strings, sorted ascending.
    async _getActiveOraclePublishPubkeys(blockIndex) {
        if (!this.hub) return [];

        // Primary: deterministic on-chain snapshot at blockIndex
        if (this.hub.capabilitySnapshot && blockIndex !== undefined && blockIndex !== null) {
            try {
                let snapshot = await this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
                if (snapshot && Array.isArray(snapshot.validators)) {
                    this._snapshotDark = false;
                    return snapshot.validators
                        .map(v => String(v.pubkey).toLowerCase())
                        .sort();
                }
                // Snapshot resolved to null. This is the dominant dark path:
                // CapabilitySnapshot.getSnapshot returns null (does NOT throw) when the
                // indexer is unreachable, the result is an error, or the echoed block
                // mismatches, so it never reaches the catch below. Left silent, the
                // publisher stops publishing with no trace. Log the transition so a dark
                // publisher is distinguishable in the hub log from a hub that legitimately
                // is not an oracle_publish validator. The [] return is unchanged.
                this._logSnapshotDark('resolved to null at block ' + blockIndex, null);
            } catch (err) {
                // Fail closed: fall through to []. Log the transition (once per dark
                // spell) so a persistent throw leaves a trace instead of failing silent.
                this._logSnapshotDark('threw at block ' + blockIndex, err);
            }
        }

        // Fail closed on a pinned-block miss. The old live-registry fallback
        // (capabilityRegistry.getActiveValidators) is block-unpinned and filtered on
        // qualified/self_test_ok/enabled over gossip-driven rows, so it is a per-hub
        // view of "now": two hubs would rank/size the round-robin over different sets
        // (duplicate PRICE v0 broadcast + duplicate DOGE fee, or a dropped round). The
        // caller already treats myRank === null as "not a publisher". Matches the
        // accepted fix for #686/#925/#930.
        return [];
    }

    // Fallback: build a single-validator signature locally if the round event didn't carry any.
    // Only used in degenerate cases; normal operation collects sigs from consensus prepare/commit.
    _buildLocalSigOnly(event) {
        if (!this.identity) return [];
        try {
            let payload = this._buildSignablePayload(event.round, event.btcBlockTime, event.prices, event.btcBlockHeight);
            let sigHex  = this.identity.sign(payload);
            return [{ pubkey: this.identity.getPubkeyHex(), sig: sigHex }];
        } catch (e) {
            console.warn('OraclePublisher: failed to build local sig:', e);
            return [];
        }
    }

    // Build the canonical signable payload. Must match indexer's ed25519.buildPriceV0Payload
    // (including the EQUIV header gate on the round's BTC block height, #4232). The height
    // is part of the signed content; only the bare-JSON branch is built here because this
    // local-sig fallback is degenerate (no EQUIV-era round reaches it on a real federation),
    // and the canonical-byte equality with the indexer is enforced by the consensus path.
    _buildSignablePayload(round, timestamp, prices, btcBlockHeight) {
        let pairs = prices.map(p => ({ pair: p.coinPair, price: String(p.price) }));
        let sortedPairs = pairs.sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        return JSON.stringify({
            round:            parseInt(round),
            timestamp:        parseInt(timestamp),
            btc_block_height: parseInt(btcBlockHeight),
            pairs:            sortedPairs
        });
    }

    // Build the on-wire PRICE v0 payload as a pipe-delimited string
    // Format: PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
    // BTC_BLOCK_HEIGHT is the round's BTC anchor (the EQUIV gate input, in the signed payload).
    buildPriceV0Wire(round, timestamp, prices, sigs, btcBlockHeight) {
        let parts = ['PRICE', '0', String(round), String(timestamp), String(parseInt(btcBlockHeight)), String(prices.length)];
        for (let p of prices) {
            parts.push(p.coinPair || p.pair);
            parts.push(String(p.price));
        }
        parts.push(String(sigs.length));
        for (let s of sigs) {
            parts.push(s.pubkey);
            parts.push(s.sig);
        }
        return parts.join('|');
    }

    // Enqueue a round for publishing (durable, fsync'd)
    async _enqueue(round) {
        let entry = Object.assign({}, round, { attempts: 0, enqueuedAt: Date.now() });
        let line  = JSON.stringify(entry) + '\n';
        try {
            let fd = fs.openSync(this.queuePath, 'a');
            fs.writeSync(fd, line);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('OraclePublisher: failed to enqueue round %s:', round.round, e);
            // Fail loud: refuse to ack if queue is unwritable
            throw e;
        }
    }

    // Append a give-up entry to the durable dead-letter file (never truncated).
    // Best-effort: a write failure is logged but does not keep the entry looping
    // forever on the main queue. Records the original entry plus when and why it
    // was abandoned so an operator can replay the round manually.
    _deadLetter(entry, reason) {
        this.abandonedCount++;
        let record = Object.assign({}, entry, { deadLetteredAt: Date.now(), reason: reason });
        let line   = JSON.stringify(record) + '\n';
        try {
            let fd = fs.openSync(this.deadLetterPath, 'a');
            fs.writeSync(fd, line);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('OraclePublisher: failed to write dead-letter record for round %s:', entry.round, e);
        }
    }

    // Every round a queue entry carries. A v0 entry carries exactly one, so the v0
    // paths keep their previous behavior byte for byte; a batch entry carries all
    // the rounds on its wire, which is the granularity every at-most-once guard and
    // every durable marker row is keyed at.
    _entryRounds(entry) {
        if (entry && entry.batch && Array.isArray(entry.batch.rounds) && entry.batch.rounds.length > 0) {
            return entry.batch.rounds.map(r => parseInt(r)).filter(r => Number.isFinite(r));
        }
        return [entry.round];
    }

    // Read all queue entries (used by _processQueue and on restart)
    _readQueue() {
        try {
            let raw = fs.readFileSync(this.queuePath, 'utf8');
            return raw.split('\n').filter(line => line.trim().length > 0).map(line => {
                try { return JSON.parse(line); } catch (e) { return null; }
            }).filter(e => e !== null);
        } catch (e) {
            return [];
        }
    }

    // Rewrite the queue with the given entries (used after successful publishes).
    // Returns true on a durable rewrite, false if the truncating write failed. The
    // dequeue side must NOT swallow a failure: on false the just-published rounds are
    // still on the durable queue, so the caller keeps its in-process dedup guard armed
    // (preventing re-broadcast) and surfaces the failure loudly for operator repair.
    _rewriteQueue(entries) {
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            let fd = fs.openSync(this.queuePath, 'w');
            fs.writeSync(fd, lines);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            console.error('OraclePublisher: failed to rewrite queue:', e);
            return false;
        }
    }

    // ================= PRICE batch rail (spec section 7) =================
    //
    // Ordering of the parts below: the buffer file, the window scheduler, window
    // assembly (leader election, self-check, splitting), wire construction, and the
    // marker-clearing seam the ingest side calls on a retraction.

    // ----- The durable round buffer -----

    // Normalize a round:finalized event into the ONE shape the canonical builder and
    // the signing round both take, so nothing downstream has to re-map it. Pair names
    // are read `coinPair || pair` and prices stringified exactly as the v0 producer
    // does, which is what keeps a v2 round object byte-identical to v0's own.
    _bufferEntryFromEvent(event) {
        return {
            round:          parseInt(event.round),
            timestamp:      parseInt(event.btcBlockTime),
            btcBlockHeight: parseInt(event.btcBlockHeight),
            pairs:          (event.prices || []).map(p => ({
                pair:  p.coinPair || p.pair,
                price: String(p.price)
            }))
        };
    }

    // Append one finalized round to the durable buffer, same open('a') + fsync
    // discipline the publish queue and the dead-letter file use. A write failure is
    // FATAL to the caller for the same reason _enqueue's is: an unwritable buffer
    // means this hub silently loses an hour of price data it is the only holder of.
    async _bufferFinalizedRound(event) {
        let entry = this._bufferEntryFromEvent(event);
        if (!Number.isFinite(entry.round)) return;

        // A re-finalization must land here whenever it CHANGED the round.
        // _storeSnapshot's ON DUPLICATE KEY UPDATE is last-write-wins, so a round that
        // finalizes twice leaves price_snapshots holding the second version. A
        // first-write-wins buffer would put the two stores permanently out
        // of step: the batch rail proposes from the BUFFER and every co-signer
        // re-derives from price_snapshots, so one diverged round makes the whole window
        // unsignable forever. Observed on testnet round 107, where the buffer held
        // timestamp 1787939400 with one price set and every hub's DB held 1787940000
        // with another, and window [102,107] was refused by three peers on every
        // re-proposal. An IDENTICAL re-finalization stays a no-op, so the common
        // replay/retry case still costs no disk.
        let prior = this._buffer.get(entry.round);
        if (prior && this._sameBufferedRound(prior, entry)) return;
        if (prior) {
            console.warn('OraclePublisher: round ' + entry.round + ' re-finalized with different ' +
                'content; replacing the buffered copy so the batch rail proposes what ' +
                'price_snapshots actually holds');
        }
        entry.bufferedAt = Date.now();
        let line = JSON.stringify(entry) + '\n';
        try {
            let fd = fs.openSync(this.bufferPath, 'a');
            fs.writeSync(fd, line);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('OraclePublisher: failed to buffer round %s for batching:', entry.round, e);
            throw e;
        }
        this._buffer.set(entry.round, entry);
        // The append above is the durable write (a crash between it and here recovers
        // the new copy, because _hydrateBuffer replays the file in order and the LAST
        // line for a round wins). Compact only after that, so the truncating rewrite is
        // never the thing standing between a finalized round and disk.
        if (prior) this._rewriteBufferFile(this._bufferedRange(-Infinity, Infinity));
        this._enforceBufferBound();
    }

    // Do two buffer entries carry the same signable content? Compares exactly the
    // fields _buildPriceBatchPayload reads, pair order included only through a sorted
    // key, since the builder normalizes ordering itself. bufferedAt is metadata and is
    // deliberately excluded: re-stamping it would rewrite the file on every replay.
    _sameBufferedRound(a, b) {
        if (parseInt(a.round) !== parseInt(b.round)) return false;
        if (parseInt(a.timestamp) !== parseInt(b.timestamp)) return false;
        if (parseInt(a.btcBlockHeight) !== parseInt(b.btcBlockHeight)) return false;
        return this._pairKey(a.pairs) === this._pairKey(b.pairs);
    }

    _pairKey(pairs) {
        return (pairs || [])
            .map(p => String(p.coinPair || p.pair) + '=' + String(p.price))
            .sort()
            .join('|');
    }

    _readBufferFile() {
        try {
            let raw = fs.readFileSync(this.bufferPath, 'utf8');
            return raw.split('\n').filter(l => l.trim().length > 0).map(l => {
                try { return JSON.parse(l); } catch (e) { return null; }
            }).filter(e => e !== null && Number.isFinite(Number(e.round)));
        } catch (e) {
            return [];
        }
    }

    // Truncating rewrite, used only by the two pruning paths. Returns false on a write
    // failure; the in-memory Map is the authority for this process either way, so a
    // failed prune costs disk, never correctness.
    _rewriteBufferFile(entries) {
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            let fd = fs.openSync(this.bufferPath, 'w');
            fs.writeSync(fd, lines);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            console.error('OraclePublisher: failed to rewrite the v2 round buffer at ' +
                this.bufferPath + ':', e);
            return false;
        }
    }

    // Replays the file in order and lets the LAST line for a round win. That is load
    // bearing, not incidental: _bufferFinalizedRound appends a replacement line when a
    // round re-finalizes with different content, and a first-wins reload would restore
    // the stale copy the batch rail can no longer get co-signed.
    _hydrateBuffer() {
        this._buffer = new Map();
        for (let e of this._readBufferFile()) {
            let r = parseInt(e.round);
            if (!Number.isFinite(r)) continue;
            this._buffer.set(r, e);
        }
        if (this._buffer.size > 0) {
            console.log('OraclePublisher: reloaded ' + this._buffer.size +
                ' buffered oracle round(s) from ' + this.bufferPath);
        }
        this._enforceBufferBound();
    }

    // The unconditional bound (D29's second half). Non-leaders normally shed a window
    // when they see its batch land, but a hub that never sees one (dark leader, chain
    // behind, a window nobody led) must still not accumulate forever. Oldest rounds go
    // first: a round old enough to fall off this end is far past any window a later
    // leader would still re-propose.
    _enforceBufferBound() {
        if (this._buffer.size <= this.batchBufferMaxRounds) return;
        let ordered = Array.from(this._buffer.keys()).sort((a, b) => a - b);
        let drop    = ordered.slice(0, this._buffer.size - this.batchBufferMaxRounds);
        for (let r of drop) this._buffer.delete(r);
        console.warn('OraclePublisher: v2 round buffer hit ORACLE_BATCH_BUFFER_MAX_ROUNDS (' +
            this.batchBufferMaxRounds + '); dropped ' + drop.length + ' round(s) up to ' +
            drop[drop.length - 1] + ' without publishing them');
        this._rewriteBufferFile(this._bufferedRange(-Infinity, Infinity));
    }

    // Buffered rounds inside a closed round range, ascending.
    _bufferedRange(first, last) {
        let out = [];
        for (let [r, e] of this._buffer) {
            if (r >= first && r <= last) out.push(e);
        }
        return out.sort((a, b) => parseInt(a.round) - parseInt(b.round));
    }

    // The [first_round, last_round] a batch-sourced consensus_proof claims, or null
    // when the value is not one (a v0 proof is a bare signature ARRAY) or is malformed.
    // Only ever applied to shed BUFFERED rounds, so a wrong answer costs a re-proposal or
    // a stale buffer entry, never a wire; parse defensively and fall back to nothing.
    _batchProofRange(proofJson) {
        if (typeof proofJson !== 'string') return null;
        let parsed;
        try { parsed = JSON.parse(proofJson); } catch (e) { return null; }
        let b = parsed && parsed.batch;
        if (!b) return null;
        let first = parseInt(b.first_round);
        let last  = parseInt(b.last_round);
        if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
        return { first, last };
    }

    // D29's first half: shed the rounds of a window whose batch this hub can already
    // see in its OWN price_snapshots. Batch-sourced rows are the ones whose
    // consensus_proof is the {"batch":...} object of D23; a v0-sourced row's proof is
    // a bare signature array, so the prefix discriminates exactly (the same test
    // PriceAggregator's retraction path uses). Best-effort: a DB error just leaves the
    // rounds buffered until the bound above collects them.
    async _pruneObservedWindow(first, last) {
        if (!this.db) return 0;
        let rows;
        try {
            rows = await this.db.doQuery(
                'SELECT DISTINCT round_number, consensus_proof FROM price_snapshots WHERE round_number >= ? ' +
                'AND round_number <= ? AND consensus_proof LIKE \'{"batch":%\'',
                [first, last]);
        } catch (e) {
            console.warn('OraclePublisher: cannot check for an on-chain batch covering rounds ' +
                first + '..' + last + '; leaving them buffered: ', e && e.message);
            return 0;
        }
        // Prune the whole range each observed batch CLAIMS, not just the rows that
        // carry its proof. receiveBatch dedupes per round: a round already
        // finalized from the v0 rail is counted a duplicate and keeps its v0 proof, so
        // a landed six-round batch typically stamps only the one round this hub was
        // missing. Keying the prune on the stamped rows alone therefore left five of
        // six rounds buffered after a window had demonstrably published, and every
        // later leader re-proposed that published window forever. The proof's own
        // header names the range it covers, so use it.
        let pruned = 0;
        for (let row of (rows || [])) {
            let r = parseInt(row.round_number);
            if (Number.isFinite(r) && this._buffer.delete(r)) pruned++;
            let covered = this._batchProofRange(row.consensus_proof);
            if (!covered) continue;
            for (let n of Array.from(this._buffer.keys())) {
                if (n >= covered.first && n <= covered.last && this._buffer.delete(n)) pruned++;
            }
        }
        if (pruned > 0) {
            this._rewriteBufferFile(this._bufferedRange(-Infinity, Infinity));
            console.log('OraclePublisher: pruned ' + pruned + ' buffered round(s) in ' + first +
                '..' + last + ' after observing their batch on-chain');
        }
        return pruned;
    }

    // ----- Rank-staggered takeover -----

    // Arm this hub to re-assemble a window its leader may never publish. The delay is
    // the hub's DISTANCE from the leader in the rotation, not its absolute rank, so
    // the set steps in one at a time in a deterministic order every hub computes
    // identically from the same snapshot: rank leader+1 first, then leader+2, and so
    // on. Each step is failoverWindowBlocks blocks of continued silence.
    _scheduleTakeover(windowIndex, myRank, leaderRank, publisherCount) {
        if (!this.failoverWindowBlocks) return;             // opt-in, default off
        if (!publisherCount || publisherCount < 2) return;  // nobody to take over from
        if (this._takeoverTimers.has(windowIndex)) return;
        let offset = ((myRank - leaderRank) % publisherCount + publisherCount) % publisherCount;
        if (offset === 0) return;                           // that is the leader itself
        let delay = offset * this.failoverWindowBlocks * this.approxBlockMs;
        let timer = setTimeout(() => {
            this._takeoverTimers.delete(windowIndex);
            this._attemptTakeover(windowIndex).catch(err =>
                console.error('OraclePublisher: takeover attempt for window ' + windowIndex + ' failed:', err));
        }, delay);
        if (timer.unref) timer.unref();
        this._takeoverTimers.set(windowIndex, timer);
    }

    // Step in for a silent leader, or decline. Declines for four distinct reasons,
    // each of which must stay distinguishable in the log from "took over". Only one of
    // them is temporary: the ambiguity cooldown re-arms itself and comes back.
    async _attemptTakeover(windowIndex) {
        if (!this.enabled) return false;
        let first = windowIndex * this.batchWindowRounds;
        let last  = first + this.batchWindowRounds - 1;

        // 1. The leader published after all. Nothing to do; prune our copy.
        if (await this._pruneObservedWindow(first, last) > 0) return false;
        if (await this._windowObservedOnChain(first, last)) return false;

        // 2. FAIL CLOSED when this hub has never observed ANY batch on chain. The
        // observation feed is the indexer pushing landed PRICE actions back to this
        // hub, and a hub that receives no pushes cannot tell "the leader published
        // and I did not hear" from "the leader is dark". Taking over on that
        // ambiguity double-pays DOGE and puts a duplicate batch on chain, so a hub
        // with an unproven feed declines every takeover and says so once.
        if (!(await this._observationFeedProven())) {
            if (!this._takeoverDarkWarned) {
                this._takeoverDarkWarned = true;
                console.warn('OraclePublisher: declining takeover of window ' + windowIndex + ' and every ' +
                    'later one: this hub has never observed an on-chain PRICE batch, so it cannot tell a ' +
                    'silent leader from a deaf follower. Point this network\'s indexer HUB_API_URL at this ' +
                    'federation so landed batches are pushed back, then takeover arms itself.');
            }
            return false;
        }

        // 3. AMBIGUOUS IN-FLIGHT BATCH. "Not on chain" cannot tell a leader
        // that never broadcast from one whose tx is sitting unmined in the DOGE
        // mempool, and re-publishing over the second pays the fee twice for a window
        // that is already in flight. Two local facts make the send ambiguous: a
        // co-signature this hub HANDED the leader (the last thing it needed before
        // broadcasting) and an ambiguous send of this hub's own for the same window.
        // Either starts the cooldown. When the cooldown elapses and the window is
        // STILL absent from the observed-on-chain view above, the tx demonstrably
        // never mined and takeover is safe. Same shape as AttestationPublisher's
        // _ambiguousSends deferral, which this rail was missing.
        let ambiguousAt = this._takeoverAmbiguityAt(windowIndex, first, last);
        if (ambiguousAt !== null && this.takeoverAmbiguousCooldownMs > 0) {
            let waited = Date.now() - ambiguousAt;
            if (waited < this.takeoverAmbiguousCooldownMs) {
                this.takeoverDeferred++;
                let remaining = this.takeoverAmbiguousCooldownMs - waited;
                console.warn('OraclePublisher: deferring takeover of window ' + windowIndex +
                    ' for ~' + Math.ceil(remaining / 1000) + 's: a batch covering rounds ' + first +
                    '..' + last + ' may already be in flight (evidence ~' + Math.round(waited / 1000) +
                    's ago), and re-publishing over an unmined leader tx pays the DOGE fee twice');
                // Re-arm, or the deferral is a CANCELLATION: the timer that brought us
                // here is already gone, so a leader that turns out to have been dark
                // after all would never be covered by this hub.
                this._rearmTakeover(windowIndex, remaining);
                return false;
            }
            // Cooldown spent with the window still off chain: whatever was in flight
            // never mined. Drop the mark so a later pass does not re-derive it.
            this._ambiguousWindows.delete(windowIndex);
        }

        // 4. Nothing published it and we can prove we would have seen it. Re-assemble
        // the identical window, bypassing the leader check but nothing else: quorum
        // signing, coverage, the spend guard and the at-most-once markers all still
        // apply, and the queue's own guards stop a second wire for rounds already sent.
        this._assembledWindows.delete(windowIndex);
        await this._assembleWindow(windowIndex, { takeover: true });
        return true;
    }

    // The most recent local evidence that a batch covering [first,last] may ALREADY be
    // on the wire, or null when there is none. Two sources, both of which mean "a tx
    // may exist that this hub cannot see yet":
    //
    //   - this hub's own ambiguous send for the window (_processQueue dead-letters it
    //     rather than retrying, precisely because the DOGE node may have taken it);
    //   - the co-signature this hub gave the window's leader, which is the last thing
    //     the leader was waiting on. A leader that never asked cannot have broadcast,
    //     so a window with no co-signature is genuine silence and takes over at once.
    //
    // The signer is read through the hub, never through _getBatchSigner(): that
    // accessor CONSTRUCTS and starts a signer as a side effect, which a read-only
    // question must not do (same pattern as _batchSignTimeouts).
    _takeoverAmbiguityAt(windowIndex, first, last) {
        let newest = this._ambiguousWindows.has(windowIndex)
            ? this._ambiguousWindows.get(windowIndex)
            : null;
        let signer = (this.hub && this.hub.oracleBatchSigner) || this._ownedBatchSigner;
        if (signer && typeof signer.coSignedAt === 'function') {
            let ts = null;
            try {
                ts = signer.coSignedAt(first, last);
            } catch (e) {
                console.warn('OraclePublisher: cannot read the batch signer\'s co-signature memo ' +
                    'for rounds ' + first + '..' + last + ': ', e && e.message);
                ts = null;
            }
            if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
        }
        return newest;
    }

    // Remember that a batch wire for this window left the process AMBIGUOUSLY, so a
    // takeover armed against the same window defers instead of duplicating the spend.
    _noteAmbiguousWindow(windowIndex) {
        if (!Number.isFinite(windowIndex)) return;
        this._ambiguousWindows.delete(windowIndex);
        this._ambiguousWindows.set(windowIndex, Date.now());
        while (this._ambiguousWindows.size > AMBIGUOUS_WINDOW_MEMO_MAX) {
            this._ambiguousWindows.delete(this._ambiguousWindows.keys().next().value);
        }
    }

    // Put the deferred takeover back on the clock. Deliberately not _scheduleTakeover:
    // that one computes the rank stagger from scratch, and this window's stagger has
    // already been served; what is left to wait out is only the cooldown remainder.
    _rearmTakeover(windowIndex, delay) {
        if (this._takeoverTimers.has(windowIndex)) return;
        let timer = setTimeout(() => {
            this._takeoverTimers.delete(windowIndex);
            this._attemptTakeover(windowIndex).catch(err =>
                console.error('OraclePublisher: deferred takeover attempt for window ' + windowIndex + ' failed:', err));
        }, Math.max(1, delay));
        if (timer.unref) timer.unref();
        this._takeoverTimers.set(windowIndex, timer);
    }

    // Is any round in [first,last] already carried by a batch this hub has seen land
    // on chain? Fail CLOSED on a DB error (report observed), so an unreadable hub DB
    // suppresses takeover instead of licensing a blind duplicate broadcast.
    async _windowObservedOnChain(first, last) {
        if (!this.db) return true;
        try {
            let rows = await this.db.doQuery(
                'SELECT 1 AS seen FROM price_snapshots WHERE round_number >= ? AND round_number <= ? ' +
                'AND consensus_proof LIKE \'{"batch":%\' LIMIT 1', [first, last]);
            return !!(rows && rows.length);
        } catch (e) {
            console.warn('OraclePublisher: cannot check whether rounds ' + first + '..' + last +
                ' are already on chain; declining takeover: ', e && e.message);
            return true;
        }
    }

    // Has a landed batch EVER reached this hub? Memoized true only: a feed that is
    // dark now can come up later, and a fresh federation legitimately has nothing to
    // observe until its first window lands, so this arms itself rather than needing
    // an operator to flip it.
    async _observationFeedProven() {
        if (this._observationProven) return true;
        if (!this.db) return false;
        try {
            let rows = await this.db.doQuery(
                'SELECT 1 AS seen FROM price_snapshots WHERE consensus_proof LIKE \'{"batch":%\' LIMIT 1');
            if (rows && rows.length) this._observationProven = true;
        } catch (e) {
            console.warn('OraclePublisher: cannot confirm the on-chain observation feed; ' +
                'takeover stays disarmed: ', e && e.message);
        }
        return this._observationProven;
    }

    // ----- The window scheduler -----

    _windowIndexOf(round) {
        return Math.floor(parseInt(round) / this.batchWindowRounds);
    }

    // Called for every round this hub buffers. Two things close a window: its LAST
    // slot finalizing, or a round of a HIGHER window arriving (which proves the lower
    // one can receive nothing more). Skipped rounds make the second case the normal
    // one at the end of an hour, so both are needed.
    _noteWindowRound(round) {
        let w = this._windowIndexOf(round);
        if (!Number.isFinite(w)) return;
        for (let lower of Array.from(this._windows.keys())) {
            if (lower < w) this._armWindowTimer(lower);
        }
        if (!this._windows.has(w)) this._windows.set(w, { timer: null });
        if (parseInt(round) % this.batchWindowRounds === this.batchWindowRounds - 1) {
            this._armWindowTimer(w);
        }
    }

    // Arm the grace timer for a window, once. Never re-armed: extending it on every
    // late arrival would let a steady trickle of stragglers postpone an hour of price
    // data indefinitely.
    _armWindowTimer(windowIndex) {
        let state = this._windows.get(windowIndex);
        if (!state) { state = { timer: null }; this._windows.set(windowIndex, state); }
        if (state.timer) return;
        // Already handled. Drop the tracking entry too, or a window that assembled
        // early keeps a row in _windows that every later round re-walks.
        if (this._assembledWindows.has(windowIndex)) { this._windows.delete(windowIndex); return; }
        state.timer = setTimeout(() => {
            state.timer = null;
            this._windows.delete(windowIndex);
            this._queueWindowAssembly(windowIndex);
        }, this.batchGraceMs);
        if (state.timer.unref) state.timer.unref();
    }

    // Serialize assemblies onto one chain. The signing round holds a single in-flight
    // slot, so two windows assembling at once would have the second one silently
    // clobber the first's round.
    _queueWindowAssembly(windowIndex) {
        this._windowChain = this._windowChain.then(() =>
            this._assembleWindow(windowIndex).catch(e =>
                console.error('OraclePublisher: window ' + windowIndex + ' assembly failed:', e)));
        return this._windowChain;
    }

    _scheduleBufferCatchup() {
        if (this._buffer.size === 0) return;
        this._catchupTimer = setTimeout(() => {
            this._catchupTimer = null;
            this._sweepBufferCatchup();
        }, this.batchGraceMs);
        if (this._catchupTimer.unref) this._catchupTimer.unref();
    }

    // Is this window's LAST slot in the buffer? That round is the one whose arrival
    // closes the window live, so holding it is proof the window is closed even when no
    // higher round exists yet and no timer survived to say so.
    _windowLastSlotBuffered(windowIndex) {
        return this._buffer.has(windowIndex * this.batchWindowRounds + this.batchWindowRounds - 1);
    }

    // Every closed window this hub still holds buffered rounds for, has not already
    // assembled in this process, and has no grace timer of its own already pending.
    //
    // Every window below the highest is closed by construction, because a higher round
    // exists. Excluding the highest outright, on the theory that it may still
    // be open, is true only while its last slot is missing. A window whose last
    // round is buffered has closed, and excluding it meant a restart inside its grace
    // orphaned it: the timer died with the process, and nothing re-proposed the window
    // until some later round happened to open a higher one. So the highest
    // is included exactly when the buffer proves it closed.
    //
    // A window whose grace timer is still pending is skipped, because that timer owns
    // it: assembling early would publish a wire without the straggler rounds the grace
    // exists to collect.
    //
    // _assembledWindows is what keeps this cheap on the second and later sweeps: a
    // window this hub followed, published, or found empty is memoized there, so what
    // survives the filter is exactly the windows that ATTEMPTED and produced no wire.
    _pendingCatchupWindows() {
        if (this._buffer.size === 0) return [];
        let windows = Array.from(new Set(
            Array.from(this._buffer.keys()).map(r => this._windowIndexOf(r)))).sort((a, b) => a - b);
        let highest = windows[windows.length - 1];
        return windows.filter(w => {
            if (this._assembledWindows.has(w)) return false;
            let state = this._windows.get(w);
            if (state && state.timer) return false;
            return w < highest || this._windowLastSlotBuffered(w);
        });
    }

    // Put back what a restart dropped. _windows is memory-only, so after a restart the
    // scheduler knows nothing about the rounds _hydrateBuffer just reloaded, and the
    // "a higher window's round arrived, so close the lower ones" path (_noteWindowRound)
    // walks exactly that map: a window whose last slot was SKIPPED before the restart
    // would never be closed by the round that proves it can receive nothing more.
    //
    // Only the highest buffered window is re-registered, and deliberately unarmed. Every
    // window below it is already closed and belongs to the bounded catch-up sweep;
    // registering those here would let one higher round arm them all at once and put the
    // live window behind a queue of stale assemblies, which is the starvation the
    // per-sweep bound exists to prevent. The highest is the one window the sweep cannot
    // reach while it is still open, so it is the one the scheduler must remember.
    _rearmBufferedWindows() {
        if (this._buffer.size === 0) return;
        let highest = -Infinity;
        for (let r of this._buffer.keys()) {
            let w = this._windowIndexOf(r);
            if (Number.isFinite(w) && w > highest) highest = w;
        }
        if (!Number.isFinite(highest)) return;
        if (this._assembledWindows.has(highest)) return;
        if (!this._windows.has(highest)) this._windows.set(highest, { timer: null });
    }

    // One catch-up pass, oldest window first. Bounded, because each attempt can run a
    // signing round that costs up to ORACLE_BATCH_SIGN_TIMEOUT_MS and they are
    // serialized on _windowChain: an unbounded sweep over a long backlog would occupy
    // that chain for hours and starve the live window queued behind it.
    _sweepBufferCatchup() {
        let pending = this._pendingCatchupWindows();
        if (pending.length === 0) return 0;
        let take = pending.slice(0, CATCHUP_WINDOWS_PER_SWEEP);
        this.batchCatchupSweeps++;
        if (pending.length > take.length) {
            console.warn('OraclePublisher: ' + pending.length + ' closed window(s) are still ' +
                'buffered and unpublished; re-proposing ' + take.length + ' of them this sweep ' +
                '(oldest first, from window ' + take[0] + ')');
        }
        for (let w of take) this._queueWindowAssembly(w);
        return take.length;
    }

    // The recurring half of the catch-up, and the half that was missing.
    //
    // A window whose signing round times out below quorum is deliberately NOT memoized,
    // so that it can be re-proposed (spec section 7). Nothing re-proposed it: the
    // sweep ran exactly once per process, ORACLE_BATCH_GRACE_MS after start(). A window
    // that failed once therefore stayed unpublished until an operator happened to
    // restart the hub, and its rounds stayed buffered until the ORACLE_BATCH_BUFFER_MAX_ROUNDS
    // bound eventually shed them unpublished. Measured on public testnet 2026-09-02:
    // window [102,107] refused by three peers at the 2026-09-01 boot and never
    // attempted again in the 11 hours since, with 744 rounds back to round 21 still
    // sitting in the leader's buffer.
    //
    // Deliberately a slow loop, not a tight retry. The refusal it recovers from is
    // either transient (a peer down) or content drift that _reconcileBufferedWindow
    // repairs from price_snapshots, and neither is fixed by asking again sooner; what
    // a fast retry WOULD buy is a signing round per window per interval across the
    // whole federation, plus a refusal line per peer per attempt in every log.
    _startBufferCatchupSweep() {
        if (this._catchupSweepTimer) return;
        this._catchupSweepTimer = setInterval(() => {
            try { this._sweepBufferCatchup(); }
            catch (e) { console.error('OraclePublisher: buffer catch-up sweep failed:', e); }
        }, this.batchCatchupIntervalMs);
        if (this._catchupSweepTimer.unref) this._catchupSweepTimer.unref();
    }

    _noteAssembled(windowIndex) {
        this._assembledWindows.set(windowIndex, true);
        while (this._assembledWindows.size > ASSEMBLED_WINDOW_MEMO_MAX) {
            this._assembledWindows.delete(this._assembledWindows.keys().next().value);
        }
    }

    // ----- Window assembly -----

    // Turn one closed window into zero or more signed, enqueued PRICE v0 wires.
    //
    // opts.takeover: this hub is NOT the window's leader and is stepping in after
    // the leader stayed silent (see _attemptTakeover). Everything downstream of the
    // leader check is identical, deliberately: a takeover must put the same
    // canonical content on chain the leader would have, never a variant.
    async _assembleWindow(windowIndex, opts) {
        if (!this.enabled) return;
        let takeover = !!(opts && opts.takeover);
        if (!takeover && this._assembledWindows.has(windowIndex)) return;

        let first  = windowIndex * this.batchWindowRounds;
        let last   = first + this.batchWindowRounds - 1;
        // Before anything is read off the buffer, make it agree with price_snapshots.
        // Every co-signer re-derives this window from ITS price_snapshots,
        // so a buffered round that has drifted from this hub's own rows is a proposal
        // no honest peer can ever reproduce. Reconciling here is also what unsticks a
        // window that drifted before the buffer learned to track a re-finalization.
        await this._reconcileBufferedWindow(first, last);
        let rounds = this._bufferedRange(first, last);
        if (rounds.length === 0) { this._noteAssembled(windowIndex); return; }

        // The window's anchor is the LAST included round's own BTC anchor, matching the
        // batch anchor the wire header carries and the anchor every verifier resolves
        // the signature set against.
        let anchor = parseInt(rounds[rounds.length - 1].btcBlockHeight);

        // Leader election over the SAME sorted oracle_publish snapshot the v0 rail
        // rotates on, keyed on the window rather than the round.
        let pubkeys = await this._getActiveOraclePublishPubkeys(anchor);
        if (pubkeys.length === 0) return;   // fail closed, already logged by the resolver
        let me     = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        let myRank = me ? pubkeys.indexOf(me) : -1;
        if (myRank < 0) return;             // not an oracle_publish validator at this anchor

        let leaderRank = windowIndex % pubkeys.length;
        this._lastRankState = {
            round:          last,
            myRank:         myRank,
            leaderRank:     leaderRank,
            isLeader:       leaderRank === myRank,
            publisherCount: pubkeys.length
        };
        if (leaderRank !== myRank && !takeover) {
            // Not our window. The buffered rounds are NOT dropped here: they are this
            // hub's evidence for the on-chain observation prune, and its material if a
            // later window has to re-propose this one.
            this._followerRounds++;
            this._noteAssembled(windowIndex);
            let pruned = await this._pruneObservedWindow(first, last);
            // Pruned means the leader's batch is already on chain, so there is
            // nothing to take over. Only an unobserved window gets a timer.
            if (pruned === 0) this._scheduleTakeover(windowIndex, myRank, leaderRank, pubkeys.length);
            return;
        }
        if (takeover) this.takeoverAttempts++;
        else this._leaderRounds++;

        // The self-check. A window published with a hole in it puts a signed, permanent
        // claim on chain that the missing round did not finalize.
        if (!(await this._windowCoverageComplete(first, last, rounds))) return;

        let signer = this._getBatchSigner();
        if (!signer) {
            console.warn('OraclePublisher: no OracleBatchSigner available; window [' + first + ',' +
                last + '] stays unpublished');
            return;
        }

        let sigCountHint = await this._priceSetSizeHint(anchor, pubkeys.length);
        let wires = [];
        for (let segment of this._splitByFlagDay(rounds)) {
            let idx = 0;
            while (idx < segment.length) {
                let take  = Math.max(1, this._packSegment(segment.slice(idx), sigCountHint));
                let range = segment.slice(idx, idx + take);
                let wire  = await this._signAndSizeRange(signer, range);
                if (wire === null) {
                    // Quorum was not reached. Nothing publishes for this window and it is
                    // deliberately NOT memoized, so a later leader (or a later catch-up on
                    // this hub) can re-propose the identical canonical content.
                    return;
                }
                idx += wire.rounds.length;
                if (wire.unpublishable) continue;   // the ceiling case, already dead-lettered
                wires.push(wire);
            }
        }

        this._noteAssembled(windowIndex);
        if (wires.length === 0) return;
        if (takeover) {
            this.takeoverPublished++;
            console.warn('OraclePublisher: TAKING OVER window [' + first + ',' + last + '] from its ' +
                'silent leader (rank ' + leaderRank + '); this hub is rank ' + myRank + ' and has seen no ' +
                'on-chain batch covering it');
        }
        if (wires.length > 1) {
            // Counted at assembly, not at broadcast: splitting is a decision this code
            // makes, and it stays worth seeing even if the wires then fail to send.
            this.batchSplitCount += wires.length - 1;
            console.log('OraclePublisher: window [' + first + ',' + last + '] split into ' +
                wires.length + ' PRICE v0 wires to fit ' + PRICE_WIRE_MAX_BYTES + ' bytes');
        }

        for (let i = 0; i < wires.length; i++) {
            await this._enqueue({
                // Identity field stays the FIRST round, so _processQueue's Sets and the
                // retention sweep's queue-floor clamp keep working on a scalar (D10).
                round: wires[i].firstRound,
                batch: {
                    windowIndex: windowIndex,
                    firstRound:  wires[i].firstRound,
                    lastRound:   wires[i].lastRound,
                    anchor:      wires[i].anchor,
                    rounds:      wires[i].rounds.map(r => parseInt(r.round)),
                    sigCount:    wires[i].sigCount,
                    compressed:  wires[i].compressed,
                    wireIndex:   i,
                    wireCount:   wires.length
                },
                wire: wires[i].wire
            });
        }

        await this._processQueue();
        await this._pruneObservedWindow(first, last);
    }

    // Make the buffered copy of a window agree with price_snapshots, which is the ONE
    // store both sides of the signing round can see: the leader proposes from the
    // buffer and every co-signer re-derives from its own price_snapshots, so anything
    // the buffer holds that its own DB contradicts is a proposal that cannot reach
    // quorum however honest the leader is.
    //
    // Replaces drifted rounds and sheds already-landed ones. It never ADDS a round:
    // a finalized round with no buffered copy is _windowCoverageComplete's case, and
    // that path deliberately withholds the window rather than inventing content.
    //
    // Best effort by design. A DB error leaves the buffer as it was and assembly
    // proceeds exactly as before, because the signing round is the real gate: the
    // worst a stale proposal can do is fail to reach quorum, which is where this
    // window already was.
    async _reconcileBufferedWindow(first, last) {
        if (!this.db) return 0;
        let rows;
        try {
            rows = await this.db.doQuery(
                'SELECT round_number, coin_pair, price, reference_block, block_timestamp, ' +
                'LEFT(consensus_proof, 8) AS proof_head ' +
                'FROM price_snapshots WHERE round_number >= ? AND round_number <= ? AND status = ? ' +
                'ORDER BY round_number ASC, coin_pair ASC',
                [first, last, 'finalized']);
        } catch (e) {
            console.warn('OraclePublisher: cannot reconcile the buffered copy of window [' + first +
                ',' + last + '] against price_snapshots; proposing the buffer as-is: ', e && e.message);
            return 0;
        }

        let derived = new Map();
        for (let row of (rows || [])) {
            let r = parseInt(row.round_number);
            if (!Number.isFinite(r)) continue;
            let entry = derived.get(r);
            if (!entry) {
                entry = { round: r, timestamp: parseInt(row.block_timestamp),
                          btcBlockHeight: parseInt(row.reference_block), pairs: [],
                          // A batch-sourced row's reference_block is the LANDING chain's
                          // height, not this round's BTC anchor, so its content can no
                          // longer be rebuilt here. It is also, by definition, already on
                          // chain. See OracleBatchSigner._deriveWindow.
                          batchSourced: String(row.proof_head || '').indexOf('{"batch"') === 0 };
                derived.set(r, entry);
            }
            entry.pairs.push({ pair: String(row.coin_pair), price: String(row.price) });
        }

        let changed = 0;
        for (let [r, entry] of derived) {
            let buffered = this._buffer.get(r);
            if (!buffered) continue;
            if (entry.batchSourced) {
                this._buffer.delete(r);
                changed++;
                console.warn('OraclePublisher: dropping buffered round ' + r + ' from window [' + first +
                    ',' + last + ']: it came from a batch that already landed on chain, so it needs ' +
                    'no re-publishing and its own BTC anchor is no longer recoverable here');
                continue;
            }
            // Fail CLOSED on a derived round that is not well formed. The buffer is the
            // only copy of a finalized round this hub holds once its rows age out, so a
            // half-read row (a NULL anchor, an unpriced pair) must leave it alone rather
            // than overwrite good content with a header the canonical builder would
            // turn into NaN.
            if (!this._wellFormedRound(entry)) {
                console.warn('OraclePublisher: skipping reconcile of buffered round ' + r +
                    ': its price_snapshots rows did not read back as a complete round');
                continue;
            }
            if (this._sameBufferedRound(buffered, entry)) continue;
            entry.bufferedAt = Date.now();
            this._buffer.set(r, entry);
            changed++;
            console.warn('OraclePublisher: buffered round ' + r + ' disagreed with this hub\'s own ' +
                'price_snapshots; refreshed it from the DB so the batch proposal is something ' +
                'peers can reproduce');
        }
        if (changed > 0) this._rewriteBufferFile(this._bufferedRange(-Infinity, Infinity));
        return changed;
    }

    // Is a round read back from price_snapshots complete enough to sign? Every field
    // the canonical builder reads has to be a real value, or the bytes it produces
    // carry a NaN and no verifier on any chain accepts them.
    _wellFormedRound(entry) {
        if (!entry || !Number.isFinite(entry.round)) return false;
        if (!Number.isFinite(entry.timestamp) || !Number.isFinite(entry.btcBlockHeight)) return false;
        if (!Array.isArray(entry.pairs) || entry.pairs.length === 0) return false;
        for (let p of entry.pairs) {
            if (!p.pair || p.pair === 'undefined') return false;
            if (p.price === undefined || p.price === null ||
                p.price === '' || p.price === 'null' || p.price === 'undefined') return false;
        }
        return true;
    }

    // Refuse the window if any round it should carry finalized locally but is not in
    // the buffer. Deliberately keyed on status = 'finalized' ONLY: the third enum value
    // 'disputed' marks a reorg-retracted row, and the signing round refuses to sign
    // disputed content, so treating a disputed round as "present but unbuffered" would
    // stall the window forever waiting for something no peer will ever co-sign.
    // No exemption for early rounds: batching is unconditional, so every round that
    // finalized locally was buffered and an unbuffered one is a real coverage hole.
    async _windowCoverageComplete(first, last, rounds) {
        if (!this.db) return true;
        let rows;
        try {
            rows = await this.db.doQuery(
                'SELECT DISTINCT round_number, block_timestamp FROM price_snapshots ' +
                'WHERE round_number >= ? AND round_number <= ? AND status = ?',
                [first, last, 'finalized']);
        } catch (e) {
            console.warn('OraclePublisher: cannot self-check window [' + first + ',' + last +
                '] against price_snapshots; withholding the batch (fail closed): ', e && e.message);
            return false;
        }
        let have    = new Set(rounds.map(r => parseInt(r.round)));
        let missing = [];
        for (let row of (rows || [])) {
            let r = parseInt(row.round_number);
            if (!Number.isFinite(r) || have.has(r)) continue;
            missing.push(r);
        }
        if (missing.length > 0) {
            console.warn('OraclePublisher: window [' + first + ',' + last + '] has finalized round(s) ' +
                missing.join(', ') + ' with no buffered copy; withholding the batch rather than ' +
                'publishing a signed claim that they did not finalize');
            return false;
        }
        return true;
    }

    // A composite verdict of every armed oracle flag day at one BTC anchor. Rounds
    // whose keys differ cannot share a wire: a batch resolves those gates ONCE on the
    // batch anchor, so a straddling range would judge its earlier rounds under a rule
    // set they never finalized under. OracleBatchSigner._straddlesArmedOracleFlagDay is
    // the receiving-side twin of this, and it refuses SILENTLY, so a leader that skips
    // this split simply never reaches quorum and the window never publishes.
    _flagDayKey(btcBlockHeight) {
        let h = Number(btcBlockHeight);
        return (swq.isStakeWeightedQuorumActive(h, this.network) ? '1' : '0') +
               (pst.isPriceSigTallyVerifyFirstActive(h, this.network) ? '1' : '0');
    }

    _splitByFlagDay(rounds) {
        let segments = [];
        let current  = [];
        let key      = null;
        for (let r of rounds) {
            let k = this._flagDayKey(r.btcBlockHeight);
            if (key === null || k === key) {
                current.push(r);
            } else {
                segments.push(current);
                current = [r];
            }
            key = k;
        }
        if (current.length > 0) segments.push(current);
        return segments;
    }

    // How many signatures to SIZE against before the signing round has produced any.
    // The price-capable set at the anchor is the upper bound on what can come back, so
    // packing against it never under-splits; the post-signing measurement in
    // _signAndSizeRange is the authority either way.
    async _priceSetSizeHint(anchor, fallback) {
        try {
            if (this.hub && this.hub.capabilitySnapshot) {
                let snap = await this.hub.capabilitySnapshot.getSnapshot('price', anchor);
                if (snap && Array.isArray(snap.validators) && snap.validators.length > 0) {
                    return snap.validators.length;
                }
            }
        } catch (e) { /* the hint is advisory; fall through to the publisher set size */ }
        return Math.max(1, fallback || 1);
    }

    // Signature-shaped filler for pre-signing size estimates. Byte-exact in length for
    // the uncompressed form (64-hex pubkey, 128-hex signature), and high-entropy so the
    // COMPRESSED estimate is not flattered: repeating one placeholder would deflate to
    // almost nothing and the packer would then over-fill every wire.
    _placeholderSigs(count) {
        let out = [];
        for (let i = 0; i < count; i++) {
            let a = crypto.createHash('sha256').update('xpriceb-size-pubkey-' + i).digest('hex');
            let b = crypto.createHash('sha256').update('xpriceb-size-sig-a-' + i).digest('hex') +
                    crypto.createHash('sha256').update('xpriceb-size-sig-b-' + i).digest('hex');
            out.push({ pubkey: a, sig: b });
        }
        return out;
    }

    // Largest leading run of `rounds` whose estimated wire fits the ceiling. Returns 0
    // when even the first round overflows; the caller still proposes that single round,
    // so the loud-ceiling path measures a REAL wire rather than an estimate.
    _packSegment(rounds, sigCount) {
        let sigs = this._placeholderSigs(sigCount);
        let n    = Math.min(rounds.length, PRICE_BATCH_MAX_ROUND_COUNT);
        while (n >= 1) {
            let sub = rounds.slice(0, n);
            let emitted = this._emitWire(sub[0].round, sub[n - 1].round,
                sub[n - 1].btcBlockHeight, sub, sigs);
            if (this._wireFits(emitted)) return n;
            n--;
        }
        return 0;
    }

    // Run the signing round for a range, then measure the wire the signatures actually
    // produced. Shrinks and re-signs while the real wire overflows, because the sig set
    // is only known after quorum and a bigger-than-estimated set can push a range over.
    //
    // Returns { wire, bytes, rounds, ... } on success, a { unpublishable: true } record
    // when a single round cannot fit at all, or null when quorum was not reached.
    async _signAndSizeRange(signer, range) {
        let candidate = range;
        while (candidate.length >= 1) {
            let first  = parseInt(candidate[0].round);
            let last   = parseInt(candidate[candidate.length - 1].round);
            let anchor = parseInt(candidate[candidate.length - 1].btcBlockHeight);

            let result;
            try {
                result = await signer.collectBatchSignatures(first, last, anchor, candidate);
            } catch (e) {
                console.error('OraclePublisher: batch-signing round for [' + first + ',' + last +
                    '] threw; window stays unpublished: ', e);
                return null;
            }
            // met:false means quorum was not reached. Those signatures are observability
            // only; publishing them would put a wire on chain that no indexer accepts and
            // spend a DOGE fee for it.
            if (!result || result.met !== true || !Array.isArray(result.sigs) || result.sigs.length === 0) {
                console.warn('OraclePublisher: no signing quorum for batch [' + first + ',' + last +
                    ']; window stays unpublished (a later leader re-proposes it)');
                return null;
            }

            let emitted = this._emitWire(first, last, anchor, candidate, result.sigs);
            if (this._wireFits(emitted)) {
                return {
                    wire:       emitted.wire,
                    bytes:      emitted.bytes,
                    compressed: emitted.compressed,
                    firstRound: first,
                    lastRound:  last,
                    anchor:     anchor,
                    sigCount:   result.sigs.length,
                    rounds:     candidate
                };
            }

            if (candidate.length === 1) {
                // THE CEILING. One round plus its signature set does not fit either wire
                // form, so no split can rescue it and the federation has outgrown the
                // 8,189-byte payload limit. v0 already counts oversized drops and
                // dead-letters them; what is new here is the CRITICAL-level line and a
                // batch-specific counter an operator can alert on.
                this.batchUnpublishableCount++;
                let bound = emitted.bytes > PRICE_WIRE_MAX_BYTES
                    ? 'the encoder payload limit (' + emitted.bytes + ' bytes on the wire, ' +
                      (emitted.compressed ? 'compressed' : 'uncompressed') + ')'
                    : 'the reader\'s inflated-body cap (' + emitted.bodyBytes + ' body bytes; ' +
                      'the wire itself is only ' + emitted.bytes + ')';
                console.error('OraclePublisher: CRITICAL - PRICE v0 round ' + first +
                    ' alone does not fit with ' + result.sigs.length + ' signature(s): it breaches ' +
                    bound + ', over the ' + PRICE_WIRE_MAX_BYTES + '-byte limit. No split can fit ' +
                    'it: this federation has outgrown the PRICE wire. The round is dead-lettered to ' +
                    this.deadLetterPath + ' and NOTHING publishes for it.');
                this._deadLetter({
                    round:          first,
                    batchFirstRound: first,
                    batchLastRound:  last,
                    btcBlockHeight: anchor,
                    rounds:         candidate,
                    sigs:           result.sigs
                }, 'PRICE v0 single round exceeds encoder limit of ' + PRICE_WIRE_MAX_BYTES +
                   ' (wire ' + emitted.bytes + ' bytes, body ' + emitted.bodyBytes + ' bytes)');
                return { unpublishable: true, rounds: candidate };
            }
            candidate = candidate.slice(0, candidate.length - 1);
        }
        return null;
    }

    // ----- The batch wire -----

    // Everything after `PRICE|0|` in the uncompressed form. Rounds are re-sorted and
    // pairs re-normalized here exactly as the canonical builder does, so the wire and
    // the signed canonical describe the same content in the same order.
    buildPriceBatchBody(firstRound, lastRound, btcBlockHeight, rounds, sigs) {
        let ordered = [...rounds].sort((a, b) => parseInt(a.round) - parseInt(b.round));
        // The batch header's BTC_BLOCK_HEIGHT must EQUAL the LAST included round's own
        // anchor: both verifiers now reject a mismatch, so a wire built from a freely
        // chosen anchor is a DOGE fee spent on an action the chain refuses. Derived
        // here rather than taken on trust, which is what makes a mismatched header
        // unrepresentable, and the caller's value is cross-checked so a split that
        // forgot to re-derive for its sub-range is LOUD instead of merely wrong.
        let derivedAnchor = parseInt(ordered[ordered.length - 1].btcBlockHeight);
        if (parseInt(btcBlockHeight) !== derivedAnchor) {
            throw new Error('OraclePublisher: PRICE batch anchor ' + parseInt(btcBlockHeight) +
                ' does not equal the last included round\'s anchor ' + derivedAnchor +
                '; both verifiers reject this wire. The anchor must be re-derived for every split.');
        }
        let parts = [String(parseInt(firstRound)), String(parseInt(lastRound)),
                     String(derivedAnchor), String(ordered.length)];
        for (let r of ordered) {
            let pairs = r.pairs.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }))
                .sort((a, b) => {
                    if (a.pair < b.pair) return -1;
                    if (a.pair > b.pair) return 1;
                    return 0;
                });
            parts.push(String(parseInt(r.round)));
            parts.push(String(parseInt(r.timestamp)));
            parts.push(String(parseInt(r.btcBlockHeight)));
            parts.push(String(pairs.length));
            for (let p of pairs) { parts.push(p.pair); parts.push(p.price); }
        }
        parts.push(String(sigs.length));
        for (let s of sigs) { parts.push(s.pubkey); parts.push(s.sig); }
        return parts.join('|');
    }

    // Emit whichever form is smaller. A batch that deflates larger (short bodies, or
    // content deflate cannot exploit) simply rides uncompressed; both forms are equally
    // valid and the reader distinguishes them on the `Z` in the FIRST_ROUND slot.
    _emitWire(firstRound, lastRound, btcBlockHeight, rounds, sigs) {
        let body  = this.buildPriceBatchBody(firstRound, lastRound, btcBlockHeight, rounds, sigs);
        let plain = 'PRICE|0|' + body;
        let plainBytes = Buffer.byteLength(plain, 'utf8');
        let bodyBytes  = Buffer.byteLength(body, 'utf8');
        try {
            let packed      = 'PRICE|0|' + PRICE_BATCH_COMPRESSION_MARKER + '|' + compressPriceBatchBody(body);
            let packedBytes = Buffer.byteLength(packed, 'utf8');
            if (packedBytes < plainBytes) {
                return { wire: packed, bytes: packedBytes, compressed: true, bodyBytes: bodyBytes };
            }
        } catch (e) {
            console.warn('OraclePublisher: deflate of the PRICE v0 body failed; ' +
                'emitting the uncompressed form: ', e && e.message);
        }
        return { wire: plain, bytes: plainBytes, compressed: false, bodyBytes: bodyBytes };
    }

    // TWO bounds, and missing the second one spends a DOGE fee on an action no reader
    // will accept. The encoder's payload limit binds the bytes actually broadcast, and
    // `price_batch_compression.js` binds the INFLATED body to the same number
    // (`outputCap = Math.min(PRICE_WIRE_MAX_BYTES, ratioCap)`), so a compressed wire
    // that comfortably fits the encoder can still carry a body every indexer refuses to
    // finish inflating. Compression therefore buys FEE, not round capacity: it relaxes
    // this predicate by the 8 bytes of the `PRICE|0|` prefix and nothing more.
    _wireFits(emitted) {
        return emitted.bytes <= PRICE_WIRE_MAX_BYTES && emitted.bodyBytes <= PRICE_WIRE_MAX_BYTES;
    }

    // The signing round. Preferred from the hub so one instance owns the P2P handler;
    // when the hub wires none this class creates and owns one, which is what keeps the
    // batch rail functional on a hub whose wiring has not caught up.
    _getBatchSigner() {
        if (this.hub && this.hub.oracleBatchSigner) return this.hub.oracleBatchSigner;
        if (this._ownedBatchSigner) return this._ownedBatchSigner;
        if (!this.hub) return null;
        try {
            this._ownedBatchSigner = new OracleBatchSigner(this.hub);
            this._ownedBatchSigner.start();
            return this._ownedBatchSigner;
        } catch (e) {
            console.error('OraclePublisher: cannot construct an OracleBatchSigner:', e);
            return null;
        }
    }

    // ----- The retraction seam (D28), called by PriceAggregator -----

    // Forget that a set of rounds was ever published, in BOTH halves of the
    // at-most-once guard. Clearing only the durable rows leaves the in-process set
    // still suppressing the re-publish, and a reorg then costs an hour of price
    // history rather than a round.
    //
    // The quarantine set is deliberately untouched: a quarantined round's on-chain
    // state is unknown, which a retraction does not resolve, and only an operator may
    // release one.
    async clearPublishedMarkers(rounds) {
        let list = (Array.isArray(rounds) ? rounds : [rounds])
            .map(r => parseInt(r)).filter(r => Number.isFinite(r));
        if (list.length === 0) return 0;

        for (let r of list) {
            this._publishedRounds.delete(r);
            // The window memo is the third suppressor: an assembled window is never
            // re-assembled, so a retracted window would never be rebuilt without this.
            this._assembledWindows.delete(this._windowIndexOf(r));
        }

        if (!this.db) return list.length;
        let placeholders = list.map(() => '?').join(',');
        let result = await this.db.doQuery(
            'DELETE FROM oracle_published_rounds WHERE round IN (' + placeholders + ')', list);
        let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
        console.log('OraclePublisher: cleared publish markers for ' + list.length +
            ' retracted batch round(s) (' + deleted + ' durable row(s) removed); the recovery ' +
            're-publish is no longer suppressed');
        return deleted;
    }

    // ----- Durable at-most-once marker (oracle_published_rounds) -----

    // Read the durable marker for a round, or null when none exists / no DB is wired.
    // Shape: { round, txid, sent_at }. A row with a non-null sent_at is the
    // authoritative "already broadcast" signal (txid may legitimately be null if the
    // broadcaster returned none, so sent_at, not txid, gates re-broadcast).
    // Throws on a DB error so the caller can FAIL CLOSED (never broadcast when we
    // cannot prove the round is unpublished).
    async _getPublishedMarker(round) {
        if (!this.db) return null;
        let rows = await this.db.doQuery(
            'SELECT round, txid, sent_at FROM oracle_published_rounds WHERE round = ?',
            [round]
        );
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    // Durably record broadcast INTENT for a round before the send. Idempotent: an
    // existing row (intent or sent) is left untouched. Throws on a DB error so the
    // caller fails closed. No-op when no DB is wired.
    async _recordPublishIntent(round) {
        if (!this.db) return;
        await this.db.doQuery(
            'INSERT INTO oracle_published_rounds (round) VALUES (?) ' +
            'ON DUPLICATE KEY UPDATE round = round',
            [round]
        );
    }

    // Durably record that a round's broadcast COMPLETED (sets sent_at + txid). Called
    // after a successful send. A failure here is logged, not thrown: the DOGE is
    // already spent, and the intent row means a restart quarantines the round rather
    // than re-broadcasting it. No-op when no DB is wired.
    async _markPublished(round, txid) {
        if (!this.db) return;
        try {
            await this.db.doQuery(
                'UPDATE oracle_published_rounds SET txid = ?, sent_at = NOW() WHERE round = ?',
                [txid, round]
            );
        } catch (e) {
            console.error('OraclePublisher: broadcast for round ' + round + ' succeeded but its durable ' +
                'sent marker could not be persisted; a restart will QUARANTINE (not re-broadcast) this round. ' +
                'Operator: confirm the txid on-chain. Error: ', e);
        }
    }

    // Startup reconciliation of the durable marker table. Loads every confirmed
    // (sent_at set) round into the in-process guard so a queued-but-already-published
    // round is never re-broadcast after a restart, and QUARANTINES every intent-only
    // (sent_at NULL) round: a crash between intent and confirmation leaves the on-chain
    // state unknown, so those are never auto-rebroadcast: only surfaced for an operator
    // to verify and replay by hand (no price-by-round indexer query exists to reconcile
    // them automatically). Best-effort: a DB error is logged and startup continues; the
    // in-process guard still covers this process lifetime.
    async _hydratePublishedMarkers() {
        if (!this.db) return;
        let rows = await this.db.doQuery('SELECT round, sent_at FROM oracle_published_rounds', []);
        let quarantined = [];
        for (let r of (rows || [])) {
            let round = Number(r.round);
            if (r.sent_at !== null && r.sent_at !== undefined) {
                this._publishedRounds.mark(round);
            } else {
                this._quarantinedRounds.add(round);
                quarantined.push(round);
            }
        }
        if (quarantined.length > 0) {
            console.error('OraclePublisher: ' + quarantined.length + ' round(s) have a publish-intent marker ' +
                'with no confirmation (rounds ' + quarantined.join(', ') + '); their on-chain state is unknown ' +
                'after a crash. They will NOT be re-broadcast automatically (fail closed). Operator: verify each ' +
                'round on-chain and replay manually if absent.');
        }
    }

    // Bound the durable oracle_published_rounds marker table to the retention window.
    // Without this the table appends one row per published round forever.
    //
    // Two invariants dominate this DELETE, both load-bearing on a money-bearing path:
    //
    //   1. `sent_at IS NOT NULL` is mandatory. A sent_at NULL row is an intent-only
    //      QUARANTINE marker: broadcast intent was recorded but the confirmation never
    //      landed, so the round's on-chain state is unknown and only an operator can
    //      reconcile it (_hydratePublishedMarkers surfaces them at startup and refuses
    //      to auto-rebroadcast). Pruning one would erase the sole record that a round
    //      needs hand-verification, and the round would then look never-attempted.
    //   2. No round still on the durable queue may be pruned. The marker is what stops
    //      a restart from re-broadcasting a queued-but-already-published round (a
    //      duplicate DOGE spend). A queue entry older than the retention window means
    //      the queue is not draining, so the cutoff is clamped below the oldest queued
    //      round rather than trusting the window.
    //
    // Returns the number of rows deleted. Throws on a DB error; the caller decides
    // (the publish path treats a retention failure as non-fatal).
    async _prunePublishedRounds(anchorRound) {
        if (!this.db) return 0;
        if (!this.publishedRoundsRetentionRounds || this.publishedRoundsRetentionRounds <= 0) return 0;
        let anchor = Number(anchorRound);
        if (!Number.isFinite(anchor)) return 0;

        let cutoff = anchor - this.publishedRoundsRetentionRounds;
        if (cutoff <= 0) return 0;

        // Invariant 2: never prune a marker whose round can still be read off the
        // durable queue file. Best-effort read; an unreadable queue returns [] and the
        // window applies unchanged (the file being unreadable is already loud elsewhere).
        // A batch entry's `round` is its FIRST round, which is also the LOWEST round
        // it carries, so the clamp below still lands under every round the entry
        // protects and needs no batch-specific arm.
        for (let entry of this._readQueue()) {
            let r = Number(entry && entry.round);
            if (Number.isFinite(r) && r < cutoff) cutoff = r;
        }
        if (cutoff <= 0) return 0;

        let result = await this.db.doQuery(
            'DELETE FROM oracle_published_rounds WHERE round < ? AND sent_at IS NOT NULL',
            [cutoff]);
        let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
        if (deleted > 0) {
            this.publishedRoundsPruned += deleted;
            console.log('OraclePublisher: published-rounds retention pruned ' + deleted +
                ' confirmed marker row(s) older than round ' + cutoff + ' (keep ' +
                this.publishedRoundsRetentionRounds + ' rounds; quarantined intent-only ' +
                'rows are never pruned)');
        }
        return deleted;
    }

    // Self-overlap guard for the publish pass, the same house convention the sibling
    // publishers carry (AttestationPublisher._sweeping, AttestationSpotChecker
    // ._schedulerTick). onRoundFinalized awaits a pass per PBFT event and nothing
    // serializes those events, so two rounds finalizing inside one pass duration would
    // otherwise run two passes over the same durable queue. That is a DOUBLE DOGE
    // SPEND, not a duplicate log line: every at-most-once check in the body closes only
    // AFTER the multi-second encoder+sign+broadcast round trip (_publishedRounds.mark
    // and _markPublished are post-send), and the pre-send intent write is deliberately
    // idempotent (ON DUPLICATE KEY UPDATE), so a second pass clears every guard while
    // the first pass's broadcast is still in flight and re-broadcasts the same round.
    // A wrapper rather than an inline flag, so none of the body's early returns can
    // skip the release. Skipping is safe: the skipped round stays on the durable queue
    // (the rewrite below preserves mid-pass arrivals) and publishes on the next round
    // this hub leads.
    async _processQueue() {
        if (this._sweeping) {
            console.warn('OraclePublisher: publish pass still in flight; skipping this pass ' +
                '(entries stay on the durable queue and publish on the next pass)');
            return;
        }
        this._sweeping = true;
        try {
            return await this._processQueueInner();
        } finally {
            this._sweeping = false;
        }
    }

    // Process pending rounds in the queue: build payload, check balance, broadcast
    async _processQueueInner() {
        // item 2677 kill switch: suppress the replay/sweep too, not just the live
        // path, so a disabled publisher spends nothing. Entries stay on the durable
        // queue untouched and resume only when re-enabled and re-swept.
        if (!this.enabled) {
            console.log('OraclePublisher: disabled (ORACLE_PUBLISH_ENABLED=false); skipping queue processing');
            return;
        }

        let entries = this._readQueue();
        if (entries.length === 0) return;

        // item 2676 - hard balance floor gate (was: balance read then only WARNed,
        // publishing continued regardless). A null/unreadable balance is fail-closed:
        // skip the whole publish pass rather than spend blind. Below the floor, skip
        // too; entries stay queued and retry once the wallet is topped up. This bounds
        // total drain to the floor no matter which failure mode is driving the spend.
        let balance = await this._checkBalance();
        // Only enforce when a balance source is actually wired (a getBalanceFn hook,
        // or an encoder + address to sum UTXOs). With no source, balance is always
        // null and there is nothing to enforce, so preserve prior behavior rather
        // than disable publishing outright.
        let hasBalanceSource = !!(this.getBalanceFn || (this.encoder && this.dogeAddress));
        if (hasBalanceSource) {
            if (balance === null) {
                console.warn('OraclePublisher: DOGE balance unreadable; skipping publish this pass (fail-closed), ' +
                    entries.length + ' round(s) remain queued');
                return;
            }
            if (balance < this.lowBalanceThreshold) {
                console.warn('OraclePublisher: DOGE balance ' + balance.toFixed(4) + ' below floor ' +
                    this.lowBalanceThreshold + '; skipping publish (fail-closed), ' + entries.length + ' round(s) remain queued');
                return;
            }
        }

        // Confirmed-UTXO reserve. A balance above the floor says nothing about whether
        // that balance can be SPENT INTO A MINEABLE WIRE: after a publish that never
        // confirms, the whole balance is change sitting unconfirmed behind the stuck
        // package. Building on top of it buys a second wire with the same fate, or the
        // encoder's "no spendable inputs available" once the ancestor limits bite.
        // Defer the pass instead: entries stay on the durable queue, nothing is
        // dead-lettered, and no attempt counter is burned, because this is not a
        // broadcast failure. Fail soft, see _confirmedUtxoAvailable.
        if (!(await this._confirmedUtxoAvailable())) {
            this.noConfirmedUtxoDeferrals++;
            this.lastNoConfirmedUtxoAt = Date.now();
            let seen = this.lastUtxoReserve || { unconfirmed: 0 };
            console.warn('OraclePublisher: NO_CONFIRMED_UTXO - every one of the ' + seen.unconfirmed +
                ' spendable output(s) at ' + this.dogeAddress + ' is unconfirmed (change trapped behind ' +
                'an unconfirmed chain); deferring this publish pass, ' + entries.length +
                ' round(s) remain queued and retry once a publish confirms');
            return;
        }

        let remaining = [];
        let publishedThisPass = false;
        for (let entry of entries) {
            // Entries that have exhausted their broadcast attempts are moved to the
            // append-only dead-letter file rather than silently erased on the next
            // queue rewrite. The finalized round stays recoverable for manual replay,
            // and the give-up is counted (abandonedCount) instead of only logged.
            if (entry.attempts >= this.maxAttempts) {
                console.error('OraclePublisher: round ' + entry.round + ' exceeded max attempts (' +
                    this.maxAttempts + '), moving to dead-letter file ' + this.deadLetterPath);
                this._deadLetter(entry, 'exceeded max attempts (' + this.maxAttempts + ')');
                continue;
            }

            // Every at-most-once check below runs over the entry's CONTAINED rounds, not
            // its identity field. For a v0 entry that list is [entry.round] and nothing
            // changes; for a batch it is every round on the wire, which is what stops
            // a re-publish under a DIFFERENT split from finding no marker and paying DOGE
            // a second time for rounds already on chain (D10).
            let entryRounds = this._entryRounds(entry);

            // At-most-once guard. If this round was already broadcast this process
            // lifetime, it is only still on the queue because a prior tick's rewrite
            // failed to truncate it. Re-broadcasting would spend DOGE twice, so drop
            // the stale entry (do not push to remaining) instead of sending again.
            if (entryRounds.some(r => this._publishedRounds.has(r))) {
                console.warn('OraclePublisher: round ' + entry.round + ' already broadcast this process lifetime; dropping stale queue entry without re-broadcast (a prior queue rewrite must have failed)');
                continue;
            }

            // Quarantined round (an intent-only durable marker from a pre-crash broadcast
            // whose on-chain state is unknown). NEVER re-broadcast: drop the stale queue
            // entry and leave it for operator replay. Surfaced at startup in _hydratePublishedMarkers.
            if (entryRounds.some(r => this._quarantinedRounds.has(r))) {
                console.warn('OraclePublisher: round ' + entry.round + ' is quarantined (publish intent recorded before a crash, on-chain state unknown); dropping queue entry without re-broadcast, awaiting operator replay');
                continue;
            }

            // Durable at-most-once. Consult the persistent marker before spending DOGE so
            // a restart (empty in-process Set, round still on the durable queue) can never
            // re-broadcast an already-published round. FAIL CLOSED on any DB error: if we
            // cannot prove the round is unpublished we defer rather than risk a duplicate
            // spend (kept on the queue, retried next tick; attempts NOT incremented, this
            // is not a broadcast failure).
            if (this.db) {
                let sent = null;
                let failed = false;
                for (let r of entryRounds) {
                    let marker;
                    try {
                        marker = await this._getPublishedMarker(r);
                    } catch (e) {
                        console.error('OraclePublisher: cannot read durable publish marker for round ' + r +
                            '; deferring broadcast (fail closed to avoid a duplicate DOGE spend): ', e);
                        failed = true;
                        break;
                    }
                    if (marker && marker.sent_at !== null && marker.sent_at !== undefined) { sent = marker; break; }
                }
                if (failed) { remaining.push(entry); continue; }
                if (sent) {
                    // Already broadcast in a prior process; only still on the queue because
                    // a rewrite failed before restart. Drop without re-sending. ANY contained
                    // round being marked condemns the whole wire: the rounds it carries are
                    // already on chain, and a batch is atomic.
                    console.warn('OraclePublisher: round ' + sent.round + ' has a durable sent marker (txid ' +
                        (sent.txid || '<none>') + '); dropping stale queue entry without re-broadcast');
                    for (let r of entryRounds) this._publishedRounds.mark(r);
                    continue;
                }
            }

            // A batch entry carries its finished wire: the signature set it was built
            // against is the one a quorum signed, so the bytes must not be rebuilt here.
            let payload = entry.batch
                ? entry.wire
                : this.buildPriceV0Wire(entry.round, entry.btcBlockTime, entry.prices, entry.sigs, entry.btcBlockHeight);

            // Choose broadcast strategy: custom hook overrides, otherwise use the default encoder pipeline
            let broadcaster = this.broadcastFn || ((p) => this._defaultBroadcast(p));
            let canBroadcast = this.broadcastFn || (this.encoder && this.walletSignFn);

            // Decline an unwired pipeline BEFORE any budget is claimed and before any
            // intent is recorded: nothing can leave the process on this branch, so it
            // must consume no reservation and leave no crash marker behind.
            if (!canBroadcast) {
                console.warn('OraclePublisher: no broadcast pipeline configured (set DOGE_ENCODER_URL + setWalletSignHook, or setBroadcastHook), round ' + entry.round + ' will remain queued');
                entry.attempts++;
                remaining.push(entry);
                continue;
            }

            // item 2676 - per-window spend ceiling. A tripped ceiling is not a
            // failure: keep the round queued (no attempts++) and skip the broadcast
            // so it publishes in a later window.
            //
            // RESERVE rather than allow(): the broadcast below is AWAITED, and
            // src/lib/spend_guard.js forbids the pure allow()/record() pair around an
            // awaited send, because concurrent callers all read the same pre-send budget
            // and every one of them spends past the cap. The _sweeping guard above makes
            // two passes rare rather than impossible (a future second call site, or a
            // sweep timer, reopens it), so the gate is closed by construction here
            // instead of by the caller's discipline. reserve() consumes the budget in
            // this synchronous turn and is handed back by release() only when the send
            // never went out; the reservation IS the recorded spend, so record() must
            // never be called on this path.
            let spendToken = this.spendGuard.reserve();
            if (!spendToken) {
                console.warn(this.spendGuard.noteBlocked() + ' (round ' + entry.round + ')');
                remaining.push(entry);
                continue;
            }

            // Record broadcast intent BEFORE the send and AFTER the reservation. A crash
            // between here and the sent marker leaves an intent-only row that startup
            // quarantines (never auto-rebroadcast), so a round the ceiling DECLINED must
            // never leave one behind: that stranded a round nothing had broadcast.
            // Fail closed if the intent cannot be durably recorded.
            if (this.db) {
                let intentFailed = false;
                for (let r of entryRounds) {
                    try {
                        await this._recordPublishIntent(r);
                    } catch (e) {
                        console.error('OraclePublisher: cannot record durable publish intent for round ' + r +
                            '; deferring broadcast (fail closed): ', e);
                        intentFailed = true;
                        break;
                    }
                }
                if (intentFailed) {
                    this.spendGuard.release(spendToken);
                    remaining.push(entry);
                    continue;
                }
            }

            try {
                let result = await broadcaster(payload);
                // Record the rounds as published BEFORE the queue rewrite. This is the
                // at-most-once anchor: even if the rewrite below fails and leaves this
                // round on the durable queue, the next tick's guard will skip it.
                for (let r of entryRounds) this._publishedRounds.mark(r);
                this.spendGuard.commit(spendToken);   // the reservation IS the fee charged to the window
                // Persist the durable sent marker so the guard survives a restart (the
                // in-process tracker above does not). Best-effort: on failure the intent
                // row remains and a restart quarantines the round rather than re-broadcasting.
                // ONE ROW PER CONTAINED ROUND: the table's semantics are one row per round
                // and every guard reads it that way, so a batch that marked only its first
                // round would leave the rest re-publishable under a different split (D10).
                for (let r of entryRounds) {
                    await this._markPublished(r, (result && result.txid) || null);
                }
                if (entry.batch) {
                    console.log('OraclePublisher: published PRICE batch [' + entry.batch.firstRound + ',' +
                        entry.batch.lastRound + '] carrying ' + entryRounds.length + ' round(s)' +
                        (entry.batch.compressed ? ' (compressed)' : '') + ' (txid: ' + (result && result.txid) + ')');
                    // A window counts once no matter how many wires it split into, so the
                    // counter reads as "windows on chain"; the split count is separate.
                    if (entry.batch.wireIndex === 0 || entry.batch.wireIndex === undefined) {
                        this.batchWindowsPublished++;
                    }
                    this.lastPublishedWindow = entry.batch.windowIndex;
                } else {
                    console.log('OraclePublisher: published round ' + entry.round + ' (txid: ' + (result && result.txid) + ')');
                }
                this.publishedCount++;
                publishedThisPass       = true;
                // LAST_ROUND, not the entry's identity field: the dashboard's
                // publisher-stall rule reads this as "the newest round on chain", and
                // reporting FIRST_ROUND would make a healthy rail look an hour behind.
                this.lastPublishedRound = entry.batch ? entry.batch.lastRound : entry.round;
                this.lastPublishedTxid  = (result && result.txid) || null;
                // Hand the wire to the watchdog. lastPublishedTxid alone answers "did we
                // send", never "did it land", and the two diverge for as long as a stuck
                // package sits in the mempool.
                this._notePendingConfirmation(this.lastPublishedRound, this.lastPublishedTxid);
                // Successfully published. Drop from queue (do not add to remaining).
            } catch (err) {
                // item 2675 - NEVER blind-retry an ambiguous send. A timeout / reset /
                // 5xx after the request left the wire may mean the DOGE node accepted
                // the tx; re-broadcasting would spend DOGE twice and double-anchor the
                // round. OraclePublisher has no on-chain existence check to adopt the
                // possibly-landed tx, so the fail-safe action is to stop auto-retrying:
                // move the round to the durable, recoverable dead-letter file (counted,
                // never silently dropped) for manual inspection/replay. Only definitive
                // pre-send errors keep the existing attempts-and-requeue retry.
                // `oraclePreSend` is the default pipeline's own report that the failure
                // came from a stage that CANNOT have sent anything (get_utxos, create_tx,
                // the sign hook). Without this exclusion the classifier below - which
                // answers "ambiguous" for any error it does not recognise - dead-lettered
                // a get_utxos timeout, permanently removing a never-broadcast round from
                // automatic retry. A custom broadcastFn sets no tag, so an unknown
                // broadcaster keeps the conservative default it has today.
                if (!(err && err.oraclePreSend)
                    && (this._isAmbiguousSendError(err) || (err && err.oracleAmbiguousSend))) {
                    // COMMIT, not release: this branch has already decided the tx may be
                    // on-chain and dead-letters the round rather than retrying, so the fee
                    // may well have been paid. Keeping the reservation charges the window
                    // for it, which fails closed; releasing would hand back budget for a
                    // spend nothing will ever re-attempt.
                    this.spendGuard.commit(spendToken);
                    console.error('OraclePublisher: AMBIGUOUS send failure for round ' + entry.round +
                        ' (tx may have reached the DOGE node); NOT re-broadcasting to avoid a double spend. ' +
                        'Moving to dead-letter file ' + this.deadLetterPath + ' for manual verify/replay: ', err);
                    this._deadLetter(entry, 'ambiguous send failure (possible double-spend risk); verify on-chain before replay');
                    // The same tx that must not be auto-retried here must not
                    // be re-published by this hub's own takeover of the window either.
                    if (entry.batch) this._noteAmbiguousWindow(parseInt(entry.batch.windowIndex));
                    continue;   // do not push to remaining; no auto re-broadcast
                }
                // Definitive pre-send failure: nothing left the process and the round is
                // requeued for a later attempt, so the budget goes back (the invariant
                // the old post-send record() gave for free).
                this.spendGuard.release(spendToken);
                entry.attempts++;
                console.error('OraclePublisher: publish failed for round ' + entry.round + ' (attempt ' + entry.attempts + '/' + this.maxAttempts + '): ', err);
                if (balance !== null && balance < 0.01) {
                    console.error('OraclePublisher: insufficient DOGE balance for round ' + entry.round);
                }
                remaining.push(entry);
            }
        }

        // Rebuild the durable queue from a FRESH read rather than truncating it to the
        // snapshot this pass began with. _enqueue APPENDS to the same file, and
        // onRoundFinalized enqueues before it calls the pass, so a round finalized while
        // this pass was awaiting a broadcast is on disk but absent from `entries`; a
        // blind rewrite to `remaining` erases it, and the overlap guard above makes that
        // arrival MORE likely rather than less (the skipped pass leaves the round on the
        // queue and nothing else drains it). Keep this pass's copy of an unresolved
        // entry, since its attempts counter is the current one, drop only the rounds this
        // pass actually resolved (published, dead-lettered, or dropped as already-sent),
        // and carry everything else through untouched.
        // Built as `remaining` PLUS the mid-pass arrivals, never as a filter over the
        // fresh read alone: _readQueue swallows a read failure as an empty list, and a
        // rebuild derived only from it would then truncate the queue and lose every
        // round this pass meant to retry. This shape is never worse than the old blind
        // rewrite, only strictly more inclusive.
        let seen     = new Set(remaining.map(e => e.round));
        let resolved = new Set(entries.map(e => e.round).filter(r => !seen.has(r)));
        let rebuilt  = remaining.slice();
        for (let e of this._readQueue()) {
            if (resolved.has(e.round) || seen.has(e.round)) continue;
            seen.add(e.round);
            rebuilt.push(e);
        }

        // Dequeue-side rewrite must fail loud, mirroring the enqueue path's "refuse
        // to ack if queue is unwritable" stance. On success the durable queue holds only
        // unresolved rounds (never a published one), so no published round can still be
        // on disk and the dedup guard can be reset to bound its growth. On failure the
        // published rounds remain on the queue file: keep the guard armed (it prevents
        // the re-broadcast) and surface the failure so an operator repairs the queue
        // before a restart drops the in-memory guard.
        let rewritten = this._rewriteQueue(rebuilt);
        if (rewritten) {
            this._publishedRounds.clear();
        } else {
            console.error('OraclePublisher: CRITICAL - queue rewrite failed after publishing; ' +
                'published rounds remain on the durable queue at ' + this.queuePath + '. The in-process ' +
                'dedup guard prevents re-broadcast for this process lifetime, but a restart before the ' +
                'queue file is repaired would re-broadcast already-published rounds (duplicate DOGE spend). ' +
                'Fix the queue file writability now.');
        }

        // Bound the durable marker table. Runs after the rewrite so the queue-floor
        // clamp reads the post-pass queue, and only when a round actually published
        // this pass (nothing new to age out otherwise). Fire-and-forget with the
        // rejection swallowed: retention is housekeeping and must never fail, stall,
        // or retry a broadcast pass that has already spent DOGE.
        if (this.db && publishedThisPass && this.lastPublishedRound !== null) {
            this._retentionSweep = this._prunePublishedRounds(this.lastPublishedRound)
                .catch((e) => {
                    console.warn('OraclePublisher: published-rounds retention sweep failed ' +
                        '(marker table keeps growing until it succeeds): ', e);
                    return 0;
                });
        }
    }

    // Snapshot of the publish rail's health for operator diagnostics. Intended to
    // be surfaced through a JSON-RPC status method (e.g. getoraclepublisherstatus)
    // alongside the sibling publishers' getStats accessors. All fields are cheap,
    // in-memory reads; queueDepth touches the durable queue file.
    getStats() {
        let queueDepth = 0;
        try { queueDepth = this._readQueue().length; } catch (e) { queueDepth = null; }
        let oldestUnconfirmed = this.oldestUnconfirmedPublish();
        return {
            queueDepth:          queueDepth,
            published:           this.publishedCount,
            abandoned:           this.abandonedCount,
            oversizedDrops:      this.oversizedDrops,
            quarantined:         this._quarantinedRounds.size,
            // Marker-table retention: the configured window plus the lifetime prune
            // count, so an operator can tell a bounded table from one whose sweep has
            // been failing (pruned stuck at 0 while rounds keep publishing).
            publishedRoundsRetentionRounds: this.publishedRoundsRetentionRounds,
            publishedRoundsPruned:          this.publishedRoundsPruned,
            lastPublishedRound:  this.lastPublishedRound,
            lastPublishedTxid:   this.lastPublishedTxid,
            lastObservedBalance: this.lastObservedBalance,
            // Landing, not sending. lastPublishedTxid above answers only "what did we
            // broadcast last": these answer whether it reached a block. A non-zero
            // unconfirmedPublishes with an oldestUnconfirmedAgeMs in the hours is a
            // wedged publisher, whatever the rest of this snapshot reports.
            unconfirmedPublishes:    this._pendingConfirmations.size,
            oldestUnconfirmedTxid:   oldestUnconfirmed ? oldestUnconfirmed.txid  : null,
            oldestUnconfirmedRound:  oldestUnconfirmed ? oldestUnconfirmed.round : null,
            oldestUnconfirmedAgeMs:  oldestUnconfirmed ? oldestUnconfirmed.ageMs : null,
            confirmedPublishes:      this.confirmedPublishes,
            confirmationCheckIntervalMs: this.confirmCheckIntervalMs,
            confirmationCheckFailures:   this.confirmationCheckFailures,
            lastConfirmationCheckAt:     this.lastConfirmationCheckAt,
            // Confirmed-UTXO reserve as last read. confirmedUtxos at 0 while
            // unconfirmedUtxos is non-zero is the condition that defers a pass, and
            // noConfirmedUtxoDeferrals counts how often it has.
            confirmedUtxos:          this.lastUtxoReserve ? this.lastUtxoReserve.confirmed   : null,
            unconfirmedUtxos:        this.lastUtxoReserve ? this.lastUtxoReserve.unconfirmed : null,
            noConfirmedUtxoDeferrals: this.noConfirmedUtxoDeferrals,
            lastNoConfirmedUtxoAt:    this.lastNoConfirmedUtxoAt,
            deadLetterPath:      this.deadLetterPath,
            enabled:             this.enabled,
            // Takeover rail: armed only when a failover window is configured AND this
            // hub has proof it would see a leader's batch land. takeoverAttempts
            // climbing while takeoverPublished stays flat means windows are being
            // re-assembled but not reaching chain.
            takeoverFailoverWindowBlocks: this.failoverWindowBlocks,
            takeoverArmed:                this.failoverWindowBlocks > 0 && this._observationProven,
            takeoverPending:              this._takeoverTimers.size,
            takeoverAttempts:             this.takeoverAttempts,
            takeoverPublished:            this.takeoverPublished,
            // takeoverDeferred climbing means armed followers are correctly
            // holding off a window whose leader may have a tx in flight; a value that
            // climbs without takeoverPublished ever moving means leaders are broadcasting
            // batches that never mine, which is a fee/mempool problem, not a hub one.
            takeoverDeferred:             this.takeoverDeferred,
            takeoverAmbiguousCooldownMs:  this.takeoverAmbiguousCooldownMs,
            // Leader-rotation view (item 3218): last finalized round's rank state
            // plus lifetime leader/follower-window counts, so a monitor can tell a
            // healthy-but-never-leader hub from a genuinely idle one and spot a dark
            // peer publisher (this hub's follower count climbs while its leader
            // rounds never land on-chain elsewhere).
            myRank:              this._lastRankState ? this._lastRankState.myRank : null,
            leaderRank:          this._lastRankState ? this._lastRankState.leaderRank : null,
            isLeader:            this._lastRankState ? this._lastRankState.isLeader : null,
            publisherCount:      this._lastRankState ? this._lastRankState.publisherCount : null,
            lastRankRound:       this._lastRankState ? this._lastRankState.round : null,
            leaderRounds:        this._leaderRounds,
            followerRounds:      this._followerRounds,
            // PRICE batch rail (spec section 7). batchUnpublishableCount is the
            // machine-checkable half of the loud ceiling: a non-zero value means a
            // single round plus its signature set no longer fits any wire form, which
            // no split can rescue.
            batchWindowsPublished:   this.batchWindowsPublished,
            lastPublishedWindow:     this.lastPublishedWindow,
            batchSplitCount:         this.batchSplitCount,
            batchUnpublishableCount: this.batchUnpublishableCount,
            // Surfaced from the signing round, so one status call answers "is the rail
            // stalled because nobody will co-sign?" without a second accessor.
            batchSignTimeouts:       this._batchSignTimeouts(),
            batchBufferDepth:        this._buffer.size,
            batchBufferPath:         this.bufferPath,
            batchWindowRounds:       this.batchWindowRounds,
            // The stuck-backlog reading. A closed window still buffered and
            // not yet assembled in this process is a window that attempted and produced
            // no wire; a count that does not fall across sweeps is a federation that
            // cannot agree on content, which no other field here shows.
            batchWindowsAwaitingRetry: this._pendingCatchupWindows().length,
            batchCatchupSweeps:        this.batchCatchupSweeps,
            batchCatchupIntervalMs:    this.batchCatchupIntervalMs,
            // The cadence contract with the fee gate, in one place.
            // batchWorstCaseSnapshotAgeSeconds ABOVE oracleMaxPriceAgeSeconds means
            // native-coin fees go unpriceable between batches, which is invisible in
            // every other field here: the rail reports perfect health while it happens.
            batchWindowRoundsCeiling:         this.batchWindowRoundsCeiling,
            batchCadenceSeconds:              Math.round((this.batchWindowRounds * this.roundIntervalMs) / 1000),
            batchWorstCaseSnapshotAgeSeconds: (() => {
                let ms = worstCaseSnapshotAgeMs(this.batchWindowRounds, {
                    roundIntervalMs:  this.roundIntervalMs,
                    graceMs:          this.batchGraceMs,
                    landingReserveMs: this.batchLandingReserveMs });
                return ms === null ? null : Math.round(ms / 1000);
            })(),
            oracleMaxPriceAgeSeconds: this.oracleMaxPriceAgeMs === null
                ? null : Math.round(this.oracleMaxPriceAgeMs / 1000),
            spendGuard:          this.spendGuard.stats()
        };
    }

    // The signer's own timeout counter, read without constructing a signer: getStats is
    // a cheap diagnostic and must not start a P2P handler as a side effect.
    _batchSignTimeouts() {
        let signer = (this.hub && this.hub.oracleBatchSigner) || this._ownedBatchSigner;
        if (!signer || typeof signer.getStats !== 'function') return 0;
        try {
            let s = signer.getStats();
            return (s && Number.isFinite(Number(s.batchSignTimeouts))) ? Number(s.batchSignTimeouts) : 0;
        } catch (e) {
            return 0;
        }
    }

    // Check DOGE balance and log warnings if below threshold
    // Uses the operator's getBalanceFn if set, otherwise falls back to summing UTXOs from the encoder.
    // Returns the balance (in DOGE) or null if no source is available.
    async _checkBalance() {
        let balance = null;
        if (this.getBalanceFn) {
            try {
                balance = await this.getBalanceFn();
            } catch (err) {
                console.warn('OraclePublisher: custom balance check failed:', err);
                return null;
            }
        } else if (this.encoder && this.dogeAddress) {
            // Default: sum the configured address's UTXOs into a DOGE balance.
            // get_utxos reports each output in satoshis (`value`), and every
            // consumer of this figure is whole-DOGE (lowBalanceThreshold, the
            // fail-closed gate in _processQueue, spendGuard.minBalance, the
            // monitor's dogeBalance alert), so the conversion is not optional.
            // Units and the fallback order: lib/utxo_balance.js.
            try {
                let utxos = await this.encoder.getUtxos(this.dogeAddress);
                if (Array.isArray(utxos)) balance = sumUtxosCoins(utxos);
            } catch (err) {
                console.warn('OraclePublisher: encoder balance check failed:', err);
                return null;
            }
        }

        this.lastObservedBalance = balance;
        if (balance !== null && balance !== undefined) {
            if (balance < this.lowBalanceThreshold) {
                // Estimate rounds remaining at typical fee rate (~0.003 DOGE per tx)
                let est = Math.floor(balance / 0.003);
                console.warn('OraclePublisher: DOGE balance LOW (' + balance.toFixed(4) + ' DOGE, ~' + est + ' rounds remaining)');
            }
        }
        return balance;
    }
}

module.exports = OraclePublisher;
