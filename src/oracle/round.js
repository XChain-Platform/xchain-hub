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
 * XChain Hub - Oracle Round Manager
 *
 * Manages the price oracle round lifecycle. Each round:
 * 1. Fetches prices from external APIs via PriceFetcher
 * 2. Broadcasts the local price submission via gossip
 * 3. Collects other validators' submissions
 * 4. Stores submissions in MariaDB
 *
 * Phase 3A: Submission collection only.
 * Phase 3B will add aggregation, consensus, and finalization.
 *
 * The round's behaviours live one per file under round/ and are installed on
 * this prototype at load time (see installParts), so every call site keeps
 * writing oracleRound.<method>() and no caller knows which file it is in.
 * What stays HERE is construction and the round's own identity: the two
 * collaborators tests stub through this module (PriceFetcher and
 * XchainPriceSource), the cadence constants, the derived-pair gate, and start(),
 * which registers the PeerManager message handler and so stays in the file whose
 * exported class the listener-ceiling roster names.
 *
 ********************************************************************/

const PriceFetcher = require('./price_fetcher.js');
const XchainPriceSource = require('./xchain_price_source.js');
const { isXchainPriceActive, roundStartSeconds } = require('../xchain_price_activation.js');
const { PRICE_MAX, DEFAULT_ORACLE_ROUND_INTERVAL_MS,
        DEFAULT_ORACLE_SUBMISSION_WINDOW_MS, DERIVED_PAIRS } = require('../constants.js');
const { formatXchainPriceMeta } = require('./round/xchain_price_meta.js');
const { getLogger } = require('../observability');
const logger = getLogger();

// One part per behaviour, installed on the prototype below. Spelled out rather
// than read off the directory so a missing or extra part is a visible diff.
const lifecyclePart       = require('./round/lifecycle.js');
const submissionsInfoPart = require('./round/submissions_info.js');
const executePart         = require('./round/execute.js');
const finalizationPart    = require('./round/finalization.js');
const messagesPart        = require('./round/messages.js');
const persistencePart     = require('./round/persistence.js');

const PARTS = [lifecyclePart, submissionsInfoPart, executePart, finalizationPart,
               messagesPart, persistencePart];

class OracleRound {

    constructor(hub) {
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;
        this.identity    = hub.getIdentity();
        this.config      = hub.p2pConfig || {};

        // Price fetcher
        this.priceFetcher = new PriceFetcher(this.config);

        initRoundState.call(this);
        initConfigKnobs.call(this);

        // Canonical coin-pair whitelist. Submitted prices for any pair outside this
        // fixed set are dropped on ingest, so a peer cannot inject a fabricated pair
        // (e.g. BTC/ZZZ) that would flow into the aggregate and finalize with no
        // deviation history to gate it.
        //
        // ADMISSION set = the 36 API pairs PLUS DERIVED_PAIRS. A derived pair
        // is not fetched from any API, so it is absent from getCoinPairs() and would
        // otherwise read here as fabricated - which withholds co-sign on the WHOLE
        // round (OracleConsensus reads this same Set), not merely on that pair. This
        // is the ONLY place the two sets are unioned; everything that asks "what does
        // this hub produce" keeps using getCoinPairs() directly.
        this.canonicalPairs = new Set([...PriceFetcher.getCoinPairs(), ...DERIVED_PAIRS]);

        // Producer for the derived pair. Constructed unconditionally but
        // inert unless the operator configured read-only access to this validator's
        // own BTC indexer database; isConfigured() false means this hub abstains from
        // the pair, which is a supported state, not a misconfiguration to fail on.
        this.xchainPriceSource = new XchainPriceSource(this.config, hub && hub.db);

        initChainTipHealth.call(this);
        initRoundCounters.call(this);

        // Wall-clock anchor for round numbering. All hubs must agree on this
        // timestamp so they compute the same round number from the same time.
        this.epochStart = parseInt(this.config.ORACLE_EPOCH_START);
        if (!Number.isFinite(this.epochStart))
            throw new Error('ORACLE_EPOCH_START must be a Unix ms timestamp (every hub in the federation must share the same value)');
    }

    // Set the oracle consensus engine (called by XChainHub after both are created)
    setConsensus(oracleConsensus) {
        this.oracleConsensus = oracleConsensus;
    }

    // §8 / step 5: has the derived pair's composition gate opened for the round
    // being composed right now?
    //
    // Keyed on the round's canonical start instant, which every hub in the federation
    // computes identically from the shared epoch and interval - see the header of
    // xchain_price_activation.js for why a locally-observed chain tip is the wrong key
    // here and how it would stall the whole round.
    xchainPriceGateOpen() {
        return this.xchainPriceGateOpenFor(this.currentRound);
    }

    // The same gate keyed on an EXPLICIT round rather than the one being composed now.
    // The drop-marker path in OracleConsensus (item 3521) runs against a STORED round,
    // which need not be currentRound: a hub writes markers for the round it just
    // finalized while its own currentRound may already have advanced, so reading the
    // gate off currentRound there would answer for the wrong instant near the
    // threshold. Same fail-closed contract; see xchain_price_activation.js.
    xchainPriceGateOpenFor(round) {
        let t = roundStartSeconds(round, this.epochStart, this.roundInterval);
        if (t === null) return false;
        return isXchainPriceActive(t, this.currentBtcNetwork);
    }

    // Get the current round number
    getCurrentRound() {
        return this.currentRound;
    }

    // Stamp the stall gauges on a genuine round finalization. This is the sole
    // authoritative writer of both fields on the live path (wired to the consensus
    // 'round:finalized' event in start()). consecutiveSkippedRounds is the trailing
    // streak of non-finalized rounds; lastSuccessfulRoundTime is the wall-clock time
    // of the last round this hub saw finalized (as leader or follower), which is the
    // exact semantic hydrateFreshnessCounters rebuilds from the durable record.
    markRoundFinalized() {
        this.consecutiveSkippedRounds = 0;
        this.lastSuccessfulRoundTime  = Date.now();
    }

    // Advance the skip streak on a round that became a durable non-finalized record.
    // Sole authoritative writer of the increment (wired to the consensus
    // 'round:skipped' event in start()), because that event fires once per round from
    // markLocallySkipped's idempotent guard, which is precisely the round set
    // hydrateFreshnessCounters counts. The three local increments this replaced did
    // not partition the round space the same way: a failed fetch that later also hit
    // the chain-tip-fallback branch counted one round twice, and a round the local
    // fetch survived but consensus stored as skipped counted zero, so /health read a
    // different streak before and after a restart (item 4942).
    noteRoundSkipped() {
        this.consecutiveSkippedRounds++;
    }

    // Get submissions for a given round
    // Returns: Map<sender, { prices, sources, timestamp }> or undefined
    getSubmissions(round) {
        return this.submissions.get(round || this.currentRound);
    }


    // Start the oracle round system
    async start() {
        // Idempotent: a second start() without an intervening stop() would install
        // a duplicate round loop (and leak the first). If any scheduling timer is
        // already live, this instance is running; do nothing.
        if (this.initialRoundTimer || this.boundaryTimer || this.roundTimer) {
            return;
        }

        // Rehydrate freshness counters from the durable record before the timer
        // begins, so a restart reflects the real feed state instead of a clean slate.
        await this.hydrateFreshnessCounters();

        // Subscribe to gossip messages
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        // Reset the stall gauges only when a round actually finalizes (reaches
        // commit quorum), not merely when this hub broadcast its own submission.
        // During a consensus/quorum stall the local price fetch keeps succeeding, so
        // stamping freshness on submission would hide the stall from the dashboard's
        // early-stall gauge. Finalization is the real success signal, and it matches
        // the semantic hydrateFreshnessCounters rebuilds from the durable record.
        if (this.oracleConsensus && typeof this.oracleConsensus.on === 'function') {
            this._finalizedHandler = () => this.markRoundFinalized();
            this.oracleConsensus.on('round:finalized', this._finalizedHandler);
            // Symmetric wiring for the increment: the streak advances on the same
            // durable event the reset does, so the live gauge and the hydrated value
            // share one semantic (item 4942).
            this._skippedHandler = () => this.noteRoundSkipped();
            this.oracleConsensus.on('round:skipped', this._skippedHandler);
        }

        // Start the round timer; it handles both the first run and the aligned cadence
        this.startRoundTimer();

        logger.info('Oracle round system started (interval: ' + (this.roundInterval / 1000) + 's, window: ' + (this.submissionWindow / 1000) + 's)');
    }
}

// The round's own live state: which round is running, the timers that drive it,
// and the maps the gossip and finalization paths write into.
function initRoundState() {
    // Round state
    this.currentRound      = 0;
    this.lastExecutedRound = -1;   // idempotency guard for time-anchored scheduling
    this.roundStartTime    = 0;
    this.roundTimer        = null;
    this.initialRoundTimer = null;
    // Boundary-alignment setTimeout handle. Tracked so stop() can cancel it
    // during the (up to a full roundInterval) window before it fires and
    // installs roundTimer; an untracked handle leaks an interval across
    // stop()/recreate and orphans the fresh roundTimer on stop()->start().
    this.boundaryTimer     = null;
    this._roundInFlight    = false;   // round self-overlap guard, see executeRound()

    // Submissions per round: Map<round, Map<sender, { prices, sources, timestamp }>>
    this.submissions = new Map();

    // Oracle consensus engine (set via setConsensus after creation)
    this.oracleConsensus = null;

    // Per-round finalization timers, keyed by round. A single shared timer let a
    // second round scheduled within one submission window clear the earlier round's
    // timer before it fired, dropping that round's finalization entirely (no
    // price_snapshots row, not even a skipped one). Keying by round mirrors
    // OracleConsensus.leaderTimers.
    this.finalizationTimers = new Map();

    // Message handler reference
    this._messageHandler = null;
}

// The cadence and the ingest bounds, every one of them read off p2pConfig here
// and nowhere else on the round path.
function initConfigKnobs() {
    // Config
    // Defaults shared with api.js/XChainHub.js via constants.js (#2653): a hub
    // constructed without a populated p2pConfig must land on the same cadence
    // as its peers, since the interval anchors round numbering federation-wide.
    this.roundInterval          = this.config.ORACLE_ROUND_INTERVAL || DEFAULT_ORACLE_ROUND_INTERVAL_MS;
    this.submissionWindow       = this.config.ORACLE_SUBMISSION_WINDOW || DEFAULT_ORACLE_SUBMISSION_WINDOW_MS;
    // Per-round cap on collected peer submissions. api.js passes the env value
    // through unparsed, so the parse and the default live here only. Unlike the
    // retention window below, 0 is NOT a "disable" setting: maxSubmissionsPerRound
    // gates ingest in _handleMessage, so 0 (or a negative) would drop every peer
    // submission and stall the round silently. Both fall back to the default.
    this.maxSubmissionsPerRound = parseInt(this.config.ORACLE_MAX_SUBMISSIONS_PER_ROUND);
    if (!Number.isFinite(this.maxSubmissionsPerRound) || this.maxSubmissionsPerRound <= 0) {
        this.maxSubmissionsPerRound = 200;
    }
    // Retention window (in rounds) for the oracle_submissions audit table.
    // oracle_submissions is a purely diagnostic per-validator trail: the
    // finalized value lives durably in price_snapshots and dropped rows are
    // explicitly tolerated (Promise.allSettled in persistSubmissions). Without
    // a bound the table appends validators x coin_pairs rows every round for the
    // life of the deployment. Keep the most recent N rounds; 0 disables pruning.
    // Default ~90 days at the 10-minute round default, mirroring telemetry_pings.
    this.submissionsRetentionRounds = parseInt(this.config.ORACLE_SUBMISSIONS_RETENTION_ROUNDS);
    if (!Number.isFinite(this.submissionsRetentionRounds) || this.submissionsRetentionRounds < 0) {
        this.submissionsRetentionRounds = 12960;
    }
    this.priceMax               = PRICE_MAX;
}

// Freshness of the BTC anchor this hub prices against, and the network the
// derived-pair gate reads.
function initChainTipHealth() {
    // Chain-tip health tracking
    this.lastSuccessfulChainTipFetchAt = null;
    this.chainTipFetchFailures         = 0;
    this.chainTipFallbackActive        = false;
    this._startTime                    = Date.now();

    // Block-age of the anchor tip itself (seconds, Unix), set ONLY when the anchor
    // came from a real pushed chain tip. The indexer suppresses chain-tip pushes
    // during a long catch-up, so getChainTip can keep returning a frozen row that
    // resets every fetch-freshness counter while the tip's own block time ages out.
    // chainTipStalenessMs measures read time, not the tip's age, so it stays small
    // and hides the freeze. null when the anchor is the wall-clock-stamped direct
    // height or round-number fallback (block-age monitoring does not apply there).
    this.anchorTipBlockTime = null;
    // Tip is flagged stale once its block time is older than this (seconds). Default
    // 2x the round interval; a genuine BTC tip advances roughly every 10 min, so this
    // only trips on a multi-block freeze, and it is a monitoring flag (it never
    // suppresses finalization, which the chainTipFallbackActive ladder still governs).
    this.chainTipStalenessThresholdS = parseInt(this.config.CHAIN_TIP_STALENESS_THRESHOLD_S)
        || Math.floor((2 * this.roundInterval) / 1000);

    // BTC network for this hub, resolved once per round from the configs table and
    // read by the derived-pair composition gate. Undefined until the first successful
    // resolve, which the gate treats as "do not compose the pair".
    this.currentBtcNetwork = undefined;
}

// The round-outcome gauges getSubmissionsInfo reports: what stalled, what failed
// to persist, and what the retention sweep could not do.
function initRoundCounters() {
    // Skipped-round tracking
    this.consecutiveSkippedRounds = 0;
    this.lastSuccessfulRoundTime  = null;

    // Cumulative count of rounds where the price fetch threw. Unlike
    // consecutiveSkippedRounds (a gauge that resets on the next success),
    // this only ever grows, giving operators a real-time miss-rate signal.
    this.fetchFailures = 0;

    // Count of oracle_submissions INSERTs that failed to persist (monotonic, like
    // fetchFailures) plus the last round in which one failed and how many failed in
    // it. A dropped submission narrows the durable audit trail / per-pair source
    // count vs. the in-memory quorum view without ever over-reporting quorum, so this
    // is surfaced as an operator signal rather than aborting the money-bearing round.
    this.failedSubmissionPersists = 0;
    this.lastSubmissionPersistFailureRound = null;
    this.lastSubmissionPersistFailureCount = 0;

    // Same shape for the durable retention sweep, which is fired and not awaited
    // (see executeRoundInner) so its rejection has nowhere else to land: without
    // these the oracle_submissions audit table grows for the process lifetime and
    // the first operator signal is DB pressure. _submissionsPruneDark is an edge
    // latch, not a counter: the sweep runs every round, so an unlatched warn would
    // reprint the same fault forever (same posture as OraclePublisher.logSnapshotDark).
    this.submissionsPruneFailures = 0;
    this.lastSubmissionsPruneFailureRound = null;
    this._submissionsPruneDark = false;

    // Edge latch for the out-of-band round warning. Holds the highest
    // round already announced, so a standing sentinel is named once rather than
    // on every diagnostics poll; see getSubmissionsInfo.
    this._lastImplausibleRoundWarned = null;
}

// Install each part's methods on the prototype, non-enumerably, as src/db/index.js
// installMixins does for the database families: enumerable false keeps a moved method
// indistinguishable from one declared in the class body, writable and configurable true
// keep it stubbable, and a name already on the prototype throws rather than overriding.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate method: ' + name + ' is already defined on ' +
                    target.constructor.name + '.prototype');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(OracleRound.prototype, PARTS);

module.exports = Object.assign(OracleRound, {
    // Exported for test only: the §10 step 6 audit line is a deliverable of this item,
    // so it is asserted rather than eyeballed in a log.
    formatXchainPriceMeta
});
