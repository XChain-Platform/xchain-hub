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
 * XChain Hub - Oracle Consensus
 *
 * PBFT-like consensus for price oracle rounds. After the submission
 * window closes, the round leader aggregates prices using a trimmed
 * median, proposes the result, and validators vote to finalize it.
 *
 * Flow: ORACLE_PROPOSE -> ORACLE_PREPARE (2f+1) -> ORACLE_COMMIT (2f+1) -> store snapshot
 *
 * Single-node fast path: when quorum === 0 (only one oracle_publish validator),
 * the snapshot is stored immediately without any PROPOSE/PREPARE/COMMIT exchange.
 *
 ********************************************************************/

const crypto            = require('crypto');
const EventEmitter      = require('events');
const PriceFetcher      = require('./PriceFetcher.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD, ORACLE_MAX_CHANGE_PER_ROUND,
        XCHAIN_PRICE_MAX_CHANGE_PER_ROUND, DERIVED_PAIRS } = require('./constants.js');
const swq               = require('./stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { positiveIntConfig } = require('./lib/config_int.js');
const eq                = require('./equivocation_header.js');
const bcmath            = require('./bcmath.js');
const devband           = require('./lib/deviation_band.js');
const { isAdmissibleSigner, provenPubkey } = require('./lib/chain_signer_admission.js');
const { canonicalValidatorOrder } = require('./validator_order.js');
const snapWrite         = require('./lib/capability_snapshot_write.js');
const { noteDrop } = require('./consensusDiagnostics');

const ORACLE_PROPOSE = 'ORACLE_PROPOSE';
const ORACLE_PREPARE = 'ORACLE_PREPARE';
const ORACLE_COMMIT  = 'ORACLE_COMMIT';

const TRIM_PERCENT = 0.15;  // Discard top and bottom 15% of submissions
const DEFAULT_FINALIZATION_TIMEOUT = 120000; // 2 minutes
const FALLBACK_GRACE_MS = 3000;  // brief grace before fallback proposer takes over
// Leader-timeout: a leader can gossip (and have peers record) its submission and
// then crash before broadcasting ORACLE_PROPOSE. Followers would otherwise wait
// out the full finalization window. After this shorter grace with no PROPOSE, the
// lowest-addr submitter OTHER THAN the (presumed-dead) leader takes over as
// fallback proposer, salvaging the round's pricing data. Measured from the moment
// the round becomes ready to finalize (block-driven, so every hub uses the same
// window); receivers apply the same grace before accepting such a fallback PROPOSE.
const DEFAULT_LEADER_TIMEOUT_MS = 30000;  // 30 seconds (< finalization window)

// Slack the round-abandonment watchdog adds on top of the round's own
// timer ladder before it declares the round lost and writes the durable skipped
// record. Wide enough that a round finishing at the very edge of its finalization
// window (or one re-opened by a PROPOSE that landed late) still wins the race and
// disarms the watchdog, narrow enough that the record lands long before the next
// round's boundary (rounds are ~10 minutes apart).
const DEFAULT_ROUND_ABANDON_GRACE_MS = 15000;
// Follower freshness bound on the leader-supplied btcBlockHeight in a PROPOSE.
// Same family and default as StateCheckpointEngine.cosignToleranceBlocks and
// CrossChainCallEngine's snapshot_block bound: about a day of BTC blocks.
const DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS = 144;
// How many times the watchdog defers to a still-live pending round before writing
// the skipped record anyway. Each deferral is one more finalization window, so a
// round stuck behind the _armFinalizeRetry DB-outage self-heal gets a bounded
// chance to land its snapshot first. Bounded, because the point of the watchdog is
// that SOMETHING durable is written: an unbounded deferral is the silence it exists
// to end (a later quorum still upgrades the skipped rows to finalized).
const ROUND_ABANDON_MAX_REARMS = 3;

// Backoff for the self-heal re-drive of a committed round whose snapshot store keeps
// failing (item 4281, see _armFinalizeRetry). Starts fast because most DB stalls are
// brief, caps low enough that a recovered DB is picked up within half a minute.
const FINALIZE_RETRY_BASE_MS = 1000;
const FINALIZE_RETRY_MAX_MS  = 30000;

// Per-pair override for the aggregation move clamp (D4). Most pairs track
// deep external markets and share ORACLE_MAX_CHANGE_PER_ROUND; XCHAIN/USD is
// derived from a thin on-platform market and gets a tighter bound.
//
// CONSENSUS-CRITICAL and federation-uniform: two hubs on different values clamp the
// same aggregate to different prices, so they publish different finalized rows and
// the disagreeing one walks into deviation slashing. A retune is a coordinated
// flag-day (§8), never a rolling deploy.
//
// Keyed off DERIVED_PAIRS[0] rather than a second 'XCHAIN/USD' literal, so the pair
// name has exactly one spelling in this repo and a rename cannot silently leave the
// override attached to a pair that no longer exists.
const MAX_CHANGE_PER_ROUND_BY_PAIR = {
    [DERIVED_PAIRS[0]]: XCHAIN_PRICE_MAX_CHANGE_PER_ROUND,
};

// The per-round move bound in force for `coinPair`. Unknown pairs get the global
// default, so a new pair is never accidentally unclamped.
function maxChangeForPair(coinPair) {
    let pct = MAX_CHANGE_PER_ROUND_BY_PAIR[coinPair];
    return (typeof pct === 'number' && Number.isFinite(pct) && pct > 0)
        ? pct : ORACLE_MAX_CHANGE_PER_ROUND;
}

class OracleConsensus extends EventEmitter {

    constructor(hub, oracleRound) {
        super();
        this.hub         = hub;
        this.oracleRound = oracleRound;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Pending rounds: Map<round, { prices, digest, prepares: Set, commits: Set, finalized: bool, timer }>
        this.pendingRounds = new Map();

        // Rounds evicted on finalization timeout (leader and follower seats alike),
        // mirroring StateCheckpointEngine._roundTimeouts. Exposed as round_timeouts
        // through OracleRound.getSubmissionsInfo (the getoraclesubmissions RPC) so
        // the dashboard can alert on quorum-loss frequency (reviews 1468/1469).
        this._roundTimeouts = 0;

        // Rounds finalized with single-source corroboration on a normally-multi-source
        // pair, plus the last such round. Same shape and the same reason as
        // _roundTimeouts above: the diversity collapse is computed at finalization and
        // was then only console.warn'd, so a federation publishing PRICE v0 off one
        // upstream left no trace any dashboard rail could read. Exposed as
        // single_source_rounds / lastSingleSourceRound through
        // OracleRound.getSubmissionsInfo, and as xchain_oracle_single_source_rounds_total
        // on the metrics surface.
        this._singleSourceRounds    = 0;
        this._lastSingleSourceRound = null;

        // Rounds this hub watched open and then recorded as abandoned,
        // same counter convention as _roundTimeouts. Distinct from it: a timeout
        // counts only the two PBFT seats that held a pending round, while the
        // follower seat that never got a PROPOSE at all left no trace anywhere.
        // Surfaced as abandoned_rounds through OracleRound.getSubmissionsInfo, so
        // "this hub keeps losing rounds" is legible without a DB query.
        this._abandonedRounds    = 0;
        this._lastAbandonedRound = null;

        // When each round became ready to finalize (Date.now() at finalizeRound's
        // follower path). The receiver-side leader-timeout grace in _handlePropose
        // is measured from here so every honest hub applies the same window before
        // accepting a leader-timeout fallback PROPOSE. Pruned when a round
        // finalizes/skips. Map<round, msEpoch>.
        this.roundReadyAt = new Map();

        // Armed leader-timeout timers, keyed by round, so they can be cleared on
        // stop() or once the round is taken. Only the elected fallback proposer
        // arms one. Map<round, Timeout>.
        this.leaderTimers = new Map();

        // Armed round-abandonment watchdogs, keyed by round.
        // Map<round, { timer, btcBlockHeight, btcBlockTime, rearms }>.
        //
        // EVERY seat that observes a round open arms one, so a round that dies
        // between opening and finalizing still becomes a durable 'skipped' record
        // HERE rather than only on whichever hub happened to take one of the
        // early store-skipped branches in finalizeRound. Before this, the
        // follower seats (leader submitted, someone else is the elected fallback)
        // and both PBFT timeout seats returned in silence, so testnet rounds
        // 25-27 finalized nowhere and left a row on exactly one of five
        // validators: the federation could not even agree the rounds happened.
        this.roundWatchdogs = new Map();

        // Already finalized rounds (prevents double-store), bounded FIFO (L1):
        // this set only ever grew (~1 entry per round), leaking for the process
        // lifetime. Cap it with an insertion-order ring; rounds finalize in
        // roughly ascending order so the oldest evicted round is far below the
        // live round and will never be re-proposed.
        this.finalized = new Set();
        this._finalizedOrder = [];
        this.finalizedMax = positiveIntConfig(process.env.ORACLE_FINALIZED_MAX, 10000, 'ORACLE_FINALIZED_MAX');

        // Rounds this hub stored as 'skipped' for a LOCAL reason (its gossip lagged
        // below minSubmissions at the block boundary, or its own aggregate was
        // empty), NOT because the whole federation skipped (stress-sweep #7). These
        // are kept separate from `finalized` so a legitimate later PROPOSE from the
        // federation still processes: without this, a locally-skipped round landed
        // in `finalized`, _handlePropose dropped the real PROPOSE, and _handlePrepare
        // /_handleCommit refused to buffer, so the hub permanently held a NULL
        // price_snapshot for a round the rest of the federation finalized. When the
        // round does reach commit quorum here, _storeSnapshot's ON DUPLICATE KEY
        // UPDATE upgrades the 'skipped' rows to 'finalized' and _markFinalized moves
        // the round out of this set. Bounded by the same insertion-order ring as
        // `finalized` (round is not attacker-chosen here -- only this hub's own
        // finalizeRound writes it -- but the ring keeps it from growing for the
        // process lifetime).
        this.locallySkipped = new Set();
        this._locallySkippedOrder = [];

        // Early-arrival buffer (finding F7). A PREPARE/COMMIT can land while
        // _handlePropose is still awaiting the block-boundary snapshot, or
        // before the PROPOSE itself arrives. The whole PBFT burst completes in
        // well under a second, so dropping those messages makes this hub miss
        // the round (the federation still finalizes without it, leaving a
        // silent hole in this hub's price_snapshots). Buffer by round and
        // drain once pendingRounds is populated. Mirrors
        // AttestationConsensus.earlyMessages.
        this.earlyMessages        = new Map();   // round -> [envelope]
        this.earlyMessageTtl      = new Map();   // round -> expiresAt (ms)
        this.earlyMessageTtlMs    = 60 * 1000;
        this.earlyMessageMaxPerRound = 64;
        // Cap the number of DISTINCT round keys held at once. `round` is taken from
        // attacker-controlled envelope.data, so without this a single Byzantine
        // validator streaming PREPAREs with millions of fresh round numbers inside
        // the 60s TTL grows earlyMessages without bound (memory DoS) and makes every
        // _pruneEarlyMessages an O(rounds) scan (O(n^2) CPU). Map preserves insertion
        // order, so eviction is FIFO on the oldest round key. 256 >> any legitimate
        // in-flight round concurrency (rounds are ~10 min apart).
        // positiveIntConfig, not `parseInt(env) || 256`, and here it is a HANG, not a
        // loosened cap: the eviction below is a `while (size >= max)` loop, so a negative
        // value keeps the condition true at size 0, where `keys().next().value` is
        // undefined and `delete(undefined)` changes nothing. The loop never terminates and
        // wedges the event loop for the whole hub process on the first buffered message.
        this.earlyMessageMaxRounds = positiveIntConfig(process.env.ORACLE_EARLY_MSG_MAX_ROUNDS, 256,
            'ORACLE_EARLY_MSG_MAX_ROUNDS');

        this.validatorSet = [];

        this._messageHandler = null;

        this.finalizationTimeout = parseInt(process.env.ORACLE_FINALIZATION_TIMEOUT) || DEFAULT_FINALIZATION_TIMEOUT;
        // Default to a 2-hub diversity floor: a single hub's single external source must never
        // become a federation-signed price. A real federation always clears 2; single-host / regtest
        // deployments set ORACLE_MIN_SUBMISSIONS=1 explicitly.
        //
        // positiveIntConfig, not `parseInt(env) || 2`: a NEGATIVE value is truthy, so it would
        // pass straight through and make the `submissions.size < this.minSubmissions` floor checks
        // permanently false, removing the floor rather than lowering it. Non-positive and
        // unparseable values now fall back to 2.
        this.minSubmissions      = positiveIntConfig(process.env.ORACLE_MIN_SUBMISSIONS, 2, 'ORACLE_MIN_SUBMISSIONS');
        // Unlike ORACLE_ALLOW_UNVERIFIED_PAIRS below, this knob is NOT regtest-gated: single-host
        // PROD is a supported deployment (xchain-node ConfigService passes the key through, and
        // HubConsensusEnvGuard refuses a container regenerate that drops it) and ignoring the
        // override there would skip every round and stall every indexer's price-sync barrier.
        // What the hatch must not be is SILENT, so a sub-floor setting announces itself on any
        // network that is not regtest, naming the defense it stands down.
        if (this.minSubmissions < 2 && !(this.hub && this.hub.network === 'regtest')) {
            console.log('WARNING: ORACLE_MIN_SUBMISSIONS=' + this.minSubmissions + ' on ' +
                (((this.hub && this.hub.network) || '<unset>')) + '; the 2-hub price diversity floor ' +
                'is STOOD DOWN on this hub, so one submitter can carry a federation-signed round. ' +
                'Intended only for a deliberate single-host deployment.');
        }
        this.leaderTimeout       = parseInt(process.env.ORACLE_LEADER_TIMEOUT_MS) || DEFAULT_LEADER_TIMEOUT_MS;
        // Follower freshness bound on the leader-supplied btcBlockHeight in a
        // PROPOSE. That height selects the price snapshot (quorum N), the member set
        // the round's leader is elected from, and the STAKE_WEIGHTED_QUORUM
        // activation outcome, and it is a wire field the proposer chose. Same family
        // and default as StateCheckpointEngine.cosignToleranceBlocks and
        // CrossChainCallEngine's snapshot_block bound: about a day of BTC blocks, so
        // honest tip skew between hubs costs a round nothing. 0 is meaningful (pin to
        // our own tip exactly), hence the non-negative guard rather than `|| default`.
        this.snapshotToleranceBlocks = parseInt(process.env.ORACLE_SNAPSHOT_TOLERANCE_BLOCKS
            || String(DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS));
        if (!(this.snapshotToleranceBlocks >= 0))
            this.snapshotToleranceBlocks = DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS;
        // Extra slack on top of the round's own timer ladder before the
        // abandonment watchdog declares the round lost. Additive only:
        // _roundAbandonMs() derives the window from the ladder, so a deployment
        // that widens ORACLE_FINALIZATION_TIMEOUT widens the watchdog with it and
        // this knob never has to be retuned alongside it.
        this.roundAbandonGraceMs = positiveIntConfig(process.env.ORACLE_ROUND_ABANDON_GRACE_MS,
            DEFAULT_ROUND_ABANDON_GRACE_MS, 'ORACLE_ROUND_ABANDON_GRACE_MS');
        // A proposed pair this follower can verify against NOTHING (no live
        // local aggregate AND no finalized history) used to fall through with only
        // the (0, PRICE_MAX) clamp, letting a Byzantine leader who is the sole
        // submitter for a brand-new pair get any value up to PRICE_MAX co-signed.
        // Default is fail closed: withhold co-sign on unverifiable pairs, so
        // finalization requires at least one follower that priced the pair itself.
        // Escape hatch for deliberate single-host / bootstrap deployments where no
        // second fetcher exists (regtest, ORACLE_MIN_SUBMISSIONS=1 setups).
        //
        // Network-gated, same rule as the other regtest-only seams (StateCheckpointEngine's
        // XDEX_SNAPSHOT_BLOCK / XDEX_SEED_LOCAL_VALIDATOR, coins/index.js
        // resolveFeeDestination): honored ONLY on regtest, set-but-IGNORED and warned
        // everywhere else. A mainnet/testnet federation always has a second fetcher, so the
        // hatch has no legitimate use there, and a stray env var must never disarm a
        // Byzantine-leader defense in silence. hub.network is the api.js-validated
        // HUB_NETWORK (mainnet|testnet|regtest, required in validator mode, and this engine
        // only ever starts in validator mode); anything else, '' included, fails closed.
        let allowUnverifiedEnv = String(process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS || '') === 'true';
        let isRegtest          = !!(this.hub && this.hub.network === 'regtest');
        if (allowUnverifiedEnv && !isRegtest) {
            console.log('WARNING: ORACLE_ALLOW_UNVERIFIED_PAIRS is set but IGNORED on ' +
                (((this.hub && this.hub.network) || '<unset>')) + '; unverifiable-pair co-sign ' +
                'stays fail-closed. This hatch is honored only on regtest single-host bring-up.');
        }
        this.allowUnverifiedPairs = allowUnverifiedEnv && isRegtest;
    }

    // Canonicalize the set's ORDER on the way in, so _getLeader's
    // legacy live-set path (`validatorSet[round % N]`, taken whenever a round
    // has no usable block-locked snapshot) elects the same leader on every hub
    // for identical membership. The snapshot path was already fixed by
    // sorting the member pubkeys; this closes the same hole on the fallback.
    // See validator_order.js.
    setValidatorSet(validators) {
        this.validatorSet = canonicalValidatorOrder(validators);
    }

    async start() {
        // Seed the in-memory last-finalized-price cache from price_snapshots so a
        // cold-started hub applies the same historical-deviation co-sign band a
        // warm hub does (seq 4382). Without this, _getLastFinalizedPrice returns
        // null on every pair until the hub itself stores a round, so a freshly
        // restarted hub would co-sign a Byzantine price for any pair it does not
        // locally submit that a long-running hub would withhold on. Local accept-
        // gate only: no signed bytes change, no reindex.
        await this._seedLastFinalizedPrices();

        // Re-run the seed on a timer so the clamp reference tracks the DATABASE, not
        // this process's own finalize history (item 5834). The cache had exactly two
        // writers, the start-time seed and _storeSnapshot, so every round this hub sat
        // out (co-sign reject before pendingRounds.set, commit-quorum timeout eviction,
        // a below-minSubmissions skip) left it clamping against an ever-older reference
        // while its peers moved on. The seed is idempotent, fail-soft and monotonic, so
        // re-running it can only carry the reference FORWARD to rows this hub already
        // holds. It bounds the staleness window rather than closing it: a round-aligned
        // re-read on the consensus path is a separate, deliberate change.
        // Cadence only, NOT a federation-uniform value: it decides how promptly a hub
        // catches up to rows it already holds, never what any hub clamps to. A longer
        // interval degrades toward the pre-fix staleness, a shorter one costs one
        // indexed query. So it needs no flag day and no regtest-only gate.
        this._reseedIntervalMs = positiveIntConfig(process.env.ORACLE_CLAMP_RESEED_MS, 60000,
            'ORACLE_CLAMP_RESEED_MS');
        this._reseedTimer = setInterval(() => {
            // In-flight guard, the convention XChainHub._refreshTransportSignerSet uses:
            // the query is an unbounded round trip and a bare setInterval stacks passes.
            if (this._reseedRunning) return;
            this._reseedRunning = true;
            this._seedLastFinalizedPrices({ quiet: true })
                .catch(() => { /* _seedLastFinalizedPrices never rejects; belt and braces */ })
                .then(() => { this._reseedRunning = false; });
        }, this._reseedIntervalMs);
        if (this._reseedTimer.unref) this._reseedTimer.unref();

        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        console.log('Oracle consensus engine started');
    }

    // Populate _lastFinalizedPrices with the most-recently-finalized price per
    // coin_pair from price_snapshots. Mirrors the cache keying in
    // _updateLastFinalizedPrices (key = coin_pair, value = price string) and the
    // "latest finalized = highest round_number" ordering used by hub.getPrice().
    // Fail-soft: an empty table or a query error leaves the cache empty (the prior
    // cold-start behavior), so this can never block hub startup.
    async _seedLastFinalizedPrices(opts) {
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        try {
            // One row per coin_pair: the price from that pair's highest finalized
            // round. The subquery picks the max finalized round per pair, then the
            // join reads that round's price for the pair. round_number rides along so
            // the entry can be stamped and the merge below can stay monotonic.
            let rows = await this.db.doQuery(
                "SELECT p.coin_pair AS coin_pair, p.price AS price, p.round_number AS round_number " +
                "FROM price_snapshots p " +
                "JOIN (SELECT coin_pair, MAX(round_number) AS mx FROM price_snapshots " +
                "      WHERE status = 'finalized' AND price IS NOT NULL GROUP BY coin_pair) m " +
                "  ON p.coin_pair = m.coin_pair AND p.round_number = m.mx " +
                "WHERE p.status = 'finalized' AND p.price IS NOT NULL", []);
            let seeded = 0;
            for (let r of (rows || [])) {
                if (r.coin_pair && r.price !== null && r.price !== undefined) {
                    // Merge, never replace the map: a truncated or partial read must not
                    // drop a pair's reference, since an absent reference means NO clamp
                    // at all and an unbounded aggregate is worse than a stale bound.
                    if (this._noteFinalizedPrice(r.coin_pair, r.price, r.round_number)) seeded++;
                }
            }
            if (seeded > 0 && !(opts && opts.quiet))
                console.log('Oracle: seeded last-finalized-price cache with ' + seeded + ' pair(s) from price_snapshots');
        } catch (e) {
            console.warn('Oracle: could not seed last-finalized-price cache (continuing with empty cache):',
                e && e.message ? e.message : e);
        }
    }

    async stop() {
        if (this._reseedTimer) {
            clearInterval(this._reseedTimer);
            this._reseedTimer = null;
        }
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for (let [round, pending] of this.pendingRounds) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        for (let [, t] of this.leaderTimers) clearTimeout(t);
        this.leaderTimers.clear();
        for (let [, w] of this.roundWatchdogs) { if (w && w.timer) clearTimeout(w.timer); }
        this.roundWatchdogs.clear();
        this.pendingRounds.clear();
        this.roundReadyAt.clear();
        this.earlyMessages.clear();
        this.earlyMessageTtl.clear();
    }

    // --- Early-message buffering (finding F7) ---

    _pruneEarlyMessages(now) {
        for (let [round, expiresAt] of this.earlyMessageTtl) {
            if (expiresAt <= now) {
                // A healthy round drains its buffer, so anything still parked
                // here at expiry is a round that never assembled: the vote is
                // gone and this is the only place that says so.
                let lost = this.earlyMessages.get(round);
                noteDrop({ reason: 'early_ttl', phase: 'buffer', round, count: lost ? lost.length : 0 });
                this.earlyMessages.delete(round);
                this.earlyMessageTtl.delete(round);
            }
        }
    }

    // Hold a PREPARE/COMMIT that arrived before this hub's pendingRounds entry
    // exists for the round. Replayed by _drainEarlyMessages once it does.
    _bufferEarlyMessage(round, envelope) {
        let now = Date.now();
        this._pruneEarlyMessages(now);
        let arr = this.earlyMessages.get(round);
        if (!arr) {
            // Bound the number of distinct buffered rounds (attacker picks `round`).
            // Map iteration is insertion-ordered, so evict the OLDEST round key first.
            while (this.earlyMessages.size >= this.earlyMessageMaxRounds) {
                let oldest = this.earlyMessages.keys().next().value;
                let lost = this.earlyMessages.get(oldest);
                noteDrop({ reason: 'early_capacity', phase: 'buffer', round: oldest, count: lost ? lost.length : 0, evicted_for: round });
                this.earlyMessages.delete(oldest);
                this.earlyMessageTtl.delete(oldest);
            }
            arr = [];
            this.earlyMessages.set(round, arr);
        }
        if (arr.length >= this.earlyMessageMaxPerRound) {
            noteDrop({ reason: 'early_capacity', phase: 'buffer', round, sender: envelope && envelope.sender, envelope });
            return;
        }
        arr.push(envelope);
        this.earlyMessageTtl.set(round, now + this.earlyMessageTtlMs);
    }

    // Replay buffered envelopes through the normal dispatch path. Called from
    // both pendingRounds.set sites (proposer + follower). Deletes the queue
    // up-front so replayed messages can't re-buffer.
    _drainEarlyMessages(round) {
        let arr = this.earlyMessages.get(round);
        if (!arr) return;
        this.earlyMessages.delete(round);
        this.earlyMessageTtl.delete(round);
        for (let env of arr) {
            try { this._handleMessage(env); }
            catch (e) { console.error('Oracle: error replaying buffered message for round %s:', round, e.message); }
        }
    }

    // Record a finalized round under the bounded FIFO ring (L1). Evicts the
    // oldest round once the window is full so `finalized` cannot grow unbounded
    // over the process lifetime.
    _markFinalized(round) {
        // A round that genuinely finalizes supersedes any local skip marker for it
        // (the 'skipped' price_snapshots rows were upgraded to 'finalized' by
        // _storeSnapshot), so clear it from locallySkipped (stress-sweep #7).
        if (this.locallySkipped.delete(round)) {
            let i = this._locallySkippedOrder.indexOf(round);
            if (i !== -1) this._locallySkippedOrder.splice(i, 1);
        }
        if (this.finalized.has(round)) return;
        // The round reached a durable outcome, so the abandonment watchdog has
        // nothing left to record. Disarmed here as well as in
        // _clearRoundTracking, because the single-node finalize path never calls
        // that.
        this._disarmRoundWatchdog(round);
        this.finalized.add(round);
        this._finalizedOrder.push(round);
        if (this._finalizedOrder.length > this.finalizedMax) {
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
        }
    }

    // Record a round this hub stored as 'skipped' for a local reason (stress-sweep
    // #7). Unlike _markFinalized this does NOT block a later federation PROPOSE from
    // processing; it only prevents this hub from re-skipping the same round and lets
    // getSubmissionsInfo/health distinguish a local skip from a true finalize.
    // Bounded by the same insertion-order ring as `finalized`.
    _markLocallySkipped(round) {
        if (this.finalized.has(round) || this.locallySkipped.has(round)) return;
        this.locallySkipped.add(round);
        this._locallySkippedOrder.push(round);
        if (this._locallySkippedOrder.length > this.finalizedMax) {
            let oldest = this._locallySkippedOrder.shift();
            this.locallySkipped.delete(oldest);
        }
        // Announce the durable skip, mirroring 'round:finalized'. This is the only
        // place a round becomes a non-finalized row in price_snapshots, and the guard
        // above makes it exactly-once per round, so it is the event that carries the
        // same semantic _hydrateFreshnessCounters rebuilds from the durable record
        // (item 4942). Emitted after the state change so a listener observing back
        // through getSubmissionsInfo sees the round already marked.
        this.emit('round:skipped', { round: round });
    }

    // Minimum per-pair provider count observed across all of a round's submissions
    // (Infinity when no submission carries a per-pair `sources` count). A result of
    // <= 1 means at least one pair finalized this round with single-source (and thus
    // correlated, outlier-rejection-defeating) corroboration somewhere in the set.
    //
    // `capablePairs` (optional Set of coinPairs) restricts the scan to pairs that can
    // normally reach >=2 sources, so CoinGecko-only-by-design pairs (BTC/MXN, etc.,
    // which Kraken does not list) do not pin the minimum to 1 every healthy round.
    // Omitted -> no filtering (legacy behavior; relied on by unit tests).
    _minRoundSources(submissions, capablePairs) {
        let min = Infinity;
        if (!submissions) return min;
        for (let sub of submissions.values()) {
            if (sub && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (capablePairs && p && !capablePairs.has(p.coinPair)) continue;
                    let n = Number(p && p.sources);
                    if (Number.isFinite(n)) min = Math.min(min, n);
                }
            }
        }
        return min;
    }

    // Finalize a round. Called by OracleRound after the submission window closes.
    // btcBlockHeight and btcBlockTime are the BTC chain tip at the time the round was
    // triggered (used for the on-chain PRICE v0 anchor).
    //
    // If we're the deterministic leader, propose immediately. If we're a follower
    // and the leader is missing from submissions (e.g. its CoinGecko fetch failed),
    // the hub with the lowest addr (lex) among submitters takes over as fallback
    // proposer after a brief grace period, salvaging rounds where the leader has
    // no prices but other hubs do.
    async finalizeRound(round, btcBlockHeight, btcBlockTime) {
        if (this.finalized.has(round)) return;

        // Default to round number if BTC tip is unavailable (early bootstrap)
        btcBlockHeight = btcBlockHeight || round;
        btcBlockTime   = btcBlockTime   || Math.floor(Date.now() / 1000);

        let submissions = this.oracleRound.getSubmissions(round);
        if (!submissions || submissions.size === 0) {
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'no submissions');
            return;
        }

        if (submissions.size < this.minSubmissions) {
            console.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
                ' submission(s); minimum is ' + this.minSubmissions + ', skipping');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'below minimum submissions threshold');
            return;
        }

        // Source-diversity health signal (non-blocking). finalizeRound gates on hub
        // COUNT, never on per-submission source diversity, so a federation-wide
        // degradation to a single upstream (e.g. Kraken down everywhere, only
        // CoinGecko answering) finalizes and is PBFT-signed exactly as if it had the
        // "2 uncorrelated sources" corroboration the oracle is designed around. The
        // only prior signal was a per-hub PriceFetcher console.warn; this one is
        // federation-scoped (it sees every collected submission's per-pair count),
        // so it actually reflects whether the ROUND, not just this hub, lost its
        // second source. Surface it rather than letting the round pass silently; the
        // round still finalizes (no liveness change).
        //
        // Scope the scan to pairs that can normally reach >=2 sources. Pairs that are
        // CoinGecko-only by design (Kraken lists no MXN/CNY/BRL/INR/KRW, etc.) report
        // sources=1 in every healthy round, so without this filter the global minimum
        // is ~always 1 and the warn cries wolf on every finalization, training
        // operators to ignore the very signal that should flag a real degradation.
        let capablePairs   = this.oracleRound && this.oracleRound.priceFetcher
            ? this.oracleRound.priceFetcher.multiSourceCapablePairs() : null;
        let minRoundSources = this._minRoundSources(submissions, capablePairs);
        if (Number.isFinite(minRoundSources) && minRoundSources <= 1) {
            // Count it as well as logging it. The warn reaches one hub's stdout, which is
            // below every threshold the dashboard can act on, so a fleet-wide loss of the
            // second upstream was observable only to whoever was tailing that hub.
            // Counting only, never gating: the round's outcome is unchanged.
            this._singleSourceRounds++;
            this._lastSingleSourceRound = round;
            console.warn('Oracle: Round ' + round + ' finalizing with single-source corroboration ' +
                'on a normally-multi-source pair (minimum source count across the ' + submissions.size +
                ' submissions, restricted to multi-source-capable pairs = ' + minRoundSources +
                '); the federation lost its second uncorrelated price source this round. PRICE v0 is ' +
                'still quorum-signed but its outlier-rejection resilience is gone.');
        }

        // Lock the validator-set snapshot at the round's block boundary so
        // every hub computes the same quorum for this round, even when stake
        // state drifts mid-round. Spec: capability-staking-model.md §6.
        // Falls back to the live validator-set count when the indexer is
        // unreachable (graceful degradation; same behavior as before the
        // snapshot wiring landed).
        // STAKE_WEIGHTED_QUORUM: at/above the activation snapshot_block, finalize on
        // summed signer STAKE (>2/3 of S, source-deduped) rather than signer COUNT.
        // Gated on the round's BTC block boundary + the hub's network so the hub and
        // every indexer flip on the same anchor. When weighted, lock the source-keyed
        // weight snapshot; below activation, byte-for-byte the legacy count snapshot.
        let weighted = swq.isStakeWeightedQuorumActive(btcBlockHeight, this.hub.network);
        let snapshot = this.hub.capabilitySnapshot
            ? (weighted
                ? await this.hub.capabilitySnapshot.getWeightSnapshot('price', btcBlockHeight)
                : await this.hub.capabilitySnapshot.getSnapshot('price', btcBlockHeight))
            : null;

        // Fix (seq 4118): when weighted mode is active but the snapshot is absent or
        // carries no validators, fall back to count mode for this round rather than
        // entering PBFT with validators=[] and weighted=true. An empty weighted round
        // can never finalize (swq.meetsStakeThreshold([], signers) is always false)
        // and silently stalls for the full finalization timeout without storing a
        // skipped-round record. Falling back to count mode degrades gracefully and
        // keeps the round from stalling.
        if (weighted && (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)) {
            // Federation-split guard (fail closed), mirroring Consensus.js's posture
            // before its identical weighted->count flip. swq.isStakeWeightedQuorumActive
            // is a pure function of (block, network) that every honest hub computes
            // identically, so downgrading to a count quorum on THIS hub's weight-snapshot
            // reachability forks the finalization THRESHOLD semantics: peers finalize on
            // summed stake while this hub finalizes/stalls on a count quorum over the same
            // N validators. In a real federation, skip the round rather than diverge.
            // A single-node / regtest hub (no peers, _getQuorum()===0) has no peer to
            // split from, so it keeps the graceful count fallback below.
            if (this._getQuorum() > 0) {
                console.warn('Oracle: Round ' + round + ' weighted mode active but weight snapshot ' +
                    'unavailable while federated; skipping rather than downgrading to a count quorum ' +
                    'this hub\'s peers are not using.');
                await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                    'weighted quorum active but weight snapshot unavailable');
                return;
            }
            console.warn('Oracle: Round ' + round + ' weighted mode active but snapshot has no validators; falling back to count-based quorum');
            weighted = false;
            snapshot = this.hub.capabilitySnapshot
                ? await this.hub.capabilitySnapshot.getSnapshot('price', btcBlockHeight)
                : null;
        }

        // A federation whose price-qualifying set is empty at this block must skip
        // the round, not self-finalize it: getQuorum(empty)=0 would otherwise take
        // the single-node bypass below and publish a one-signature PRICE v0 the
        // indexer's stake gate rejects (see _isEmptyFederationSnapshot). Genuine
        // single-node / regtest bootstrap (no federation) is unaffected and still
        // self-finalizes via the quorum===0 path.
        if (this._isEmptyFederationSnapshot(snapshot)) {
            console.warn('Oracle: Round ' + round + ' qualified ZERO price validators at block ' +
                btcBlockHeight + ' while this hub is federated; skipping rather than self-finalizing a ' +
                'single-signature round the indexer stake gate would reject.');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'empty qualifying validator snapshot');
            return;
        }

        // Oracle M1: everything below (aggregation, minSubmissions floor, leader/
        // fallback election) must only see submissions from snapshot MEMBERS, one
        // per verified pubkey. Quorum is sized from the snapshot; letting any
        // merely-registered validator's submission through hands a no-stake key a
        // vote in the trimmed median every hub then co-signs. Null snapshot keeps
        // the unfiltered legacy map (graceful degradation, same as the quorum
        // fallback below).
        let memberPubkeys = this._memberPubkeySet(snapshot);
        submissions = this._filterSubmissionsToSnapshot(submissions, memberPubkeys);
        if (!submissions || submissions.size === 0) {
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                'no submissions from snapshot members');
            return;
        }
        if (submissions.size < this.minSubmissions) {
            console.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
                ' snapshot-member submission(s); minimum is ' + this.minSubmissions + ', skipping');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                'below minimum member submissions threshold');
            return;
        }

        let quorum = snapshot
            ? this.hub.capabilitySnapshot.getQuorum(snapshot)
            : this._getQuorum();
        if (quorum === 0) {
            let aggregated = this._aggregateAll(submissions);
            // Mirror the federated _proposeRound guard: _aggregateAll can
            // legitimately return [] while submissions exist (every pair dropped
            // by the price clamp or the 2-source deviation gate). Without this,
            // _storeSnapshot early-returns on empty prices (no finalized AND no
            // skipped row - a silent drop), yet _markFinalized still resets the
            // stall gauges and round:finalized still emits an empty-pair PRICE v0
            // on-chain. Store a durable skipped-round row and stop instead.
            if (aggregated.length === 0) {
                await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'aggregation yielded no prices');
                return;
            }
            // Sign locally and embed in the proof so the publisher can include the sig in PRICE v0
            let mySig = this._signPriceV0(round, btcBlockTime, aggregated, btcBlockHeight);
            let sigsArray = mySig ? [{ pubkey: mySig.pubkey, sig: mySig.sig }] : [];
            await this._storeSnapshot(round, aggregated, 1, JSON.stringify(sigsArray), btcBlockHeight, btcBlockTime);
            // Mark the round finalized so the guard at the top of finalizeRound()
            // dedupes any subsequent call for this round (prevents a duplicate
            // snapshot store / PRICE v0 broadcast).
            this._markFinalized(round);
            // participants are SIGNING KEYS (see the federated emit below), so the
            // reward/slash path can pay a chain-attributed validator that the local
            // registry has no row for.
            let selfPk = this._selfPubkey();
            this.emit('round:finalized', {
                round:          round,
                btcBlockHeight: btcBlockHeight,
                btcBlockTime:   btcBlockTime,
                prices:         aggregated,
                participants:   selfPk ? [selfPk] : [],
                signatures:     sigsArray,
                submissions:    submissions
            });
            return;
        }

        // Past every early-skip branch: this hub has a usable submission set and a
        // quorum for the round, so from here the round is OPEN here whatever seat
        // this hub takes (leader, elected fallback, or a follower that only waits).
        // Arm the abandonment watchdog before the seat split so all three leave the
        // same durable record when the round dies. Disarmed by
        // _clearRoundTracking on finalize and on an immediate skip.
        this._armRoundWatchdog(round, btcBlockHeight, btcBlockTime);

        let leader   = this._getLeader(round, memberPubkeys);
        let myAddr   = this.peerManager.validatorAddr;
        let isLeader = this._isLeaderIdentity(leader, myAddr, this._resolveSenderPubkey(myAddr));

        if (isLeader) {
            this._proposeRound(round, submissions, false, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys);
            return;
        }

        // Follower path. Record when this round became ready to finalize so the
        // receiver-side leader-timeout grace in _handlePropose measures the same
        // window every other hub does.
        this._markRoundReady(round);

        let leaderSubAddr   = this._leaderSubmissionAddr(submissions, leader);
        let leaderSubmitted = leaderSubAddr != null;
        if (leaderSubmitted) {
            // The leader has a submission on record and is expected to broadcast
            // ORACLE_PROPOSE. But a leader can gossip its submission and then
            // crash before proposing, leaving every follower waiting out the full
            // finalization window. Arm a shorter leader-timeout: if no PROPOSE has
            // populated pendingRounds by then, the lowest-addr submitter OTHER THAN
            // the (presumed-dead) leader takes over as fallback proposer. Only the
            // elected fallback arms a timer; a live leader proposes immediately, so
            // by the time this fires the round is already taken and we abort.
            let fb = [...submissions.keys()].filter(a => a !== leaderSubAddr).sort()[0];
            if (fb === myAddr) {
                let t = setTimeout(() => {
                    this.leaderTimers.delete(round);
                    if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
                    // Same snapshot membership filter as the election above so a
                    // non-member submitter arriving during the grace cannot shift
                    // the fallback election (Oracle M1).
                    let subs = this._filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
                    if (!subs || subs.size === 0) return;
                    // Re-elect against the (possibly grown) submission set in case
                    // gossip delivered more submitters during the grace.
                    let fb2 = [...subs.keys()].filter(a => a !== this._leaderSubmissionAddr(subs, leader)).sort()[0];
                    if (fb2 !== myAddr) return;
                    this._proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys);
                }, this.leaderTimeout + FALLBACK_GRACE_MS);
                // Don't let an armed grace timer keep the process alive on its own;
                // the hub stays up via its other listeners. Cleared on stop().
                if (t.unref) t.unref();
                this.leaderTimers.set(round, t);
            }
            return;
        }

        // Leader has no submission. Lowest addr (lex) among submitters takes over.
        let fallbackAddr = [...submissions.keys()].sort()[0];
        if (fallbackAddr !== myAddr) {
            // Someone else is the fallback. Wait for their PROPOSE.
            return;
        }

        // I'm the fallback. Grace period in case a real-leader PROPOSE is in flight;
        // if pendingRounds gets populated during the grace, abort.
        let t = setTimeout(() => {
            this.leaderTimers.delete(round);
            if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
            // Filter to snapshot members, matching the election above (Oracle M1).
            let subs = this._filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
            if (!subs || subs.size === 0) return;
            this._proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys);
        }, FALLBACK_GRACE_MS);
        // Don't let this grace timer keep the process alive on its own; register
        // it so stop() can cancel it, matching the sibling timer above.
        if (t.unref) t.unref();
        this.leaderTimers.set(round, t);
    }

    // Propose a round (used both by the real leader and the fallback proposer).
    // snapshot + quorum are captured in finalizeRound() at the block boundary
    // and threaded through so the entire round uses the same locked validator
    // set. Without the snapshot, falls back to live _getQuorum() per legacy.
    _proposeRound(round, submissions, isFallback, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys) {
        let aggregated = this._aggregateAll(submissions);
        if (aggregated.length === 0) {
            this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'aggregation yielded no prices').catch(err =>
                console.error('Oracle: Error storing skipped round ' + round + ':', err.message));
            return;
        }

        let digest = this._digest(round, aggregated);

        // Sign the canonical PRICE v0 payload locally (this validator's contribution
        // to the on-chain anchor). Embedded in the published PRICE v0 transaction along
        // with sigs from other validators.
        let mySig = this._signPriceV0(round, btcBlockTime, aggregated, btcBlockHeight);

        let pending = {
            round:          round,
            prices:         aggregated,
            digest:         digest,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            prepares:       new Set(),
            commits:        new Set(),
            signatures:     new Map(),  // pubkey (hex) -> sig (hex)
            finalized:      false,
            timer:          null,
            // Snapshot of the validator set at this round's block boundary.
            // Locked here so _checkPrepareQuorum/_checkCommitQuorum compute
            // against the same N for the round's full lifecycle, even when
            // on-chain stake state changes mid-round (capability-staking spec §6).
            snapshot:       snapshot || null,
            quorum:         (typeof quorum === 'number' && quorum >= 0) ? quorum : this._getQuorum(),
            // STAKE_WEIGHTED_QUORUM round? Carry the source-keyed validator weights so
            // _checkPrepareQuorum/_checkCommitQuorum can tally signer stake (the count
            // quorum above is ignored when weighted).
            weighted:       !!weighted,
            validators:     (weighted && snapshot && Array.isArray(snapshot.validators))
                ? snapshot.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0') }))
                : [],
            // Snapshot member pubkeys for the count-mode vote tally (Oracle M1).
            // Null (no usable snapshot) keeps the legacy raw-sender count.
            memberPubkeys:  memberPubkeys || null
        };

        // Vote sets hold PROVEN SIGNING KEYS, not sender addrs: quorum is a count of
        // distinct staked signers, and an addr is a self-asserted wire field that one
        // key could vary to forge a quorum. Seed our own key the same way.
        let selfPk = this._selfPubkey();
        if (selfPk) pending.prepares.add(selfPk);
        if (mySig) pending.signatures.set(mySig.pubkey, mySig.sig);
        this.pendingRounds.set(round, pending);
        // Replay any PREPARE/COMMIT that beat this proposal (finding F7).
        this._drainEarlyMessages(round);

        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                // Count leader-seat quorum loss symmetrically with the follower-side
                // PROPOSE-round timeout in _handlePropose (review 1469): before this,
                // the eviction left no countable trace, so a leader repeatedly stuck
                // below commit quorum was invisible to the dashboard's oracle stall
                // ladder until lastSuccessAge aged past its warn band. Deliberately
                // NOT a _storeSkippedRound: that marks the round finalized locally
                // and would refuse a late-arriving quorum, unlike the follower path.
                this._roundTimeouts = (this._roundTimeouts || 0) + 1;
                console.warn('Oracle: Finalization timeout for round ' + round + ' ('
                    + pending.prepares.size + ' prepares, '
                    + pending.commits.size + ' commits, quorum ' + pending.quorum + ')');
                this.pendingRounds.delete(round);
            }
        }, this.finalizationTimeout);

        // Broadcast ORACLE_PROPOSE (includes proposer's signature on the canonical PRICE v0 payload).
        // submissionKeys carries the proposer's own view of the submission set (sorted) purely as a
        // diagnostic/wire-compat hint. Receivers do NOT trust it for fallback-proposer legitimacy;
        // that check is made solely against each receiver's locally-observed submissions (see
        // _handlePropose), since a peer-supplied set is attacker-controllable.
        this.peerManager.broadcast(ORACLE_PROPOSE, {
            round:          round,
            prices:         aggregated,
            digest:         digest,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            submissionKeys: [...submissions.keys()].sort(),
            sig_pubkey:     mySig ? mySig.pubkey : null,
            sig:            mySig ? mySig.sig    : null
        });

        let tag = isFallback ? '[FALLBACK] ' : '';
        console.log('Oracle: ' + tag + 'Proposed round ' + round + ' with ' + aggregated.length +
            ' prices (' + submissions.size + ' submissions)');

        this._checkPrepareQuorum(round);
    }

    // Whether an authenticated envelope may be counted toward this round's quorum.
    // Admits on the PROVEN signing key (chain-effective set OR registry), never on
    // envelope.sender: the chain attributes keys, not P2P addresses, so keying on
    // the address is what stranded a staked community validator in the denominator
    // without ever reaching the numerator. Full argument in lib/chain_signer_admission.js.
    _isKnownSender(envelope) {
        return isAdmissibleSigner(this.peerManager, envelope);
    }

    // Verified signing pubkey (lowercase hex) for a sender addr, or null. The
    // registry binding is enforced by PeerManager on every verified envelope
    // (a registered sender's envelope MUST be signed by its registered key), so
    // this resolves to the identity that actually signed, not a claim. Own addr
    // falls back to the local identity for hubs not present in their own registry.
    //
    // Addr-keyed by necessity: its remaining callers walk the submission map,
    // which is keyed by sender. The VOTE path no longer needs it, because
    // prepare/commit sets now hold proven keys directly.
    _resolveSenderPubkey(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        let pk = (registry && typeof registry.get === 'function') ? registry.get(sender) : null;
        if (!pk && sender === this.peerManager.validatorAddr) {
            let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
            if (identity) pk = identity.getPubkeyHex();
        }
        return pk ? String(pk).toLowerCase() : null;
    }

    // This hub's own signing key, for seeding its own vote into a key-keyed
    // prepare/commit set. Null only on a hub with no identity and no registry
    // row, which cannot sign a vote anyway; callers skip seeding rather than
    // admit a null into the tally.
    _selfPubkey() {
        return this._resolveSenderPubkey(this.peerManager && this.peerManager.validatorAddr);
    }

    // Record one peer's vote in a key-keyed prepare/commit set. The envelope has
    // already cleared _isKnownSender, so it carries a proven key; this is where
    // the forgery bound actually bites, because N envelopes from ONE key collapse
    // to a single Set entry no matter how many distinct senders they name.
    _addVote(voteSet, envelope) {
        let pk = provenPubkey(envelope);
        if (pk) voteSet.add(pk);
    }

    // Pubkey set of a locked capability snapshot, or null when there is no usable
    // snapshot (indexer unreachable / empty validators). Null disables the
    // membership filter, preserving the legacy graceful-degradation path; the
    // empty-snapshot case is separately skipped via _isEmptyFederationSnapshot.
    _memberPubkeySet(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
        let set = new Set();
        for (let v of snapshot.validators) {
            if (v && v.pubkey) set.add(String(v.pubkey).toLowerCase());
        }
        return set.size > 0 ? set : null;
    }

    // Oracle M1: restrict a sender-keyed submission map to validators that are
    // members of the round's locked price snapshot, one submission per PUBKEY.
    // Quorum is sized from the snapshot, so submissions from merely-REGISTERED
    // validators (no qualifying stake) must not reach the trimmed median, the
    // minSubmissions floor, or the fallback-proposer election; and since the
    // registry may bind one key to several addrs, dedup on the verified key,
    // first arrival wins (Map iteration is insertion-ordered). A null memberPubkeys
    // (no usable snapshot) returns the map unchanged (legacy behavior).
    _filterSubmissionsToSnapshot(submissions, memberPubkeys) {
        if (!submissions || !memberPubkeys) return submissions;
        let filtered = new Map();
        let seen = new Set();
        for (let [addr, sub] of submissions) {
            let pk = (sub && sub.pubkey) ? sub.pubkey : this._resolveSenderPubkey(addr);
            if (!pk || !memberPubkeys.has(pk)) continue;
            if (seen.has(pk)) continue;
            seen.add(pk);
            filtered.set(addr, sub);
        }
        return filtered;
    }

    _handleMessage(envelope) {
        switch (envelope.type) {
            case ORACLE_PROPOSE:
                // _handlePropose is async because it locks the validator-set
                // snapshot at the round's block boundary via an indexer call.
                // Errors are caught and logged; they never bubble up to the gossip layer.
                this._handlePropose(envelope).catch(err =>
                    console.error('Oracle: PROPOSE handler error for round %s:',
                        (envelope && envelope.data && envelope.data.round),
                        err && err.message ? err.message : err));
                break;
            case ORACLE_PREPARE: this._handlePrepare(envelope); break;
            case ORACLE_COMMIT:  this._handleCommit(envelope);  break;
        }
    }

    async _handlePropose(envelope) {
        let { round, prices, digest, btcBlockHeight, btcBlockTime, sig_pubkey, sig } = envelope.data;
        // Round 0 is a real, valid round (the first ORACLE_ROUND_INTERVAL after
        // ORACLE_EPOCH_START); guard on integer/non-negative, not falsiness, so a
        // genesis round-0 PROPOSE is not silently dropped as malformed.
        if (!Number.isInteger(round) || round < 0 || !prices || !digest) return;
        if (this.finalized.has(round)) return;

        // Discard proposals from senders that are not registered validators
        // before doing any snapshot/indexer work for them.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'propose', sender: envelope.sender, envelope });
            return;
        }

        // Verify digest
        let computedDigest = this._digest(round, prices);
        if (computedDigest !== digest) {
            console.warn('Oracle: PROPOSE digest mismatch from ' + envelope.sender + ' for round ' + round);
            return;
        }

        // Resolve the round's locked snapshot BEFORE validating the proposer
        // (Oracle M1): the fallback-proposer election below must run over the
        // same snapshot-member-filtered submission set every hub's finalizeRound
        // uses, or a non-member submitter could skew which sender this follower
        // accepts as the legitimate fallback. A pending round reuses its locked
        // member set; otherwise the snapshot is resolved here (the same
        // fail-closed guards that used to sit at pending creation, just earlier)
        // and consumed by the pending creation further down.
        let blockHeight = null, wt = false, snap = null, quorumForRound = null;
        let memberPubkeys = null;
        {
            let existing = this.pendingRounds.get(round);
            if (existing) {
                memberPubkeys = existing.memberPubkeys || null;
            } else {
                // Fix (#1225): do NOT substitute the round id for a missing BTC block
                // height on a federated hub. The leader locked the price snapshot at the
                // real round block in finalizeRound; pinning the follower's snapshot at
                // block_index = round (not a BTC boundary) locks a DIFFERENT (price, block)
                // set/quorum than the leader for the same round, or degrades to the null
                // path. Only reachable from a peer that omits the height (old peer mid
                // rolling deploy, or a malformed envelope) -- current honest senders always
                // populate it. Fail closed: drop the PROPOSE rather than pin to a fake block.
                // A single-node / regtest hub (_getQuorum()===0) has no peer to split from,
                // so it keeps the legacy round-as-anchor fallback for bootstrap.
                blockHeight = btcBlockHeight;
                if (!Number.isInteger(blockHeight) || blockHeight <= 0) {
                    if (this._getQuorum() > 0) {
                        console.warn('Oracle: dropping PROPOSE for round ' + round + ': no BTC block ' +
                            'height in envelope on a federated hub; refusing to pin the price snapshot ' +
                            'at the round id (not a BTC block boundary), which would diverge from the ' +
                            'leader\'s snapshot for this round.');
                        return;
                    }
                    blockHeight = round;
                }
                // Freshness bound (fail closed), the missing half of the guard above,
                // which closes only the ABSENT-height case. A present but ancient
                // height is refused by nothing downstream: CapabilitySnapshot's echo
                // check rejects a MISMATCHED echo, and the indexer fail-closes only
                // above its own tip, so an old-but-indexed block resolves a perfectly
                // valid snapshot. That hands the proposer three choices at once: the
                // quorum denominator (getQuorum(snap)), the member set that
                // _getLeader elects from (so it can pick a height where it is the
                // round's leader and the legitimacy check then validates it against
                // its own choice), and the weighted-vs-count mode the guard below
                // calls a federation-split hazard. Bound the wire height against our
                // own resolved BTC tip before any of the three read it, and decline
                // when we cannot resolve a tip of our own. Same shape and tolerance as
                // StateCheckpointEngine's co-sign guard. Federated hubs only, like
                // every other fail-closed guard on this path.
                if (this._getQuorum() > 0) {
                    let myTip = this.hub && this.hub._resolveBtcLatestBlock
                        ? await this.hub._resolveBtcLatestBlock()
                        : null;
                    if (!Number.isFinite(Number(myTip))) {
                        console.warn('Oracle: dropping PROPOSE for round ' + round + ': cannot resolve ' +
                            'our own BTC tip to bound the leader-supplied snapshot height ' +
                            '(federated hub).');
                        return;
                    }
                    if (Math.abs(Number(myTip) - Number(blockHeight)) > this.snapshotToleranceBlocks) {
                        console.warn('Oracle: dropping PROPOSE for round ' + round + ': block height ' +
                            blockHeight + ' deviates from our own BTC tip ' + myTip + ' by more than ' +
                            this.snapshotToleranceBlocks + ' blocks (federated hub); a stale height would ' +
                            'let the proposer select the price snapshot, the round leader and the ' +
                            'quorum mode.');
                        return;
                    }
                }
                // Same activation gate + weight snapshot the leader locked in finalizeRound,
                // so this follower tallies the round identically (weighted on stake or legacy
                // on count), keyed on the round's BTC block boundary + the hub's network.
                wt = swq.isStakeWeightedQuorumActive(blockHeight, this.hub.network);
                snap = this.hub.capabilitySnapshot
                    ? (wt
                        ? await this.hub.capabilitySnapshot.getWeightSnapshot('price', blockHeight)
                        : await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight))
                    : null;
                // Mirror the finalizeRound() fallback: if weighted but no validators in the
                // snapshot, degrade to count mode so the round can finalize normally.
                if (wt && (!snap || !Array.isArray(snap.validators) || snap.validators.length === 0)) {
                    // Federation-split guard (fail closed), mirroring the leader-side guard
                    // in finalizeRound (#1222). swq.isStakeWeightedQuorumActive is a pure
                    // function of (block, network) every honest hub computes identically, so
                    // degrading THIS follower to a count quorum on its own weight-snapshot
                    // reachability (e.g. a per-RPC getstakeweightsbycapability failure) forks
                    // the finalization THRESHOLD: peers tally summed stake while this hub
                    // tallies a count over the same N. Skip the round rather than diverge.
                    // A single-node / regtest hub (_getQuorum()===0) has no peer to split
                    // from, so it keeps the graceful count fallback below.
                    if (this._getQuorum() > 0) {
                        console.warn('Oracle: dropping PROPOSE for round ' + round + ': weighted mode ' +
                            'active but weight snapshot unavailable while federated; refusing to open a ' +
                            'count-mode pending round this hub\'s peers are not using.');
                        return;
                    }
                    wt   = false;
                    snap = this.hub.capabilitySnapshot
                        ? await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight)
                        : null;
                }
                quorumForRound = snap
                    ? this.hub.capabilitySnapshot.getQuorum(snap)
                    : this._getQuorum();
                // Refuse to open a pending round on an empty federation snapshot: quorum
                // would be 0 and _quorumMet (count mode) returns `size >= 0` = true, so a
                // single PREPARE/COMMIT would finalize. A legitimate leader skips such a
                // round (finalizeRound), so a PROPOSE for one is spurious/Byzantine; drop
                // it. Genuine single-node hubs receive no PROPOSEs, and a healthy
                // federation snapshot is non-empty, so this only bites the bad case.
                if (this._isEmptyFederationSnapshot(snap)) {
                    console.warn('Oracle: dropping PROPOSE for round ' + round + ': empty price-qualifying ' +
                        'snapshot at block ' + blockHeight + ' on a federated hub (a legitimate leader skips ' +
                        'such a round; not accepting a single-signature finalization).');
                    return;
                }
                memberPubkeys = this._memberPubkeySet(snap);
            }
        }

        // Accept PROPOSE if sender is the deterministic leader OR an authorized
        // fallback (lowest-addr submitter when the leader has no submission).
        // The fallback path salvages rounds where the leader's price fetch
        // failed but other hubs have prices. The local submission view is
        // filtered to snapshot members (Oracle M1) so the election and the
        // deviation reference only see qualified validators.
        let leader       = this._getLeader(round, memberPubkeys);
        let submissions  = this._filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
        // Identify the proposer by the key that PROVABLY signed this envelope
        // (PeerManager verified it, and binds a registered sender to its
        // registered key), not by a registry lookup on the sender addr. The
        // registry is only a legacy fallback for unsigned envelopes: a hub with
        // an empty registry (freshly staked, or a non-validator observer) would
        // otherwise admit the leader's PROPOSE via the chain-effective set and
        // then reject it as "non-leader" because it could not name its key.
        let proposerPk   = provenPubkey(envelope) || this._resolveSenderPubkey(envelope.sender);
        let isRealLeader = this._isLeaderIdentity(leader, envelope.sender, proposerPk);
        let isFallback   = false;

        if (!isRealLeader) {
            // Validate the fallback proposer against our LOCALLY-observed
            // submission set only. The PROPOSE also carries the proposer's own
            // claimed submission keys, but that list is attacker-controlled: a
            // Byzantine proposer can claim any subset whose lexicographically
            // lowest entry is its own address and thereby elect itself fallback
            // even while the deterministic leader has a valid submission. Trusting
            // it would let a single registered validator inject arbitrary prices
            // into any round. We therefore ignore the claimed list and elect the
            // fallback from the submissions we have actually seen.
            //
            // Trade-off: gossip delivery is async, so our local view may lag the
            // proposer's at the instant of election; in that window we may reject
            // a legitimate fallback and stall the round until the finalization
            // timeout re-elects. That liveness edge case is the accepted cost of
            // not trusting a peer-supplied set for a price-oracle integrity gate.
            let keys = submissions ? [...submissions.keys()] : [];
            if (keys.length > 0) {
                let leaderSubAddr   = this._leaderSubmissionAddr(submissions, leader);
                let leaderSubmitted = leaderSubAddr != null;
                if (!leaderSubmitted) {
                    let fallbackAddr = keys.sort()[0];
                    if (fallbackAddr === envelope.sender) isFallback = true;
                } else {
                    // Leader submitted but may have crashed before proposing. Accept
                    // a fallback from the lowest-addr submitter OTHER THAN the leader,
                    // but only after this hub's own leader-timeout grace has elapsed
                    // since the round became ready. An early (possibly malicious)
                    // fallback could otherwise usurp a still-alive leader and inject
                    // arbitrary prices. A live leader proposes immediately, so once
                    // the grace passes without a PROPOSE the leader is presumed dead.
                    // The sender is still validated against our LOCALLY-observed
                    // submission set, never a peer-supplied list (see the trust note
                    // above), preserving the price-integrity gate.
                    let readyAt = this.roundReadyAt.get(round);
                    if (readyAt && (Date.now() - readyAt) >= this.leaderTimeout) {
                        let fallbackAddr = keys.filter(a => a !== leaderSubAddr).sort()[0];
                        if (fallbackAddr === envelope.sender) isFallback = true;
                    }
                }
            }
        }

        if (!isRealLeader && !isFallback) {
            console.warn('Oracle: PROPOSE from non-leader ' + envelope.sender + ' for round ' + round);
            return;
        }

        if (isFallback) {
            console.log('Oracle: Accepting [FALLBACK] PROPOSE from ' + envelope.sender +
                ' for round ' + round + ' (leader ' + (leader ? leader.addr : 'unknown') + ' has no submission)');
        }

        // Content-validate the proposed prices before co-signing. Leadership rotates round-robin, so
        // a Byzantine or feed-broken validator gets a leader turn; without this check honest followers
        // would PREPARE/COMMIT and contribute signatures to whatever prices it proposed (the digest
        // check only proves the proposer's array hashes to its own digest). Mirror CrossChainEngine's
        // "never trust the proposer's claim": reject (no PREPARE/sign) any pair outside the hard
        // PRICE_MAX bound, or (when this hub has its own aggregate for the pair) more than the
        // federation-uniform ORACLE_DEVIATION_THRESHOLD away from it. This gate deliberately does
        // NOT read the per-operator SLASH_DEVIATION_THRESHOLD (constants.js explains why: per-hub
        // bands would split accept/withhold decisions at the +-band edge); SlashDetector defaults
        // its slash band to the same constant and fail-fasts on a tighter override, so by default
        // we never co-sign exactly what we'd be slashed for.
        // Fix (seq 4083): for pairs where this hub has no local submission, also check the last
        // finalized price_snapshots value if available, to narrow the acceptance window beyond the
        // very loose PRICE_MAX bound. Without this a Byzantine leader can inject any price in
        // (0, PRICE_MAX) for any pair that quorum co-signers did not price locally.
        {
            // Exclude the PROPOSER's own submission from the deviation reference: a
            // Byzantine leader/fallback must not be its own co-sign reference. With its
            // gossiped submission in the reference, a pair only IT submitted (in our local
            // view) self-validates at deviation 0, letting it inject any (0, PRICE_MAX)
            // price for pairs we did not independently fetch. Excluding it makes such a
            // pair fall through to the historical-snapshot bound below.
            // Resolve the proposer's verified pubkey and exclude EVERY addr bound to
            // it, not just envelope.sender: the registry may bind one key to several
            // addrs (see _addrForPubkey / _leaderSubmissionAddr), so a leader can gossip
            // its submission from addr A and PROPOSE from addr B. An addr-only exclusion
            // would leave A's price in the reference and let the pair self-validate at
            // deviation 0. Mirror _leaderSubmissionAddr's pubkey resolution; keep the
            // raw-addr guard as a belt-and-suspenders fallback for unknown-pubkey addrs.
            let refSubs = new Map();
            let proposerPk = this._resolveSenderPubkey(envelope.sender);
            if (submissions) for (let [addr, sub] of submissions) {
                if (addr === envelope.sender) continue;
                let pk = (sub && sub.pubkey) ? String(sub.pubkey).toLowerCase() : this._resolveSenderPubkey(addr);
                if (proposerPk && pk === proposerPk) continue;
                refSubs.set(addr, sub);
            }
            let localByPair  = new Map((this._aggregateAll(refSubs) || []).map(a => [a.coinPair, a.price]));
            // Federation-uniform deviation band (shared constant, not per-hub config) so
            // every hub's accept/withhold boundary is identical; deviation is computed in
            // bignumber (bcmath) per the platform mandate, removing the +-band-boundary
            // float-ULP ambiguity. A reject emits oracle:propose-rejected so a feed-
            // disagreement withhold is distinguishable from a leader crash.
            let devThreshold = ORACLE_DEVIATION_THRESHOLD;
            // Canonical-pair whitelist for the co-sign gate. Ingest already drops a
            // fabricated pair (OracleRound.canonicalPairs, built from
            // PriceFetcher.getCoinPairs()), but the propose path never re-checked it:
            // a pair the leader invents has no live local aggregate and no finalized
            // history, so both deviation gates below are structurally absent and it
            // falls through with only the (0, PRICE_MAX) bound. A single Byzantine
            // round-robin leader could thus get a non-canonical pair (e.g. BTC/ZZZ)
            // quorum co-signed and finalized. Read the SAME set the ingest path uses
            // (this.oracleRound.canonicalPairs) so the two cannot drift. Fail-open on
            // an empty/absent whitelist (bootstrap / misconfig) so honest followers
            // never withhold on legitimate pairs when the source is momentarily stale.
            let canonicalPairs = (this.oracleRound &&
                this.oracleRound.canonicalPairs && this.oracleRound.canonicalPairs.size)
                ? this.oracleRound.canonicalPairs
                : null;
            let reject = (coinPair, detail, extra) => {
                console.warn('Oracle: rejecting PROPOSE round ' + round + ' from ' + envelope.sender +
                    ': ' + coinPair + ' ' + detail);
                this.emit('oracle:propose-rejected', Object.assign({ round, sender: envelope.sender, coinPair }, extra || {}));
            };
            for (let p of prices) {
                let val = parseFloat(p.price);
                if (!(Number.isFinite(val) && val > 0 && val < PRICE_MAX)) {
                    reject(p.coinPair, 'price ' + p.price + ' outside (0, PRICE_MAX)',
                        { reason: 'out-of-range', proposed: String(p.price) });
                    return;
                }
                // Canonical-pair membership: withhold co-sign on any pair ingest would
                // have dropped, closing the fabricated-pair injection path (same fail-safe
                // withhold path as a deviation disagreement). Skipped when the whitelist is
                // empty/absent so a stale source cannot freeze honest followers.
                if (canonicalPairs && !canonicalPairs.has(p.coinPair)) {
                    reject(p.coinPair, 'pair not in canonical whitelist',
                        { reason: 'non-canonical-pair', proposed: String(p.price) });
                    return;
                }
                let local = localByPair.get(p.coinPair);
                if (local !== undefined && local !== null && bcmath.bcgt(local, '0')) {
                    // Canonical mean-relative band (shared deviation_band helper):
                    // deviation = |local - proposed| / proposed, i.e. the follower's own
                    // aggregate measured against the PROPOSED price as reference, the same
                    // reference orientation as the publish-side 2-source gate ((hi-lo)/(hi+lo)
                    // = each submitter vs the mean) and SlashDetector (submission vs the
                    // finalized price). Dividing by `local` instead (the previous approach) opened a
                    // ratio window r in (1.10, 1.10526] at the 5% band where the leader
                    // publishes a 2-source pair the follower then withholds the whole round
                    // over, with no durable record. CONSENSUS-CRITICAL: deploy fleet-wide
                    // atomically.
                    // Branch on the shared exceedsBand() comparator, not a locally
                    // written bcgt: the band boundary (strict >, and the threshold's
                    // string coercion) is then one definition shared with the slash
                    // gate, so it cannot be edited on one side of the accept/slash pair
                    // and not the other. deviation is recomputed inside the branch for
                    // the pct/metadata only, which keeps the co-sign path at exactly one
                    // computation and costs a second bcdiv solely on a reject.
                    if (devband.exceedsBand(local, p.price, devThreshold, 18)) {
                        let deviation = devband.deviationFrom(local, p.price, 18);
                        let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
                        reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
                            '% from local ' + local + ' (> ' + (devThreshold * 100) + '%)',
                            { reason: 'deviation', proposed: String(p.price), local: String(local), deviation: bcmath.bcformat(deviation, 18) });
                        return;
                    }
                } else {
                    // No live local submission for this pair. Apply a tighter sanity check
                    // against the most recent finalized snapshot price when available, so a
                    // Byzantine leader cannot inject any (0, PRICE_MAX) value for pairs that
                    // quorum co-signers happened to not fetch in this round.
                    let lastPrice = this._getLastFinalizedPrice(p.coinPair);
                    if (lastPrice !== null && bcmath.bcgt(lastPrice, '0')) {
                        // Shared deviation_band helper; reference = last finalized
                        // price, already the canonical orientation here (behavior-preserving).
                        let deviation = devband.deviationFrom(p.price, lastPrice, 18);
                        // Use a wider band than the live-submission check to allow for
                        // genuine price movement between rounds, while still bounding a Byzantine
                        // leader from injecting values that are orders of magnitude off. The band
                        // is ORACLE_MAX_CHANGE_PER_ROUND, which is what the aggregation clamp
                        // (_clampToLastFinalized) emits for every pair EXCEPT those carrying a
                        // tighter per-pair override (maxChangeForPair; XCHAIN/USD is at 10%).
                        //
                        // Deliberately NOT maxChangeForPair() here, and this asymmetry is
                        // load-bearing. The gate must never be tighter than the clamp, so it
                        // holds at the GLOBAL maximum: that keeps it a superset of every
                        // per-pair clamp, and for an overridden pair being merely permissive
                        // costs nothing (no honest leader can propose a move the clamp did not
                        // bound, and a follower that DID submit locally is checked against its
                        // own value by the much tighter ORACLE_DEVIATION_THRESHOLD above).
                        //
                        // Bound with the CLAMP'S OWN arithmetic rather than the 18dp deviation
                        // ratio. Holding the same threshold was not enough: the clamp takes an
                        // 8dp ROUND_HALF_UP delta off the last price, so whenever last*pct
                        // rounds up (last='0.11111111' -> maxDelta '0.02777778' -> hi
                        // '0.13888889' -> ratio 0.2500000225) the maximally-clamped aggregate
                        // landed a hair over the ratio line and every honest follower without a
                        // local submission rejected it - wedging the round the clamp was
                        // protecting, exactly on the fat-tail move it exists for (item 4940).
                        // Recomputing hi/lo with the identical bcmul/bcadd/bcsub at scale 8
                        // makes a clamped price pass by construction, at the same threshold, for
                        // every pair. `deviation` above is kept for the reject message/metadata.
                        // CONSENSUS-CRITICAL: deploy fleet-wide atomically.
                        let histDelta = bcmath.bcmul(lastPrice, String(ORACLE_MAX_CHANGE_PER_ROUND), 8);
                        let histHi    = bcmath.bcadd(lastPrice, histDelta, 8);
                        let histLo    = bcmath.bcsub(lastPrice, histDelta, 8);
                        if (bcmath.bcgt(p.price, histHi) || bcmath.bclt(p.price, histLo)) {
                            let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
                            reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
                                '% from last finalized ' + lastPrice + ' (no local submission, threshold ' + (ORACLE_MAX_CHANGE_PER_ROUND * 100) + '%)',
                                { reason: 'historical-deviation', proposed: String(p.price), lastFinalized: String(lastPrice), deviation: bcmath.bcformat(deviation, 18) });
                            return;
                        }
                    } else if (!this.allowUnverifiedPairs) {
                        // No live local aggregate AND no finalized history means
                        // this follower can verify the value against nothing; only the
                        // (0, PRICE_MAX) clamp would apply. Withhold co-sign (same
                        // fail-safe path as a deviation disagreement) so a Byzantine
                        // leader who is the sole submitter for a brand-new pair cannot
                        // get an arbitrary value quorum co-signed. The pair finalizes
                        // once at least one co-signer prices it locally (next fetch
                        // cycle); ORACLE_ALLOW_UNVERIFIED_PAIRS=true restores the old
                        // clamp-only leniency for deliberate single-fetcher setups.
                        reject(p.coinPair, 'proposed ' + p.price + ' is unverifiable: no local submission and no finalized history',
                            { reason: 'unverifiable-new-pair', proposed: String(p.price) });
                        return;
                    }
                }
            }

            // Coverage check. The per-price loop above only bounds the pairs the
            // proposer chose to INCLUDE; it never checks for pairs the proposer
            // dropped. Withhold co-sign (same fail-safe path as a deviation
            // disagreement) so a pair a Byzantine leader SUPPRESSED can't silently
            // freeze consumers on the prior snapshot for the round window.
            if (!Array.isArray(prices) || prices.length === 0) {
                reject('(all)', 'empty or malformed price set', { reason: 'empty-proposal' });
                return;
            }
            let proposedPairs = new Set(prices.map(p => p && p.coinPair));
            // Reproduce the LEADER's aggregation before demanding coverage. An honest
            // leader aggregates the full member submission set, so a pair its
            // `_aggregate` legitimately returned null for (the exactly-2-source
            // deviation gate, an emptied trim) is honestly absent from the proposal.
            // `localByPair` is the proposer-EXCLUDED reference, correct for the value
            // checks above and wrong here: a pair submitted by the leader plus exactly
            // one other hub looks single-source in that view, never reaches the
            // 2-source gate, and tripped this loop on every honest round the two feeds
            // disagreed - withholding all 36+ pairs and leaving no snapshot at all
            // (item 4939). Demand coverage only where BOTH views price the pair, which
            // is the suppression case and a strict subset of the old condition.
            let leaderByPair = new Set((this._aggregateAll(submissions) || []).map(a => a && a.coinPair));
            for (let coinPair of localByPair.keys()) {
                if (!leaderByPair.has(coinPair)) continue;
                if (!proposedPairs.has(coinPair)) {
                    reject(coinPair, 'priced locally but omitted from proposal', { reason: 'missing-pairs' });
                    return;
                }
            }
        }

        // Create or update pending round. The validator-set snapshot was locked
        // at the round's block boundary BEFORE the proposer validation above
        // (same snapshot the leader used in finalizeRound) so PREPARE/COMMIT
        // checks use the same N on every hub. blockHeight/wt/snap/quorumForRound
        // are only populated when no pending round existed at the top of this
        // handler; a concurrent handler creating one during the await is caught
        // by the has() re-check here.
        if (!this.pendingRounds.has(round) && quorumForRound !== null) {
            let quorum = quorumForRound;
            let pending = {
                round:          round,
                prices:         prices,
                digest:         digest,
                btcBlockHeight: blockHeight,
                btcBlockTime:   btcBlockTime   || Math.floor(Date.now() / 1000),
                prepares:       new Set(),
                commits:        new Set(),
                signatures:     new Map(),  // pubkey (hex) -> sig (hex)
                finalized:      false,
                snapshot:       snap || null,
                quorum:         quorum,
                weighted:       !!wt,
                validators:     (wt && snap && Array.isArray(snap.validators))
                    ? snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0') }))
                    : [],
                // Snapshot member pubkeys for the count-mode vote tally (Oracle M1).
                memberPubkeys:  memberPubkeys || null,
                timer:          setTimeout(() => {
                    // Surface the follower-side PROPOSE-round timeout (item 4268e0fb).
                    // The leader path logs its finalization timeout, but this eviction
                    // fired in total silence, hiding a follower stuck below commit quorum.
                    // Mirror the StateCheckpointEngine._roundTimeouts counter convention.
                    let p = this.pendingRounds.get(round);
                    if (p && !p.finalized) {
                        this._roundTimeouts = (this._roundTimeouts || 0) + 1;
                        console.warn('Oracle: PROPOSE round ' + round + ' timed out before commit quorum ('
                            + (p.prepares ? p.prepares.size : 0) + ' prepares, '
                            + (p.commits ? p.commits.size : 0) + ' commits, quorum ' + p.quorum + ')');
                    }
                    this.pendingRounds.delete(round);
                }, this.finalizationTimeout)
            };
            this.pendingRounds.set(round, pending);
            // A PROPOSE is the other way a round becomes OPEN on this hub: a seat
            // whose own finalizeRound never ran for this round (its round scheduler
            // missed the boundary, or it had no submissions of its own) still
            // observed the round through gossip and must hold a record of it.
            // Idempotent with the finalizeRound arming.
            this._armRoundWatchdog(round, pending.btcBlockHeight, pending.btcBlockTime);
            // Replay any PREPARE/COMMIT that arrived while this handler was
            // awaiting the snapshot fetch above (finding F7).
            this._drainEarlyMessages(round);
        }

        let pending = this.pendingRounds.get(round);
        // Guard against a second PROPOSE for the same round with a different
        // digest (mirrors the Consensus._handlePrePrepare fix in b8f5143).
        // Adding the sender to pending.prepares and broadcasting ORACLE_PREPARE
        // with the incoming digest would inflate the A-round prepare tally and
        // emit an orphaned PREPARE for digest B, the same protocol-noise pattern
        // the config engine fixed. COMMIT quorum still guards finalization, but
        // we should not mutate prepares or broadcast at all for a conflicting digest.
        if (pending.digest !== digest) {
            console.warn('Oracle: PROPOSE digest conflict for round ' + round +
                ' from ' + envelope.sender + ': expected ' + pending.digest + ', got ' + digest);
            return;
        }
        this._addVote(pending.prepares, envelope);
        let selfPkOnPropose = this._selfPubkey();
        if (selfPkOnPropose) pending.prepares.add(selfPkOnPropose);

        if (sig_pubkey && sig) {
            this._verifyAndStoreSig(pending, sig_pubkey, sig);
        }

        let mySig = this._signPriceV0(round, pending.btcBlockTime, prices, pending.btcBlockHeight);
        if (mySig && !pending.signatures.has(mySig.pubkey)) {
            pending.signatures.set(mySig.pubkey, mySig.sig);
        }

        this.peerManager.broadcast(ORACLE_PREPARE, {
            round:      round,
            digest:     digest,
            sig_pubkey: mySig ? mySig.pubkey : null,
            sig:        mySig ? mySig.sig    : null
        });

        this._checkPrepareQuorum(round);
    }

    _handlePrepare(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!Number.isInteger(round) || round < 0 || !digest) return;   // round 0 is valid (see _handlePropose)

        // Only count PREPARE votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'prepare', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingRounds.get(round);
        if (!pending) {
            // No pending entry yet: the PROPOSE may still be in flight or its
            // handler mid-await on the snapshot fetch. Buffer instead of
            // dropping (finding F7); replayed once pendingRounds is populated.
            if (!this.finalized.has(round)) this._bufferEarlyMessage(round, envelope);
            else noteDrop({ reason: 'round_torn_down', phase: 'prepare', round, sender: envelope.sender, envelope });
            return;
        }
        if (pending.digest !== digest) {
            noteDrop({ reason: 'digest_mismatch', phase: 'prepare', round, sender: envelope.sender, envelope });
            return;
        }

        this._addVote(pending.prepares, envelope);
        if (sig_pubkey && sig) this._verifyAndStoreSig(pending, sig_pubkey, sig);
        this._checkPrepareQuorum(round);
    }

    _handleCommit(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!Number.isInteger(round) || round < 0 || !digest) return;   // round 0 is valid (see _handlePropose)

        // Only count COMMIT votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'commit', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingRounds.get(round);
        if (!pending) {
            // Same early-arrival race as _handlePrepare (finding F7).
            if (!this.finalized.has(round)) this._bufferEarlyMessage(round, envelope);
            else noteDrop({ reason: 'round_torn_down', phase: 'commit', round, sender: envelope.sender, envelope });
            return;
        }
        if (pending.digest !== digest) {
            noteDrop({ reason: 'digest_mismatch', phase: 'commit', round, sender: envelope.sender, envelope });
            return;
        }

        this._addVote(pending.commits, envelope);
        if (sig_pubkey && sig) this._verifyAndStoreSig(pending, sig_pubkey, sig);
        this._checkCommitQuorum(round);
    }

    // Whether the round has cleared quorum. STAKE_WEIGHTED_QUORUM tallies the
    // SUMMED STAKE (source-deduped, >2/3 of S) of validators that have produced a
    // valid signature on the canonical (keyed on `pending.signatures`), which is
    // exactly the signer set the indexer re-verifies (actions/price.js). A value
    // cannot finalize without >2/3 stake having signed it, so the published PRICE
    // always clears the indexer's identical weighted gate. Below activation: the
    // count of the passed vote set against the locked quorum.
    _quorumMet(pending, voteSet) {
        if (pending.weighted)
            return swq.meetsStakeThreshold(pending.validators, [...pending.signatures.keys()]);
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
        // Count-mode quorum tallies DISTINCT MEMBER KEYS. The quorum above is sized
        // from the snapshot's qualified set, so a vote from a key with no qualifying
        // stake must not count toward it. Null memberPubkeys keeps the raw count
        // (graceful degradation, matching the quorum fallback).
        return this._countDistinctMembers(pending, voteSet) >= quorum;
    }

    // Distinct qualified MEMBER-KEY tally for one of the round's vote sets. The
    // sets already hold proven signing keys (one entry per key however many
    // senders it named), so this only has to intersect them with the round's
    // snapshot membership. Null memberPubkeys (no usable snapshot) degrades to the
    // raw count, matching the quorum fallback. Defined once so the finalization
    // tally and the validator_count recorded beside it cannot drift.
    _countDistinctMembers(pending, voteSet) {
        if (!voteSet) return 0;
        if (!pending || !pending.memberPubkeys) return voteSet.size;
        let counted = 0;
        for (let pk of voteSet) {
            if (pending.memberPubkeys.has(pk)) counted++;
        }
        return counted;
    }

    _checkPrepareQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        // Use the round's locked quorum (snapshot at the block boundary),
        // not a live recompute, to keep every hub in lockstep across the round.
        if (this._quorumMet(pending, pending.prepares) && !pending._commitSent) {
            pending._commitSent = true;
            let selfPk = this._selfPubkey();
            if (selfPk) pending.commits.add(selfPk);

            // Include this validator's signature in the COMMIT message so late-joining nodes
            // can collect signatures from any of the three phases (PROPOSE, PREPARE, COMMIT)
            let mySig = this._signPriceV0(round, pending.btcBlockTime, pending.prices, pending.btcBlockHeight);
            if (mySig && !pending.signatures.has(mySig.pubkey)) {
                pending.signatures.set(mySig.pubkey, mySig.sig);
            }

            this.peerManager.broadcast(ORACLE_COMMIT, {
                round:      round,
                digest:     pending.digest,
                sig_pubkey: mySig ? mySig.pubkey : null,
                sig:        mySig ? mySig.sig    : null
            });

            this._checkCommitQuorum(round);
        }
    }

    _checkCommitQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        // Same quorum rule as _checkPrepareQuorum (see _quorumMet).
        if (this._quorumMet(pending, pending.commits)) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);
            // Fire-and-forget (mirrors the prior promise-chain behavior); durability,
            // retry, and re-drive-on-failure live in _finalizeCommittedRound.
            this._finalizeCommittedRound(round);
        }
    }

    // Persist a quorum-finalized round's snapshot, then mark finalized + emit
    // round:finalized. A round reaching commit quorum carries collected validator
    // signatures, so a transient DB error while storing MUST NOT silently drop it
    // (the prior code deleted pending + tracking in the .catch with no retry and no
    // durable record, leaving pending.finalized already true so replayed COMMITs
    // could never re-finalize; the round evaporated on a one-off DB hiccup). Retry
    // the store a bounded number of times; only on durable success do we _markFinalized,
    // delete round state, and emit. If every attempt fails we do NOT delete round state
    // and we RESET pending.finalized=false, so a later replayed COMMIT re-enters
    // _checkCommitQuorum and re-drives finalization instead of the round being lost.
    async _finalizeCommittedRound(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending) return;

        // Record the endorsement breadth the round actually finalized on: distinct
        // qualified member pubkeys, the same tally _quorumMet counts, not the raw
        // addr-keyed prepare set. A key registered under two addrs (or a registered
        // non-member whose PREPARE joined the set but never the quorum) inflated the
        // persisted, mirrored and API-served validator_count above the endorsers that
        // cleared quorum (item 4941).
        let validatorCount = this._countDistinctMembers(pending, pending.prepares);
        let proof = JSON.stringify([...pending.commits]);

        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await this._storeSnapshot(round, pending.prices, validatorCount, proof,
                    pending.btcBlockHeight, pending.btcBlockTime);

                // Persistence succeeded: now (and only now) it is safe to finalize and
                // drop the in-memory round state.
                this._markFinalized(round);
                this.pendingRounds.delete(round);
                this._clearRoundTracking(round);
                console.log('Oracle: Round ' + round + ' finalized (' +
                    pending.prepares.size + ' prepares, ' +
                    pending.commits.size + ' commits)' +
                    (attempt > 1 ? ' after ' + attempt + ' store attempts' : ''));

                // Convert collected signatures to the [{pubkey, sig}, ...] array format used by OraclePublisher
                let sigsArray = [];
                for (let [pubkey, sig] of pending.signatures) {
                    sigsArray.push({ pubkey: pubkey, sig: sig });
                }

                this.emit('round:finalized', {
                    round:          round,
                    btcBlockHeight: pending.btcBlockHeight,
                    btcBlockTime:   pending.btcBlockTime,
                    prices:         pending.prices,
                    // SIGNING KEYS, not addrs: the reward/slash consumer pays by key,
                    // so a validator the chain attributes but the registry never saw
                    // is payable for the round it just helped finalize.
                    participants:   [...pending.prepares],
                    signatures:     sigsArray,
                    submissions:    this.oracleRound.getSubmissions(round)
                });
                return;
            } catch (err) {
                console.error('Oracle: Error storing snapshot for round %s (attempt %d/%d):', round, attempt, maxAttempts, err.message);
                if (attempt < maxAttempts) {
                    // Linear backoff between retries for a transient DB hiccup.
                    await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    // The shared tree could have been cleared out from under us by a
                    // concurrent path; bail if the round is gone.
                    if (!this.pendingRounds.has(round)) return;
                }
            }
        }

        // Every store attempt failed. Do NOT delete round state and do NOT leave
        // pending.finalized=true: resetting it lets a subsequent replayed COMMIT
        // re-enter _checkCommitQuorum and re-drive finalization once the DB recovers,
        // rather than the quorum-signed round being silently and permanently dropped.
        console.error('Oracle: Round ' + round + ' snapshot store failed after ' +
            maxAttempts + ' attempts; retaining round state and re-driving on a timer ' +
            '(round NOT dropped).');
        let stillPending = this.pendingRounds.get(round);
        if (!stillPending) return;
        stillPending.finalized = false;
        this._armFinalizeRetry(round, stillPending);
    }

    // Re-drive a stalled finalize on our OWN timer, so a quorum-signed round self-heals when
    // the DB comes back (item 4281). Resetting finalized=false above only makes the round
    // re-drivable BY A PEER, and each peer broadcasts COMMIT exactly once behind
    // pending._commitSent (_checkPrepareQuorum), so nothing is guaranteed to arrive: with the
    // eviction timer already cleared at commit quorum and no sweep over pendingRounds, a DB
    // outage outlasting the bounded retry above stranded the round in memory forever,
    // unpersisted and unpublished.
    //
    // Reuses the pending.timer slot so stop() and a later _checkCommitQuorum both tear this
    // down, and clears first so a round can never hold two outstanding retries.
    _armFinalizeRetry(round, pending) {
        let delay = Math.min((pending._finalizeRetryMs || 0) * 2 || FINALIZE_RETRY_BASE_MS,
                             FINALIZE_RETRY_MAX_MS);
        pending._finalizeRetryMs = delay;
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
            let p = this.pendingRounds.get(round);
            // Bail when another path already finished the round, or one is mid-flight:
            // finalized=true is exactly the in-flight claim _checkCommitQuorum makes.
            if (!p || p.finalized || this.finalized.has(round)) return;
            // Make the same claim before re-entering, so a peer COMMIT landing now cannot
            // start a second finalize and emit round:finalized twice.
            p.finalized = true;
            Promise.resolve(this._finalizeCommittedRound(round)).catch(err =>
                console.error('Oracle: re-finalize of round %s threw:', round, err && err.message));
        }, delay);
        // Never hold the process open on a retry that may re-arm indefinitely; stop() is
        // what tears it down on a clean shutdown.
        if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
        console.warn('Oracle: re-finalize of round ' + round + ' scheduled in ' + delay + 'ms');
    }

    _aggregateAll(submissions) {
        if (!submissions) return [];   // no submission map for this round (guard: for..of undefined throws)
        let coinPairs = new Set();
        for (let [sender, sub] of submissions) {
            if (sub.prices && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (p.coinPair) coinPairs.add(p.coinPair);
                }
            }
        }

        let results = [];
        for (let pair of coinPairs) {
            let price = this._aggregate(submissions, pair);
            if (price !== null) {
                results.push({ coinPair: pair, price: price });
            }
        }
        // Emit in canonical pair order rather than coinPairs Set
        // insertion order (first-seen across submissions, i.e. a function of
        // arrival order). The per-pair VALUES were already order-invariant; the
        // ARRAY was not, and this array is what gets propagated on PROPOSE and
        // stored in price_snapshots, so two hubs with identical prices produced
        // different bytes for the same round. _digest canonicalizes its own
        // preimage independently (defence in depth for wire payloads this
        // method did not build), and _buildPriceV0Payload already sorted; this
        // makes the propagated and stored array agree with both.
        return results.sort((a, b) => {
            if (a.coinPair < b.coinPair) return -1;
            if (a.coinPair > b.coinPair) return 1;
            return 0;
        });
    }

    // Aggregate a single coin pair using trimmed median
    _aggregate(submissions, coinPair) {
        if (!submissions) return null;
        // Collect all prices for this pair. Keep the original string `s` alongside a
        // float `f` used only for ordering. The median value itself is computed in
        // bignumber (bcmath) per the platform's bignumber mandate, so the
        // signed aggregate carries no float/`.toFixed` rounding artifact.
        let values = [];
        for (let [sender, sub] of submissions) {
            if (sub.prices && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (p.coinPair === coinPair && p.price) {
                        let val = parseFloat(p.price);
                        if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                            values.push({ f: val, s: String(p.price) });
                            // Cap each sender at one data point per pair. A
                            // submission could contain N entries for the same
                            // pair; counting them all would inflate values.length
                            // and shift the trim boundary, letting an outlier
                            // survive. Stop after the first valid value.
                            break;
                        }
                    }
                }
            }
        }

        if (values.length === 0) {
            // Surface the drop (item #180): without this line a pair whose every
            // submission fails the >0 / <PRICE_MAX clamp (or is absent) vanishes
            // from the round with no signal at all.
            console.warn('Oracle: dropping ' + coinPair + ' this round: no usable submission '
                + 'values (all missing, non-numeric, or outside the price clamp)');
            return null;
        }

        // Sort ascending (ordering only; float compare is fine here)
        values.sort((a, b) => a.f - b.f);

        // Trim top and bottom 15%. Use Math.ceil so at least one value is trimmed
        // once N >= 4 (Math.floor yields 0 for all N <= 6, making the trim a no-op
        // in small federations and leaving a single in-bounds outlier able to shift
        // a 2-source median by ~50%).
        let trimCount = Math.ceil(values.length * TRIM_PERCENT);
        if (trimCount > 0 && values.length > 2 * trimCount) {
            values = values.slice(trimCount, values.length - trimCount);
        }

        // Defensive: the slice above always leaves >= 1 value when it runs, but
        // if trimming ever empties the array, surface the drop instead of
        // silently omitting the pair (item #180).
        if (values.length === 0) {
            console.warn('Oracle: dropping ' + coinPair + ' this round: trimming emptied the value set');
            return null;
        }

        let mid = Math.floor(values.length / 2);

        // Even-split deviation gate (items 4496, 5333). An even-length set has no real
        // median: the aggregate below is the MEAN of the two middle values, so a two-camp
        // feed disagreement publishes a price NO submitter stands behind. The sort leaves
        // nothing between values[mid-1] and values[mid], so every value sits at or beyond
        // one of them and the CLOSEST submitter's deviation from that mean is exactly
        // (hi - lo) / (hi + lo). Refuse to publish the pair once that exceeds
        // ORACLE_DEVIATION_THRESHOLD, i.e. once the mean would put every submitter outside
        // the band. That matches SlashDetector's default band (it defaults to this same
        // ORACLE_DEVIATION_THRESHOLD and fail-fasts on a tighter override), so we never
        // federation-sign a price we would then slash; the pair is simply omitted this
        // round and consumers hold the last snapshot.
        // The gate runs AFTER the trim, not before it (item 5333). A raw-count-only N==2
        // check missed every set the ceil-trim REDUCES to an even split - N=4 leaves 2
        // values, N=6 and N=8 leave 4 - and there the leader published the unbackable mean
        // while every honest follower, re-deriving over the proposer-excluded (odd) set,
        // landed on a single camp value, tripped the co-sign band in _handlePropose and
        // rejected the WHOLE proposal, so one pair's disagreement wedged the entire round
        // in the finalization timeout with no skipped-round row. A 2-value set is never
        // trimmed (values.length > 2 * trimCount is false at N=2), so this placement
        // strictly subsumes the old raw N==2 check rather than adding a second gate.
        // Shared deviation_band helper: (hi-lo)/(hi+lo), no rounded intermediate mean.
        // Scale 18, NOT the original inline scale 8: the co-sign gate (_handlePropose) and
        // SlashDetector both round at 18, so a scale-8 publish gate truncates a boundary
        // spread back inside the band and federation-signs a price the other two gates then
        // withhold or slash. Uses the hardcoded constant (not an env value) and bignumber
        // math so every hub gates identically.
        // CONSENSUS-CRITICAL: deploy fleet-wide atomically.
        if (values.length % 2 === 0) {
            let lo = values[mid - 1].s, hi = values[mid].s; // sorted ascending, both > 0
            if (devband.twoSourceSpreadExceeds(lo, hi, ORACLE_DEVIATION_THRESHOLD, 18)) {
                console.warn('Oracle: dropping ' + coinPair + ' this round: the two middle values '
                    + 'disagree beyond the ' + (ORACLE_DEVIATION_THRESHOLD * 100) + '% mean-deviation gate ('
                    + lo + ' vs ' + hi + '), so the published mean would put every submitter outside the band');
                return null;
            }
        }

        // Compute median in bignumber (no float midpoint average / .toFixed artifact)
        let median;
        if (values.length % 2 === 0) {
            median = bcmath.bcformat(bcmath.bcdiv(bcmath.bcadd(values[mid - 1].s, values[mid].s, 8), '2', 8), 8);
        } else {
            median = bcmath.bcformat(values[mid].s, 8);
        }
        return this._clampToLastFinalized(coinPair, median);
    }

    // Per-pair bounded-change clamp. The trim + median above bound what a
    // MINORITY of bad feeds can do; nothing bounds the aggregate itself, so a real
    // fat-tail print (or a majority of correlated bad sources) still lands in one
    // round and immediately drives USD-pegged fee math. Bound the finalized price's
    // per-round movement to ORACLE_MAX_CHANGE_PER_ROUND relative to the pair's last
    // FINALIZED snapshot: a genuine sustained move walks to the new level over a few
    // rounds (cache updates each finalized round), a one-round spike is absorbed.
    // Federation-uniform ARITHMETIC, converging reference: the bound and the formula are
    // identical on every hub, and _lastFinalizedPrices is derived from price_snapshots,
    // not from this process's finalize history (seeded at start, advanced by every
    // finalized round this hub stores, folded from the push-ingest stream, and re-seeded
    // on a timer). It is NOT identical by construction: a hub that missed the round its
    // peers just finalized clamps against an older reference until one of those writers
    // catches it up, so two hubs can straddle a finalization for up to one re-seed
    // interval (item 5834; closing the window entirely is a separate, deliberate
    // round-aligned change). No history (brand-new pair, cold standalone cache) means no
    // clamp; the unverifiable-pair gate covers that case on the co-sign side.
    // CONSENSUS-CRITICAL: deploy fleet-wide atomically.
    _clampToLastFinalized(coinPair, price) {
        let last = this._getLastFinalizedPrice(coinPair);
        if (last === null || !bcmath.bcgt(last, '0')) return price;
        let pct = maxChangeForPair(coinPair);
        let maxDelta = bcmath.bcmul(last, String(pct), 8);
        let hi = bcmath.bcadd(last, maxDelta, 8);
        let lo = bcmath.bcsub(last, maxDelta, 8);
        if (bcmath.bcgt(price, hi)) {
            console.warn('Oracle: clamping ' + coinPair + ' aggregate ' + price + ' to ' +
                bcmath.bcformat(hi, 8) + ' (last finalized ' + last + ', max +' +
                (pct * 100) + '%/round)');
            return bcmath.bcformat(hi, 8);
        }
        if (bcmath.bclt(price, lo)) {
            console.warn('Oracle: clamping ' + coinPair + ' aggregate ' + price + ' to ' +
                bcmath.bcformat(lo, 8) + ' (last finalized ' + last + ', max -' +
                (pct * 100) + '%/round)');
            return bcmath.bcformat(lo, 8);
        }
        return price;
    }

    async _storeSnapshot(round, prices, validatorCount, proof, btcBlockHeight, btcBlockTime) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        if (!prices || prices.length === 0) return;

        // Mirror the round's `price` validator set into capability_snapshots at the
        // round's BTC anchor, BEFORE the round's own rows land.
        //
        // Capability staking is BTC-only at the protocol level (coins/DOGE.js and
        // coins/LTC.js declare CAPABILITIES: {}), so a non-BTC indexer resolves the
        // price-capable set from the hub-mirrored capability_snapshots or not at all.
        // Nothing on the oracle path ever wrote a `price` row: finalizeRound and
        // _handlePropose resolve the set through CapabilitySnapshot, which is a cached
        // RPC read against the BTC indexer and persists nothing. The mirror therefore
        // carried only cross_chain and oracle_publish rows, and every PRICE action
        // published off BTC resolved an EMPTY set, summed to zero stake and recorded
        // 'invalid: insufficient signer stake' with signatures that all verify.
        //
        // EVERY hub persists, not just the leader: an indexer verifies a PRICE action
        // against capability_snapshots in whichever hub DB it mirrors, and a follower's
        // DB may be the only one it reads. Deterministic from the BTC stakes at the
        // anchor plus INSERT IGNORE, so every hub writes identical rows and a re-finalize
        // of the same round is a no-op (same idempotency contract as the cross_chain and
        // oracle_publish writers).
        //
        // Ordered first, and fail-closed by throwing, for the reason StateCheckpointEngine
        // states for its oracle_publish persist: a mirror subscriber must never receive a
        // quorum-signed row it cannot verify. A throw here skips the price_snapshots
        // INSERT and its broadcast entirely; _finalizeCommittedRound's retry loop then
        // retains the round and re-drives it, and OracleRound's finalizeRound .catch logs
        // the single-node path.
        //
        // referenceBlock is the same value the round resolved its snapshot at
        // (finalizeRound's btcBlockHeight, threaded through pending.btcBlockHeight), so
        // every chain's indexer reads the SAME snapshot block for the same round. Never
        // the local processing height.
        await this._persistCapabilitySnapshot('price', referenceBlock);

        // Write the whole round in ONE multi-row INSERT (mirrors db.setParams) so the
        // round lands atomically. The per-pair loop this replaced let a getfeequote /
        // getpricesnapshots reader observe a torn round (some pairs from round N, others
        // from N-1) mid-loop, and the id-ordered mirror bootstrap could persist that torn
        // read to a replica. The hub Database exposes no transaction API, so a single
        // statement is the atomicity primitive here.
        let placeholders = prices.map(() => "(?, ?, ?, ?, 'BTC', ?, ?, 1, ?, 'finalized')").join(', ');
        let params = [];
        for (let p of prices) params.push(round, p.coinPair, p.price, referenceBlock, blockTimestamp, validatorCount, proof);
        let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE price = VALUES(price), reference_block = VALUES(reference_block),
                 block_timestamp = VALUES(block_timestamp), validator_count = VALUES(validator_count),
                 consensus_proof = VALUES(consensus_proof), status = 'finalized'`;
        await this.db.doQuery(query, params);

        // Durable per-pair skip markers (item #180). A pair can drop out of a
        // round that otherwise finalizes (aggregation clamp/deviation-gate/trim
        // returns null, or the leader simply didn't propose it); before this,
        // that pair got neither a 'finalized' nor a 'skipped' row, so consumers
        // silently fell back to the previous round with no observable signal.
        // Write a 'skipped' row (same shape as _storeSkippedRound) for every
        // configured pair absent from the finalized set, so the drop is durable,
        // countable, and visible to getSubmissionsInfo/dashboard health. This is
        // derived from the finalized proposal + local pair config, so every hub
        // writes the same rows deterministically. Best-effort: never fail the
        // finalized write over the marker.
        try {
            let finalizedPairs = new Set(prices.map(p => p.coinPair));
            let missingPairs = this._markerPairs(round).filter(pair => !finalizedPairs.has(pair));
            if (missingPairs.length) {
                console.warn('Oracle: round ' + round + ' finalized without ' + missingPairs.length
                    + ' configured pair(s): ' + missingPairs.join(', ')
                    + '; recording per-pair skipped snapshot(s)');
                let skipPlaceholders = missingPairs.map(() => "(?, ?, NULL, ?, 'BTC', ?, 0, 1, '[]', 'skipped')").join(', ');
                let skipParams = [];
                for (let pair of missingPairs) skipParams.push(round, pair, referenceBlock, blockTimestamp);
                await this.db.doQuery(`INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                     validator_count, consensus_round, consensus_proof, status)
                    VALUES ${skipPlaceholders}
                    ON DUPLICATE KEY UPDATE
                     reference_block = IF(status = 'skipped', VALUES(reference_block), reference_block),
                     block_timestamp = IF(status = 'skipped', VALUES(block_timestamp), block_timestamp),
                     status = IF(status = 'skipped', 'skipped', status)`, skipParams);
            }
        } catch (e) {
            console.error('Oracle: error recording per-pair skipped snapshot(s) for round %s:', round, e.message);
        }

        // Update the in-memory last-finalized-price cache so the co-sign gate in
        // _handlePropose can apply a historical-deviation check for pairs a hub
        // did not price locally in the current round (seq 4083).
        // Retain the reference THIS round's aggregate clamped against, before the round
        // being stored overwrites it. SlashDetector needs it to tell a pair the clamp
        // actually moved from one it did not (item 5833); nothing is added to
        // round:finalized and no wire format changes, so evidence bodies and their
        // hashes are byte-identical. One round is kept, replaced on the next store.
        this._clampReference = { round: round, prices: new Map(this._lastFinalizedPrices || []) };
        this._updateLastFinalizedPrices(prices, round);

        // Broadcast the finalized rows to hub-DB mirror subscribers (distributed indexers),
        // mirroring StateCheckpointEngine/CrossChainDexEngine. This must happen AFTER the
        // atomic write so a subscriber never sees a partial round. Without this the round
        // is written via a bare INSERT that emits nothing, so a replica's price mirror never
        // receives it live and _priceSyncSatisfied passes while the round is absent, causing
        // the replica to validate native-coin fees against the prior round (ledger divergence).
        // Never block finalize, but never SWALLOW a failure either: the watermark heartbeat
        // advances on its own wall-clock timer and would certify the stream complete past a
        // round no subscriber ever received, re-opening the exact divergence this broadcast
        // closes. A failed re-read therefore drops the subscribers so each one reconnects and
        // its bootstrap max-id gap detection re-drains the round (item 4459).
        if (this.hub && this.hub.hubDbBroadcaster) {
            try {
                let rows = await this.db.doQuery(
                    'SELECT * FROM price_snapshots WHERE round_number=? ORDER BY coin_pair', [round]);
                for (let row of rows) this.hub.hubDbBroadcaster.broadcastRow({ table: 'price_snapshots', row });
            } catch (e) {
                console.error('Oracle: post-commit price-round broadcast failed for round ' + round
                    + '; forcing subscriber resync: ' + (e && e.message));
                try { this.hub.hubDbBroadcaster.dropAllForResync('price-round broadcast gap'); }
                catch (err) { /* the repair itself must not fail finalize */ }
            }
        }
    }

    // Resolve the qualifying validator set for `capability` at a BTC block, normalized to
    // { pubkey, source, weight, amount }. Same shape and same activation gate as
    // StateCheckpointEngine/CrossChainDexEngine._resolveCapabilityValidators: at/above
    // STAKE_WEIGHTED_QUORUM activation (keyed on the BTC block + this hub's network) the
    // SOURCE-KEYED weights, below it the legacy count set (source='', weight=amount), so
    // the rows this hub mirrors match the rows those engines mirror for the same block.
    // A degraded snapshot (indexer RPC error / auth mismatch surfaces as null) normalizes
    // to [], which persists nothing rather than inventing membership.
    async _resolveCapabilityValidators(capability, block) {
        let validators = [];
        let capSnapshot = this.hub ? this.hub.capabilitySnapshot : null;
        if (!capSnapshot) return validators;
        let weighted = swq.isStakeWeightedQuorumActive(block, this.hub.network);
        if (weighted) {
            let snap = await capSnapshot.getWeightSnapshot(capability, block);
            if (snap && Array.isArray(snap.validators)) {
                validators = snap.validators.map(v => ({
                    pubkey: v.pubkey,
                    source: String(v.source != null ? v.source : ''),
                    weight: String(v.weight != null ? v.weight : '0'),
                    amount: String(v.weight != null ? v.weight : '0')
                }));
                // Carry the truncation marker through the .map so the persist below can
                // refuse an over-cap set (SWQ-TRUNC parity with the other writers).
                if (snap.truncated === true) validators.truncated = true;
            }
        } else {
            let snap = await capSnapshot.getSnapshot(capability, block);
            if (snap && Array.isArray(snap.validators))
                validators = snap.validators.map(v => ({
                    pubkey: v.pubkey,
                    source: '',
                    weight: String(v.amount != null ? v.amount : '0'),
                    amount: String(v.amount != null ? v.amount : '0')
                }));
        }
        return validators;
    }

    // Persist the qualifying validator set for `capability` at `block` to
    // capability_snapshots (idempotent) and mirror each row to hub-DB subscribers.
    // Returns the number of rows resolved (and persisted) for this (capability, block);
    // 0 means the set degraded to empty or was refused as truncated.
    //
    // Byte-for-byte the same write and select-back as
    // StateCheckpointEngine/CrossChainCallEngine._persistCapabilitySnapshot: INSERT IGNORE
    // on the natural key is the idempotency primitive (all hubs write identical rows for a
    // block, and a replayed round re-writes nothing), and the select-back keys on the full
    // widened uq_cap_snap (block, capability, pubkey, SOURCE) because a pubkey delegated by
    // two sources has two rows and a pubkey-only LIMIT 1 re-read would stream only one.
    async _persistCapabilitySnapshot(capability, block) {
        let validators = await this._resolveCapabilityValidators(capability, block);
        // SWQ-TRUNC-MIRROR: never mirror a TRUNCATED set. The `.truncated` marker is what
        // fails this hub's own meetsStakeThreshold closed, but it is a JS array property
        // with no capability_snapshots column behind it, so persisting the capped rows
        // would hand an off-BTC verifier a partial set it reads back as COMPLETE and let it
        // clear a 2/3 bar over an under-counted stake denominator this hub itself rejects.
        // Writing nothing leaves the mirror empty, so that read yields S=0 and fails closed
        // through the same predicate as everything else. Keep this in lockstep with the
        // other capability_snapshots writers.
        if (validators && validators.truncated === true) {
            console.warn('Oracle: refusing to persist a TRUNCATED ' + capability +
                ' capability snapshot at block ' + block +
                ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        // One statement for the whole set: a per-row loop left the mirror PARTIAL on any
        // single INSERT throw, and a partial set has no completeness marker so a verifier
        // reads it as COMPLETE. Rationale in lib/capability_snapshot_write.js. Parity with
        // StateCheckpointEngine and the other four writers.
        let rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        for (let row of rows) {
            if (this.hub && this.hub.hubDbBroadcaster) {
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [block, capability, row.signing_pubkey, row.source]);
                if (r.length) this.hub.hubDbBroadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    // item 3521 - the pair set the per-pair drop markers are written over. It must
    // track the ADMISSION set (OracleRound.canonicalPairs = the 36 API pairs plus
    // DERIVED_PAIRS), not getCoinPairs() alone, or the one pair produced by derivation
    // rather than fetch is the sole pair that can vanish with no durable trace: no
    // status='skipped' row, nothing in getSubmissionsInfo().droppedPairs, and the
    // stale prior snapshot still reading alive. DERIVED_PAIRS joins only when the
    // XCHAIN activation gate is open FOR THIS ROUND, since below the gate the pair was
    // never due and a skip row would be noise. The gate is round-keyed, not
    // currentRound-keyed: the stored round may already be behind. Fails closed the same
    // way the composition gate does, so an unreachable OracleRound narrows the marker
    // set back to the fetched pairs rather than inventing a row.
    _markerPairs(round) {
        let pairs = PriceFetcher.getCoinPairs();
        try {
            if (this.oracleRound && typeof this.oracleRound._xchainPriceGateOpenFor === 'function'
                && this.oracleRound._xchainPriceGateOpenFor(round))
                return [...pairs, ...DERIVED_PAIRS];
        } catch (e) { /* fail closed to the fetched pairs */ }
        return pairs;
    }

    // reason: short string describing why the round was skipped ('no submissions',
    // 'below minimum submissions threshold', etc.); surfaced in the skip log so
    // operators can tell a full outage apart from a quorum shortfall.
    async _storeSkippedRound(round, btcBlockHeight, btcBlockTime, reason) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        let coinPairs = this._markerPairs(round);
        // One multi-row INSERT so the skipped round lands atomically (same torn-read
        // rationale as _storeSnapshot).
        if (coinPairs.length) {
            let placeholders = coinPairs.map(() => "(?, ?, NULL, ?, 'BTC', ?, 0, 1, '[]', 'skipped')").join(', ');
            let params = [];
            for (let pair of coinPairs) params.push(round, pair, referenceBlock, blockTimestamp);
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                 reference_block = IF(status = 'skipped', VALUES(reference_block), reference_block),
                 block_timestamp = IF(status = 'skipped', VALUES(block_timestamp), block_timestamp),
                 status = IF(status = 'skipped', 'skipped', status)`;
            await this.db.doQuery(query, params);
        }
        // Broadcast the skipped-round rows to hub-DB mirror subscribers, mirroring
        // _storeSnapshot. Both insert paths into the mirrored price_snapshots table must
        // feed HubDbBroadcaster or a live streaming mirror never receives the skipped
        // rows (it gets them only on the next re-bootstrap), diverging from a
        // freshly-bootstrapped mirror. Best-effort; never block finalize.
        if (coinPairs.length && this.hub && this.hub.hubDbBroadcaster) {
            try {
                let rows = await this.db.doQuery(
                    'SELECT * FROM price_snapshots WHERE round_number=? ORDER BY coin_pair', [round]);
                for (let row of rows) this.hub.hubDbBroadcaster.broadcastRow({ table: 'price_snapshots', row });
            } catch (e) { /* broadcast is best-effort */ }
        }
        // #7: mark as LOCALLY skipped, not finalized, so a legitimate later PROPOSE
        // from the federation still processes and can upgrade the 'skipped' rows to
        // 'finalized'. _markFinalized would have frozen this round's NULL price here.
        this._markLocallySkipped(round);
        this._clearRoundTracking(round);
        console.log('Oracle: Round ' + round + ' skipped (' + (reason || 'no submissions') + ')');
    }

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/ed25519.js buildPriceV0Payload exactly so signatures
    // produced here verify against the same canonical bytes when indexers parse on-chain PRICE v0 actions.
    _buildPriceV0Payload(round, btcBlockTime, prices, btcBlockHeight) {
        let pairs = prices.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
        let sortedPairs = [...pairs].sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        let raw = JSON.stringify({
            round:            parseInt(round),
            timestamp:        parseInt(btcBlockTime),
            btc_block_height: parseInt(btcBlockHeight),
            pairs:            sortedPairs
        });
        // EQUIV header (WI-2 bump 2): gated on the round's BTC block HEIGHT + the hub's
        // network, byte-matching ed25519.buildPriceV0Payload. The height is in the signed
        // content and the on-chain wire so every indexer reconstructs identical bytes and
        // flips on the same anchor every other engine uses (#4232). XORACLE has no view ->
        // VIEW=0; ROUND_ID is the BTC height (the real activation anchor).
        if (eq.isEquivHeaderActive(btcBlockHeight, this.hub && this.hub.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parseInt(btcBlockHeight), 0, raw);
        return raw;
    }

    // Build the canonical signable payload for a PRICE batch: ONE signature set over
    // several rounds. THIS IS THE PRODUCER; xchain-indexer/src/ed25519.js
    // buildPriceBatchPayload and PriceAggregator._buildPriceBatchPayload must match it byte for
    // byte, or the bytes signed here are not the bytes any verifier checks.
    //
    // `rounds` is [{ round, timestamp, btcBlockHeight, pairs }] and each `pairs` entry is
    // { pair | coinPair, price }, the same shapes the v0 producer already normalizes. The
    // builder sorts the rounds ascending and normalizes each round's pairs itself rather
    // than requiring sorted input, so no caller of the three twins can get the ordering
    // contract subtly wrong.
    //
    // The EQUIV header is UNCONDITIONAL here, unlike _buildPriceV0Payload's height gate.
    // v0 gates because it has pre-flag-day history whose bytes may not move; v2 has none
    // (it is ungated and every network it runs on already has EQUIV active). The
    // unwrapped bare-JSON form is also the exact
    // shape that breaks SLASH's "an ORACLE-tagged canonical always carries `round`"
    // invariant, which is why v2 carries its own engine tag. Do NOT "fix" this into a
    // v0-style gate.
    _buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds) {
        let sortedRounds = [...rounds]
            .sort((a, b) => parseInt(a.round) - parseInt(b.round))
            .map(r => {
                let pairs = r.pairs.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
                let sortedPairs = [...pairs].sort((a, b) => {
                    if (a.pair < b.pair) return -1;
                    if (a.pair > b.pair) return 1;
                    return 0;
                });
                return {
                    round:            parseInt(r.round),
                    timestamp:        parseInt(r.timestamp),
                    btc_block_height: parseInt(r.btcBlockHeight),
                    pairs:            sortedPairs
                };
            });
        let raw = JSON.stringify({
            first_round:      parseInt(firstRound),
            last_round:       parseInt(lastRound),
            btc_block_height: parseInt(btcBlockHeight),
            rounds:           sortedRounds
        });
        // ROUND_ID carries the batch anchor AND the round window: two honest batches that
        // split one window differently at the same anchor must not land on one equiv key,
        // which would read as equivocation. XORACLEB has no view change -> VIEW=0.
        let roundId = String(parseInt(btcBlockHeight)) + '|' +
                      String(parseInt(firstRound))     + '|' +
                      String(parseInt(lastRound));
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, roundId, 0, raw);
    }

    // Sign the canonical PRICE v0 payload with the local validator identity
    // Returns { pubkey, sig } or null if no identity is configured
    _signPriceV0(round, btcBlockTime, prices, btcBlockHeight) {
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (!identity) return null;
        try {
            let payload = this._buildPriceV0Payload(round, btcBlockTime, prices, btcBlockHeight);
            let sigHex  = identity.sign(payload);
            return { pubkey: identity.getPubkeyHex(), sig: sigHex };
        } catch (e) {
            console.warn('Oracle: failed to sign PRICE v0 payload:', e);
            return null;
        }
    }

    // Verify a (pubkey, sig) pair against the pending round's canonical PRICE v0 payload,
    // and store it on the pending round's signatures map if valid.
    // The pending object must have a `round` field set when it's created.
    _verifyAndStoreSig(pending, pubkeyHex, sigHex) {
        if (!pending || !pubkeyHex || !sigHex) return false;
        // Key the signatures map on LOWERCASE pubkey hex (item 5334). This was the one
        // wire-pubkey keying site in the engine that stored the value verbatim, while every
        // structure the map is read beside is normalized: pending.validators (:697/:1235),
        // _memberPubkeySet, _resolveSenderPubkey, and PriceAggregator's verifier of the same
        // PRICE v0 proof. Hex decoding is case-insensitive, so a peer sending 'AB..' hex
        // verified and then took a SECOND map slot beside its own 'ab..' entry, duplicating
        // that validator in the sigsArray this hub publishes on the wire. (The weighted
        // tally itself is unaffected: swq.meetsStakeThreshold lowercases both sides and
        // dedupes by source, so no stake was ever mis-counted.) Normalizing in the helper,
        // not at the three callers, keeps the invariant for any future caller.
        pubkeyHex = String(pubkeyHex).toLowerCase();
        if (pending.signatures.has(pubkeyHex)) return false; // already collected
        if (pending.round === undefined || pending.round === null) {
            console.warn('Oracle: cannot verify sig: pending round has no round number');
            return false;
        }
        try {
            let payload = this._buildPriceV0Payload(pending.round, pending.btcBlockTime, pending.prices, pending.btcBlockHeight);
            let ok = ValidatorIdentity.verify(payload, sigHex, pubkeyHex);
            if (ok) {
                pending.signatures.set(pubkeyHex, sigHex);
                return true;
            } else {
                console.warn('Oracle: invalid PRICE v0 signature from ' + pubkeyHex.substring(0, 16) + '... for round ' + pending.round);
                return false;
            }
        } catch (e) {
            console.warn('Oracle: signature verification error:', e);
            return false;
        }
    }

    // Return the most recently finalized price for a coin pair from price_snapshots,
    // or null if unavailable. Used by the co-sign gate to apply a historical-deviation
    // check for pairs this hub has no live local submission for (seq 4083).
    // Synchronous best-effort: reads from the in-memory cache populated by
    // _storeSnapshot. Falls back to null when not cached (first round, cold start).
    _getLastFinalizedPrice(coinPair) {
        if (!this._lastFinalizedPrices) return null;
        return this._lastFinalizedPrices.get(coinPair) || null;
    }

    // The round each cached reference came from, parallel to _lastFinalizedPrices
    // (Map<coin_pair, round>). Kept as a second map rather than boxing the value so
    // every existing reader of _lastFinalizedPrices still sees a plain price string.
    // Absent for an entry written without a round (see _noteFinalizedPrice).
    _lastFinalizedRoundFor(coinPair) {
        if (!this._lastFinalizedRounds) return null;
        let r = this._lastFinalizedRounds.get(coinPair);
        return Number.isFinite(r) ? r : null;
    }

    // Record one pair's finalized price, newest round wins. Returns true when the
    // entry moved. The cache means "the price from this pair's HIGHEST finalized
    // round", which is what _seedLastFinalizedPrices computes; before the stamp the
    // runtime writer disagreed with the seed, so a late _storeSnapshot for an older
    // round (a locally-skipped round stored by a late PROPOSE, a replayed COMMIT)
    // walked the reference BACKWARDS. An unstamped write is trusted as current, so
    // callers that have no round keep the prior set-always behaviour.
    _noteFinalizedPrice(coinPair, price, round) {
        if (!coinPair || price === null || price === undefined || price === '') return false;
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        if (!this._lastFinalizedRounds) this._lastFinalizedRounds = new Map();
        let r = Number(round);
        let stamped = Number.isFinite(r);
        let known = this._lastFinalizedRoundFor(coinPair);
        if (stamped && known !== null && r < known) return false;
        this._lastFinalizedPrices.set(coinPair, String(price));
        if (stamped) this._lastFinalizedRounds.set(coinPair, r);
        return true;
    }

    // Update the in-memory last-finalized-price cache after a round is stored.
    // Called at the end of _storeSnapshot. `round` is optional: the unit tests that
    // drive this directly, and any future caller without one, keep the unstamped
    // set-always behaviour. Rounds arriving by push come in through
    // noteIngestedPriceRow instead.
    _updateLastFinalizedPrices(prices, round) {
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        for (let p of prices) {
            if (p.coinPair && p.price) this._noteFinalizedPrice(p.coinPair, p.price, round);
        }
    }

    // The last-finalized reference `round`'s aggregate was clamped against, or null when
    // this hub did not store that round (so it holds no reference for it). Read by
    // SlashDetector to widen the deviation band on pairs the clamp actually moved.
    getClampReference(round) {
        if (!this._clampReference || this._clampReference.round !== round) return null;
        return this._clampReference.prices;
    }

    // Fold a finalized price_snapshots row from the hub's DB-mirror ingest stream into
    // the clamp reference. PriceAggregator.receiveValidatedRound writes finalized rows
    // for rounds pushed from a source chain and touched nothing else, so a hub that
    // ingests rather than finalizes never advanced its reference at all. Non-finalized,
    // priceless and older-round rows are ignored by the monotonic guard above.
    noteIngestedPriceRow(row) {
        if (!row || row.status !== 'finalized') return false;
        return this._noteFinalizedPrice(row.coin_pair, row.price, row.round_number);
    }

    // Record the first time we saw this round as ready to finalize. The
    // receiver-side leader-timeout grace in _handlePropose measures from here.
    // Opportunistically evicts entries for rounds that never finalized (the rare
    // stuck case) so the map can't grow unbounded.
    _markRoundReady(round) {
        let now = Date.now();
        let ttl = this.finalizationTimeout * 2 + this.leaderTimeout;
        for (let [r, ts] of this.roundReadyAt) {
            if (now - ts > ttl) this.roundReadyAt.delete(r);
        }
        if (!this.roundReadyAt.has(round)) this.roundReadyAt.set(round, now);
    }

    // Forget per-round leader-timeout bookkeeping once the round is done.
    _clearRoundTracking(round) {
        this.roundReadyAt.delete(round);
        let t = this.leaderTimers.get(round);
        if (t) {
            clearTimeout(t);
            this.leaderTimers.delete(round);
        }
        this._disarmRoundWatchdog(round);
    }

    // --- Round-abandonment watchdog ---

    // How long after a round opens here this hub waits before calling it lost.
    // Derived from the round's own timer ladder (leader timeout -> fallback grace
    // -> finalization window) plus slack, so it is always the LAST timer to fire
    // and never pre-empts a round that is still legitimately in flight.
    _roundAbandonMs() {
        return this.leaderTimeout + FALLBACK_GRACE_MS + this.finalizationTimeout
             + this.roundAbandonGraceMs;
    }

    // Arm the watchdog for a round this hub has observed OPEN: it saw a usable
    // submission set at the block boundary, or a peer's PROPOSE opened the round
    // here. Idempotent per round, and a no-op once the round already has a durable
    // outcome (finalized, or a skipped row already stored).
    //
    // btcBlockHeight/btcBlockTime are the round's real BTC anchor, carried so the
    // skipped row this may eventually write names the SAME (round, reference_block,
    // block_timestamp) every other hub writes. Re-deriving them at fire time would
    // stamp each hub's rows with its own wall clock and make the per-round presence
    // digests differ for a round every hub actually agreed on.
    _armRoundWatchdog(round, btcBlockHeight, btcBlockTime) {
        if (this.finalized.has(round) || this.locallySkipped.has(round)) return;
        if (this.roundWatchdogs.has(round)) return;
        let entry = {
            timer:          null,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            rearms:         0
        };
        this.roundWatchdogs.set(round, entry);
        this._scheduleRoundWatchdog(round, entry, this._roundAbandonMs());
    }

    _scheduleRoundWatchdog(round, entry, delay) {
        entry.timer = setTimeout(() => this._onRoundAbandoned(round), delay);
        // A watchdog must never be the reason the process stays alive; stop() is
        // what tears it down on a clean shutdown, matching the leader timers.
        if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    }

    _disarmRoundWatchdog(round) {
        let entry = this.roundWatchdogs.get(round);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        this.roundWatchdogs.delete(round);
    }

    // The round opened here and never reached a durable outcome. Write the skipped
    // record so this hub's absence of a snapshot is a stated fact rather than a
    // hole, and so hub-to-hub presence comparison (getoracleroundpresence) can tell
    // "we all lost this round" apart from "this hub never saw it".
    _onRoundAbandoned(round) {
        let entry = this.roundWatchdogs.get(round);
        if (!entry) return;
        if (this.finalized.has(round) || this.locallySkipped.has(round)) {
            this.roundWatchdogs.delete(round);
            return;
        }
        // Still in flight (a late PROPOSE re-opened it, or _armFinalizeRetry is
        // re-driving a quorum-signed round behind a DB stall). Give it another
        // finalization window, bounded, then record regardless.
        let pending = this.pendingRounds.get(round);
        if (pending && entry.rearms < ROUND_ABANDON_MAX_REARMS) {
            entry.rearms++;
            this._scheduleRoundWatchdog(round, entry,
                this.finalizationTimeout + this.roundAbandonGraceMs);
            return;
        }
        this.roundWatchdogs.delete(round);
        this._abandonedRounds++;
        this._lastAbandonedRound = round;
        console.warn('Oracle: Round ' + round + ' opened here but never finalized; ' +
            'recording it as abandoned so this hub holds a durable record of the round.');
        // NOT _markFinalized: the skip is local and reprocessable, so a late
        // federation quorum still upgrades these rows to 'finalized' (#7).
        this._storeSkippedRound(round, entry.btcBlockHeight, entry.btcBlockTime,
            'round abandoned before finalization').catch(err =>
                console.error('Oracle: Error storing abandoned round ' + round + ':',
                    err && err.message ? err.message : err));
    }

    // Hub F3: when the round has a block-locked snapshot, the leader
    // is derived from the snapshot's member pubkeys (sorted, round % N), NOT
    // the live registered validatorSet. The live set drifts with registration
    // churn mid-round, so live-set indexing lets two hubs elect different
    // leaders for the same round and reject each other's legitimate PROPOSE
    // (liveness stall until fallback/timeout). The snapshot is already the
    // federation-deterministic set every hub locks at the round's block
    // boundary, so deriving the leader from it keeps the election identical
    // everywhere. Without a usable snapshot (memberPubkeys null), legacy
    // live-set rotation is preserved (graceful-degradation path).
    _getLeader(round, memberPubkeys) {
        if (memberPubkeys && memberPubkeys.size > 0) {
            let keys = [...memberPubkeys].sort();
            let pubkey = keys[round % keys.length];
            return { addr: this._addrForPubkey(pubkey), pubkey: pubkey };
        }
        if (this.validatorSet.length === 0) return null;
        return this.validatorSet[round % this.validatorSet.length];
    }

    // Resolve a (lowercase) signing pubkey to its P2P addr: the loaded
    // validator set first, then the peer registry (lowest addr wins so a key
    // bound to several addrs resolves identically on every hub), then own
    // identity. Null when unknown; leader-addr comparisons then fail and the
    // fallback-proposer election salvages the round.
    _addrForPubkey(pubkey) {
        for (let v of this.validatorSet) {
            if (v && v.pubkey && String(v.pubkey).toLowerCase() === pubkey) return v.addr;
        }
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (registry && typeof registry.get === 'function') {
            let matches = [];
            for (let [addr, pk] of registry) {
                if (pk && String(pk).toLowerCase() === pubkey) matches.push(addr);
            }
            if (matches.length > 0) return matches.sort()[0];
        }
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (identity && String(identity.getPubkeyHex()).toLowerCase() === pubkey) {
            return this.peerManager.validatorAddr;
        }
        return null;
    }

    // True when `addr` (with verified pubkey `pubkey`, may be null) is the
    // round leader. Matches on addr OR verified pubkey so a snapshot-derived
    // leader is still recognized when this hub's addr binding for that key
    // differs from the one _addrForPubkey picked.
    _isLeaderIdentity(leader, addr, pubkey) {
        if (!leader) return false;
        if (leader.addr && leader.addr === addr) return true;
        let lpk = leader.pubkey ? String(leader.pubkey).toLowerCase() : null;
        return !!(lpk && pubkey && lpk === pubkey);
    }

    // Addr under which the leader's submission is recorded in a
    // snapshot-filtered submission map (keys are addrs, values carry the
    // verified pubkey), or null when the leader has not submitted.
    _leaderSubmissionAddr(submissions, leader) {
        if (!leader || !submissions) return null;
        if (leader.addr && submissions.has(leader.addr)) return leader.addr;
        let lpk = leader.pubkey ? String(leader.pubkey).toLowerCase() : null;
        if (!lpk) return null;
        for (let [addr, sub] of submissions) {
            let pk = (sub && sub.pubkey) ? sub.pubkey : this._resolveSenderPubkey(addr);
            if (pk === lpk) return addr;
        }
        return null;
    }

    _getQuorum() {
        let N = this.validatorSet.length;
        if (N <= 0) {
            // Fall back to peer count
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        // N<=1: single node, no peer to reach (0 = caller bypasses). Above that,
        // the majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    }

    // True when a capability snapshot was fetched but qualified ZERO validators
    // AND this hub is part of a federation. getQuorum() over an empty snapshot
    // returns 0, which collides with the genuine single-node bypass; taking that
    // bypass in a federation self-finalizes the round with ONE signature, storing
    // a divergent 'finalized' row and publishing a PRICE v0 the indexer's
    // >2/3-stake gate then rejects. Such a round must be SKIPPED instead. The
    // federation test is `_getQuorum() > 0` (validatorSet has >=2 registered
    // members, or a live peer is connected); a genuine single-node / regtest
    // bootstrap has `_getQuorum() === 0`, so it keeps the self-finalize path. A
    // null snapshot (indexer unreachable) is NOT this case: that is the separate
    // graceful-degradation-to-live-count path and is left untouched.
    _isEmptyFederationSnapshot(snapshot) {
        if (!snapshot) return false;
        let vals = snapshot.validators;
        let empty = !Array.isArray(vals) || vals.length === 0;
        return empty && this._getQuorum() > 0;
    }

    // Canonicalize the digest PREIMAGE, not just hash whatever array
    // arrived. `_aggregateAll` emits its results in coinPairs Set insertion
    // order (first-seen across submissions), which is a function of submission
    // ARRIVAL order, not of the round's content. Raw JSON.stringify therefore
    // made the digest depend on that arrival order, plus on the key order of
    // each entry object as the proposer happened to serialize it. Today that is
    // masked because followers re-hash the LEADER's propagated array, so both
    // sides see the same order; the moment any path re-derives a digest from
    // its OWN aggregation (or a proposer reorders a payload it re-serializes),
    // two honest hubs disagree on the digest for identical prices and the round
    // stalls. Canonicalizing makes the digest a function of the {pair -> price}
    // mapping alone.
    //
    // Shape: entries sorted by coinPair, projected to exactly [coinPair, price]
    // as strings in fixed order. String coercion mirrors the DEX's
    // _canonicalMatch discipline (a numeric 80 and the string '80' are the same
    // price and must hash alike). Projection also means a padded extra field on
    // the wire cannot change the digest; the per-pair semantic validation on the
    // PROPOSE path, and the separately signed PRICE v0 canonical, are what bind
    // the values themselves. `prices` itself is never mutated or reordered: only
    // the preimage is canonical, so stored rows and the propagated array are
    // untouched.
    //
    // Consensus-breaking (every round digest changes), so it ships ungated with
    // the pre-launch batch and its mandatory fleet-wide rebase.
    _canonicalDigestPrices(prices) {
        if (!Array.isArray(prices)) return prices;
        return prices
            .map(p => ({
                coinPair: (p && p.coinPair !== undefined && p.coinPair !== null) ? String(p.coinPair) : '',
                price:    (p && p.price    !== undefined && p.price    !== null) ? String(p.price)    : ''
            }))
            .sort((a, b) => {
                if (a.coinPair < b.coinPair) return -1;
                if (a.coinPair > b.coinPair) return 1;
                // Duplicate pairs are not produced by _aggregateAll, but a wire
                // payload can carry them; order them by price so the digest is
                // still total rather than arrival-dependent.
                if (a.price < b.price) return -1;
                if (a.price > b.price) return 1;
                return 0;
            });
    }

    _digest(round, prices) {
        let payload = JSON.stringify({ round: round, prices: this._canonicalDigestPrices(prices) });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = OracleConsensus;

// Named export so SlashDetector measures the clamp allowance from the SAME table this
// module clamps with (item 5833). A second copy of MAX_CHANGE_PER_ROUND_BY_PAIR would
// let a per-pair retune move the clamp and leave the slash gate on the old allowance,
// which is the mismatch that finding is about. Default export shape is unchanged.
module.exports.maxChangeForPair = maxChangeForPair;
