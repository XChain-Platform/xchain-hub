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
 ********************************************************************/

const PriceFetcher = require('./PriceFetcher.js');
const { PRICE_MAX } = require('./constants.js');

const ORACLE_PRICE_SUBMIT = 'ORACLE_PRICE_SUBMIT';

class OracleRound {

    constructor(hub) {
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;
        this.identity    = hub.getIdentity();
        this.config      = hub.p2pConfig || {};

        // Price fetcher
        this.priceFetcher = new PriceFetcher(this.config);

        // Round state
        this.currentRound      = 0;
        this.lastExecutedRound = -1;   // idempotency guard for time-anchored scheduling
        this.roundStartTime    = 0;
        this.roundTimer        = null;
        this.initialRoundTimer = null;

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

        // Config
        this.roundInterval          = this.config.ORACLE_ROUND_INTERVAL || 600000;     // 10 minutes
        this.submissionWindow       = this.config.ORACLE_SUBMISSION_WINDOW || 180000;   // 3 minutes
        this.maxSubmissionsPerRound  = parseInt(this.config.ORACLE_MAX_SUBMISSIONS_PER_ROUND) || 200;
        this.priceMax               = PRICE_MAX;

        // Canonical coin-pair whitelist. Submitted prices for any pair outside this
        // fixed set are dropped on ingest, so a peer cannot inject a fabricated pair
        // (e.g. BTC/ZZZ) that would flow into the aggregate and finalize with no
        // deviation history to gate it.
        this.canonicalPairs = new Set(PriceFetcher.getCoinPairs());

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

    // Start the oracle round system
    async start() {
        // Rehydrate freshness counters from the durable record before the timer
        // begins, so a restart reflects the real feed state instead of a clean slate.
        await this._hydrateFreshnessCounters();

        // Subscribe to gossip messages
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        // Reset the stall gauges only when a round actually finalizes (reaches
        // commit quorum), not merely when this hub broadcast its own submission.
        // During a consensus/quorum stall the local price fetch keeps succeeding, so
        // stamping freshness on submission would hide the stall from the dashboard's
        // early-stall gauge. Finalization is the real success signal, and it matches
        // the semantic _hydrateFreshnessCounters rebuilds from the durable record.
        if (this.oracleConsensus && typeof this.oracleConsensus.on === 'function') {
            this._finalizedHandler = () => this.markRoundFinalized();
            this.oracleConsensus.on('round:finalized', this._finalizedHandler);
        }

        // Start the round timer; it handles both the first run and the aligned cadence
        this._startRoundTimer();

        console.log('Oracle round system started (interval: ' + (this.roundInterval / 1000) + 's, window: ' + (this.submissionWindow / 1000) + 's)');
    }

    // Rehydrate consecutiveSkippedRounds and lastSuccessfulRoundTime from
    // price_snapshots so they survive a restart. The constructor initialises both
    // to a clean-slate value (0 / null); without this step a hub that restarts
    // mid-outage would present zero skipped rounds and no last-success time even
    // though the durable record shows otherwise, masking the gap from /health and
    // the diagnostics RPC. price_snapshots is durable, so this is purely an
    // observability rehydrate, never a recompute of price data.
    async _hydrateFreshnessCounters() {
        try {
            // (a) Most recent finalized round and its wall-clock time. created_at is
            // a TIMESTAMP; convert to epoch ms to match the live value, which is set
            // from Date.now() on each successful round.
            let lastRows = await this.db.doQuery(
                "SELECT round_number, UNIX_TIMESTAMP(created_at) * 1000 AS ms " +
                "FROM price_snapshots WHERE status = 'finalized' " +
                "ORDER BY round_number DESC LIMIT 1");

            let lastFinalizedRound = -1;
            if (lastRows && lastRows.length) {
                lastFinalizedRound           = Number(lastRows[0].round_number);
                this.lastSuccessfulRoundTime = Number(lastRows[0].ms);
            }

            // (b) Distinct rounds recorded after the last finalized round that did
            // NOT finalize: the consecutive trailing skip streak. With no finalized
            // round at all (lastFinalizedRound = -1) this counts every recorded
            // non-finalized round.
            let skipRows = await this.db.doQuery(
                "SELECT COUNT(DISTINCT round_number) AS skipped " +
                "FROM price_snapshots WHERE round_number > ? AND status <> 'finalized'",
                [lastFinalizedRound]);
            this.consecutiveSkippedRounds = (skipRows && skipRows.length) ? Number(skipRows[0].skipped) : 0;
        } catch (err) {
            // Non-fatal: a hydration failure must not block oracle startup. Leave the
            // constructor defaults (0 / null) in place and continue.
            console.warn('Oracle: failed to hydrate freshness counters on start:', err);
        }
    }

    // Stop the oracle round system
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if (this._finalizedHandler && this.oracleConsensus && typeof this.oracleConsensus.removeListener === 'function') {
            this.oracleConsensus.removeListener('round:finalized', this._finalizedHandler);
            this._finalizedHandler = null;
        }
        if (this.initialRoundTimer) {
            clearTimeout(this.initialRoundTimer);
            this.initialRoundTimer = null;
        }
        if (this.roundTimer) {
            clearInterval(this.roundTimer);
            this.roundTimer = null;
        }
        for (let t of this.finalizationTimers.values()) clearTimeout(t);
        this.finalizationTimers.clear();
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
    // exact semantic _hydrateFreshnessCounters rebuilds from the durable record.
    markRoundFinalized() {
        this.consecutiveSkippedRounds = 0;
        this.lastSuccessfulRoundTime  = Date.now();
    }

    // Get submissions for a given round
    // Returns: Map<sender, { prices, sources, timestamp }> or undefined
    getSubmissions(round) {
        return this.submissions.get(round || this.currentRound);
    }

    // Get all submissions as a serializable object (for JSON-RPC diagnostics)
    async getSubmissionsInfo() {
        let info = {};
        for (let [round, subs] of this.submissions) {
            info[round] = {};
            for (let [sender, data] of subs) {
                info[round][sender] = data;
            }
        }

        // Surface recently skipped rounds so operators can detect feed-outage gaps
        // straight from the diagnostics RPC. In-memory submission maps only retain
        // the current and previous round (see _pruneSubmissions), so a missed round
        // is otherwise invisible; the durable record lives in price_snapshots
        // (status='skipped', written when a round produces no usable prices).
        // skippedRounds keeps its whole-round semantic (no pair finalized): the
        // per-pair skip markers _storeSnapshot writes for partially-dropped rounds
        // (item #180) must not inflate the feed-outage count. Those partial drops
        // surface separately as droppedPairs.
        let skippedRounds = [];
        let droppedPairs = [];
        try {
            let rows = await this.db.doQuery(
                `SELECT DISTINCT s.round_number FROM price_snapshots s
                 WHERE s.status = 'skipped' AND NOT EXISTS (
                   SELECT 1 FROM price_snapshots f
                   WHERE f.round_number = s.round_number AND f.status = 'finalized')
                 ORDER BY s.round_number DESC LIMIT 50`);
            skippedRounds = rows.map(r => Number(r.round_number));
        } catch (err) {
            // Non-fatal: diagnostics still return the in-memory state if the read fails
            console.warn('Oracle: failed to read skipped rounds for diagnostics:', err);
        }
        try {
            // Per-pair drops (item #180): pairs skipped inside a round that
            // otherwise finalized (aggregation clamp / deviation gate / trim, or
            // absent from the leader's proposal), so a single pair silently
            // ceasing to publish is observable while the round looks healthy.
            let rows = await this.db.doQuery(
                `SELECT s.round_number, s.coin_pair FROM price_snapshots s
                 WHERE s.status = 'skipped' AND EXISTS (
                   SELECT 1 FROM price_snapshots f
                   WHERE f.round_number = s.round_number AND f.status = 'finalized')
                 ORDER BY s.round_number DESC, s.coin_pair ASC LIMIT 50`);
            droppedPairs = rows.map(r => ({ round: Number(r.round_number), coinPair: r.coin_pair }));
        } catch (err) {
            console.warn('Oracle: failed to read per-pair drops for diagnostics:', err);
        }

        return {
            currentRound:             this.currentRound,
            roundStartTime:           this.roundStartTime,
            roundInterval:            this.roundInterval,
            submissionWindow:         this.submissionWindow,
            submissions:              info,
            skippedRounds:            skippedRounds,
            skippedCount:             skippedRounds.length,
            droppedPairs:             droppedPairs,
            droppedPairCount:         droppedPairs.length,
            failedSubmissionPersists:      this.failedSubmissionPersists,
            lastSubmissionPersistFailureRound: this.lastSubmissionPersistFailureRound,
            lastSubmissionPersistFailureCount: this.lastSubmissionPersistFailureCount,
            consecutiveSkippedRounds: this.consecutiveSkippedRounds,
            oracle_fetch_failures:    this.fetchFailures,
            lastSuccessfulRoundTime:  this.lastSuccessfulRoundTime,
            // Server-computed age of the last successful round. The dashboard
            // prefers this over diffing lastSuccessfulRoundTime against its own
            // clock (which folds host/hub skew into the stall thresholds).
            // Mirrors the chainTipStalenessMs pattern below.
            lastSuccessAgeMs:         this.lastSuccessfulRoundTime
                ? (Date.now() - this.lastSuccessfulRoundTime)
                : null,
            btcBlockHeight:           this.currentBtcBlockHeight != null ? this.currentBtcBlockHeight : null,
            usingFallback:            this.chainTipFallbackActive,
            chainTipFetchFailures:    this.chainTipFetchFailures,
            lastChainTipFetchAt:      this.lastSuccessfulChainTipFetchAt
                ? new Date(this.lastSuccessfulChainTipFetchAt).toISOString()
                : null,
            // Server-computed age of the last good chain-tip read. Monitors can
            // threshold this directly instead of diffing lastChainTipFetchAt
            // against their own clock (which would fold in client skew).
            chainTipStalenessMs:      this.lastSuccessfulChainTipFetchAt
                ? (Date.now() - this.lastSuccessfulChainTipFetchAt)
                : null,
            // Age of the ANCHOR TIP ITSELF (now - its block time), the signal
            // chainTipStalenessMs misses: a frozen-but-present pushed tip resets the
            // fetch counters every round yet its block time keeps aging. null when the
            // anchor is a wall-clock-stamped direct height or round-number fallback,
            // where block age is meaningless. chainTipBlockStale flags it past the
            // threshold so a frozen tip during indexer catch-up is visible to monitors.
            chainTipBlockAgeMs:       this.anchorTipBlockTime != null
                ? (Date.now() - this.anchorTipBlockTime * 1000)
                : null,
            chainTipBlockStale:       this.anchorTipBlockTime != null
                ? ((Date.now() - this.anchorTipBlockTime * 1000) > this.chainTipStalenessThresholdS * 1000)
                : null
        };
    }

    // --- Private methods ---

    // Start the periodic round timer, aligned to wall-clock round boundaries
    // anchored at this.epochStart. If we start mid-round and the submission
    // window is still open, run the current round immediately after a short
    // delay to let peer connections settle; otherwise wait until the next
    // boundary.
    _startRoundTimer() {
        let elapsedInRound  = (Date.now() - this.epochStart) % this.roundInterval;
        let timeToNextRound = this.roundInterval - elapsedInRound;

        // A rejection out of a bare timer callback is an unhandled rejection
        // (process exit), so every timer-driven round execution catches here.
        const runRound = () => {
            this._executeRound().catch(err =>
                console.error('OracleRound: round execution error:', err && err.message ? err.message : err));
        };

        let initialDelay = 5000;
        if (elapsedInRound + initialDelay < this.submissionWindow) {
            this.initialRoundTimer = setTimeout(() => {
                this.initialRoundTimer = null;
                runRound();
            }, initialDelay);
        }

        // Align to the next round boundary, then run on a steady interval
        setTimeout(() => {
            runRound();
            this.roundTimer = setInterval(runRound, this.roundInterval);
        }, timeToNextRound);
    }

    // Execute a single round: fetch prices, broadcast submission
    async _executeRound() {
        // Compute the round number from wall-clock time so every hub in the
        // federation agrees on the round number for the same point in time
        // (and so a restarted hub resumes at the correct number instead of 1).
        let newRound = Math.floor((Date.now() - this.epochStart) / this.roundInterval);
        if (newRound === this.lastExecutedRound) return;
        this.lastExecutedRound = newRound;

        this.currentRound   = newRound;
        this.roundStartTime = Date.now();

        // Capture the BTC chain tip at the start of this round
        // This is the deterministic anchor for cross-node price agreement.
        // Network is resolved via the hub helper so this works whether the
        // hub serves mainnet, testnet, or regtest BTC indexers.
        try {
            let network = await this.hub._resolveBtcNetwork();
            let btcTip = await this.db.getChainTip('BTC', network);
            if (btcTip) {
                this.currentBtcBlockHeight         = btcTip.blockHeight;
                this.currentBtcBlockTime           = btcTip.blockTime;
                this.lastSuccessfulChainTipFetchAt = Date.now();
                this.chainTipFetchFailures         = 0;
                this.chainTipFallbackActive        = false;
                // Record the pushed tip's own block time so diagnostics can age it. A
                // present-but-frozen row (indexer catch-up suppressing pushes) clears
                // every fetch counter above but leaves this block time stale.
                this.anchorTipBlockTime = (typeof btcTip.blockTime === 'number' && btcTip.blockTime > 0)
                    ? btcTip.blockTime : null;
            } else {
                // No pushed chain tip in the hub DB. The indexer→hub `pushchaintip`
                // path only populates getChainTip when an indexer is co-located with
                // (and configured to push to) this hub, which a master/standalone hub
                // box running the oracle may not have. Before degrading to the round
                // number, try the hub's direct indexer resolver (getlatestblock via
                // BTC_INDEXER_API_URL or the configs table). It returns only a height,
                // so anchor the timestamp to the wall clock. A real height is a real
                // anchor, so clear the fallback flag: finalization must NOT be
                // suppressed when we have an authoritative block height.
                let directHeight = null;
                try { directHeight = await this.hub._resolveBtcLatestBlock(); }
                catch (_) { /* resolver failed; fall through to round-number anchor */ }

                if (directHeight) {
                    this.currentBtcBlockHeight         = directHeight;
                    this.currentBtcBlockTime           = Math.floor(Date.now() / 1000);
                    this.lastSuccessfulChainTipFetchAt = Date.now();
                    this.chainTipFetchFailures         = 0;
                    this.chainTipFallbackActive        = false;
                    // Direct-resolver height carries no block time; the anchor is wall
                    // clock, so block-age monitoring does not apply.
                    this.anchorTipBlockTime = null;
                } else {
                    // No BTC tip available at all; fall back to round number
                    this.chainTipFetchFailures++;
                    if (!this.chainTipFallbackActive) this.chainTipFallbackActive = true;
                    if (this.chainTipFetchFailures > 1) {
                        console.error('Oracle: BTC chain tip unavailable (failure ' + this.chainTipFetchFailures + '); using round number as fallback anchor');
                    } else {
                        console.warn('Oracle: BTC chain tip unavailable; using round number as fallback anchor');
                    }
                    this.currentBtcBlockHeight = this.currentRound;
                    this.currentBtcBlockTime   = Math.floor(Date.now() / 1000);
                    this.anchorTipBlockTime    = null;
                }
            }
        } catch (err) {
            this.chainTipFetchFailures++;
            if (!this.chainTipFallbackActive) this.chainTipFallbackActive = true;
            if (this.chainTipFetchFailures > 1) {
                console.error('Oracle: Failed to read BTC chain tip (failure ' + this.chainTipFetchFailures + '):', err);
            } else {
                console.warn('Oracle: Failed to read BTC chain tip:', err);
            }
            this.currentBtcBlockHeight = this.currentRound;
            this.currentBtcBlockTime   = Math.floor(Date.now() / 1000);
            this.anchorTipBlockTime    = null;
        }

        // Prune old submissions (keep current and previous round only)
        this._pruneSubmissions();

        // Initialize submission map for this round
        if (!this.submissions.has(this.currentRound)) {
            this.submissions.set(this.currentRound, new Map());
        }

        // Fetch prices from external sources
        let prices;
        try {
            prices = await this.priceFetcher.fetchPrices();
        } catch (err) {
            this.fetchFailures++;
            console.error('Oracle: Price fetch failed for round ' + this.currentRound + ':', err);
            // Still schedule finalization so the round leaves a durable record.
            // If peers gossiped submissions the round can be salvaged; if nobody
            // has prices, OracleConsensus writes a 'skipped' price_snapshots row
            // instead of the round vanishing without a trace.
            this._scheduleFinalization(this.currentRound);
            this.consecutiveSkippedRounds++;
            return;
        }

        if (!prices || prices.length === 0) {
            console.warn('Oracle: No prices available for round ' + this.currentRound);
            // Same rationale as the fetch-failure path above: record the gap.
            this._scheduleFinalization(this.currentRound);
            this.consecutiveSkippedRounds++;
            return;
        }

        // Count total sources across all pairs
        let totalSources = prices.reduce((sum, p) => sum + p.sources, 0);

        console.log('Oracle: Round ' + this.currentRound + ' - fetched ' + prices.length +
            ' pairs from ' + totalSources + ' source queries');

        // Broadcast our submission via gossip
        this.peerManager.broadcast(ORACLE_PRICE_SUBMIT, {
            round:   this.currentRound,
            prices:  prices,
            sources: totalSources
        });

        // Record our own submission
        let myAddr = this.peerManager.validatorAddr;
        this.submissions.get(this.currentRound).set(myAddr, {
            prices:    prices,
            sources:   totalSources,
            timestamp: Date.now(),
            // Own verified identity, matching the pubkey stamped on peer
            // submissions so the snapshot membership filter treats self the same.
            pubkey:    this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null
        });

        // Persist to DB; await so a persistence failure is counted and observable
        // (surfaced via getDiagnostics), not silently dropped. Does not throw.
        await this._persistSubmissions(this.currentRound, myAddr, prices);

        // The stall gauges (consecutiveSkippedRounds / lastSuccessfulRoundTime) are
        // deliberately NOT stamped here: a successful local submission is not a
        // finalized round. They are updated by markRoundFinalized() on the consensus
        // 'round:finalized' event, so a commit-quorum stall (where the fetch keeps
        // succeeding but no round finalizes) ages the gauge instead of masking it.
        this._scheduleFinalization(this.currentRound);
    }

    // Schedule finalization for a round after the submission window
    _scheduleFinalization(round) {
        // Capture the BTC chain tip values for this round at scheduling time
        let btcBlockHeight = this.currentBtcBlockHeight;
        let btcBlockTime   = this.currentBtcBlockTime;
        let prior = this.finalizationTimers.get(round);
        if (prior) clearTimeout(prior);
        let timer = setTimeout(() => {
            this.finalizationTimers.delete(round);
            if (this.oracleConsensus) {
                if (this.chainTipFallbackActive) {
                    let lastGoodTip = this.lastSuccessfulChainTipFetchAt ?? this._startTime;
                    if ((Date.now() - lastGoodTip) > this.roundInterval) {
                        console.error('Oracle: Skipping finalization for round ' + round +
                            '; chain-tip fallback active for >' + Math.round(this.roundInterval / 1000) +
                            's; btcBlockHeight anchor is unreliable, PRICE payload suppressed');
                        this.oracleConsensus._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                            'chain-tip fallback active, anchor unreliable').catch(err =>
                            console.error('Oracle: Failed to store skipped round ' + round + ':', err.message));
                        this.consecutiveSkippedRounds++;
                        return;
                    }
                }
                this.oracleConsensus.finalizeRound(round, btcBlockHeight, btcBlockTime).catch(err => {
                    console.error('Oracle: Finalization error for round ' + round + ':', err.message);
                });
            }
        }, this.submissionWindow);
        this.finalizationTimers.set(round, timer);
    }

    // Handle incoming gossip messages
    // A sender counts only if it maps to a registered validator pubkey. Mirrors
    // OracleConsensus._isKnownSender: a null registry fails closed; an empty
    // registry is the permissive bootstrap window (before syncvalidators has run)
    // only until a chain-effective signer set exists; then it fails closed.
    _isRegisteredSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) {
            // Empty-registry leniency is for the genuine pre-bootstrap window ONLY
            // (G-1/): once the on-chain snapshot has produced a non-empty
            // effective signer set, an empty registry is a misconfiguration or
            // wipe window, not bootstrap, and counting unattributable senders
            // would reopen count-mode quorum forgery. Fail closed instead.
            let signerSet = this.peerManager.effectiveSignerSet;
            return !(signerSet && signerSet.size > 0);
        }
        return registry.has(sender);
    }

    _handleMessage(envelope) {
        if (envelope.type !== ORACLE_PRICE_SUBMIT) return;

        let { round, prices, sources } = envelope.data;
        // Round 0 is a real, valid round (first interval after ORACLE_EPOCH_START); guard
        // on integer/non-negative, not falsiness, or a genesis round-0 submission is dropped.
        if (!Number.isInteger(round) || round < 0 || !prices || !Array.isArray(prices)) return;

        // Drop submissions from senders that are not registered validators. Without
        // this gate a single authorized signing key can broadcast many submissions,
        // each naming a distinct fake `sender` (PeerManager only binds sender<->key
        // when the sender is already registered), Sybil-stuffing the trimmed-median
        // aggregate and the ORACLE_MIN_SUBMISSIONS diversity floor with one node.
        // Mirrors OracleConsensus._isKnownSender, including the empty-registry
        // permissive bootstrap window.
        if (!this._isRegisteredSender(envelope.sender)) return;

        // Only accept submissions for current or next round
        if (round < this.currentRound - 1 || round > this.currentRound + 1) return;

        // Check if we're still within the submission window
        let elapsed = Date.now() - this.roundStartTime;
        if (round === this.currentRound && elapsed > this.submissionWindow) {
            // Late submission: still record it but log
            console.log('Oracle: Late submission from ' + envelope.sender + ' for round ' + round);
        }

        // Initialize submission map for this round if needed
        if (!this.submissions.has(round)) {
            this.submissions.set(round, new Map());
        }

        // Record the submission (first submission per sender per round wins)
        let roundSubs = this.submissions.get(round);
        if (roundSubs.has(envelope.sender)) return; // Already have a submission from this sender

        // Resolve the sender's registered pubkey up front. PeerManager enforces the
        // addr<->pubkey binding on every verified envelope, so this is the VERIFIED
        // signing identity, not a claim. Dedup on it (Oracle M1): the registry is
        // Map<addr, pubkey> and one key may be registered under several addrs, so a
        // sender-keyed first-wins alone lets a single signing key submit once per
        // addr, multiplying its weight in the trimmed median and the
        // ORACLE_MIN_SUBMISSIONS diversity floor.
        let senderPubkey = null;
        if (this.peerManager.validatorPubkeys) {
            let pk = this.peerManager.validatorPubkeys.get(envelope.sender);
            if (pk) senderPubkey = String(pk).toLowerCase();
        }
        if (senderPubkey) {
            for (let sub of roundSubs.values()) {
                if (sub && sub.pubkey === senderPubkey) {
                    console.warn('Oracle: dropping duplicate submission for round ' + round +
                        ' from ' + envelope.sender + ': pubkey ' + senderPubkey.substring(0, 16) +
                        '... already submitted under another sender');
                    return;
                }
            }
        }

        // Enforce max submissions per round
        if (roundSubs.size >= this.maxSubmissionsPerRound) {
            console.warn('Oracle: Max submissions per round reached for round ' + round + '; dropping from ' + envelope.sender);
            return;
        }

        // Validate individual prices: filter to positive finite values within bounds
        // AND to the canonical pair whitelist (reject fabricated/novel coin pairs).
        let validPrices = prices.filter(p => {
            if (!p || !this.canonicalPairs.has(p.coinPair)) return false;
            let val = parseFloat(p.price);
            return Number.isFinite(val) && val > 0 && val < this.priceMax;
        });
        // Surface both drop paths (item ce5a2d5d): the sibling drops at lines 531/545
        // already log, this filter was the one silent gap. A partial drop masks a peer
        // degrading pair coverage; a zero-valid drop masks the true cause of a
        // below-minimum-submissions round skip.
        if (validPrices.length < prices.length)
            console.warn('Oracle: dropped ' + (prices.length - validPrices.length) + ' invalid/non-canonical pair(s) from '
                + envelope.sender + ' for round ' + round);
        if (validPrices.length === 0) {
            console.warn('Oracle: submission from ' + envelope.sender + ' for round ' + round
                + ' had zero valid pairs (of ' + prices.length + '); discarding entire submission');
            return;
        }

        roundSubs.set(envelope.sender, {
            prices:    validPrices,
            sources:   sources || 0,
            timestamp: envelope.timestamp,
            // Verified registered pubkey (lowercase hex) or null during the
            // empty-registry bootstrap window. OracleConsensus keys its snapshot
            // membership filter on this.
            pubkey:    senderPubkey
        });

        console.log('Oracle: Received submission from ' + envelope.sender +
            ' for round ' + round + ' (' + roundSubs.size + ' total)');

        // Resolve sender's validator pubkey. Drop the DB persist if unresolved:
        // keeps the in-memory submission for aggregation but avoids placeholder rows.
        let validatorPubkey = null;
        if (this.peerManager.validatorPubkeys) {
            let pk = this.peerManager.validatorPubkeys.get(envelope.sender);
            if (pk) validatorPubkey = pk;
        }
        if (!validatorPubkey) {
            console.warn('Oracle: skipping DB persist for unregistered sender ' + envelope.sender +
                ' (call syncvalidators to register the peer)');
            return;
        }
        // Remote peer submission: _handleMessage is a synchronous message handler, so this
        // stays fire-and-forget, but _persistSubmissions now counts its own failures
        // internally (via allSettled) and never rejects, so the drop is still observable.
        this._persistSubmissions(round, envelope.sender, validPrices, validatorPubkey);
    }

    // Persist price submissions to the database
    async _persistSubmissions(round, sender, prices, validatorPubkey) {
        // Resolve pubkey for self
        if (!validatorPubkey && this.identity) {
            validatorPubkey = this.identity.getPubkeyHex();
        }
        if (!validatorPubkey) {
            validatorPubkey = '0000000000000000000000000000000000000000000000000000000000000000';
        }

        let inserts = [];
        for (let p of prices) {
            // INSERT IGNORE relies on the UNIQUE KEY (round, coin_pair, validator_pubkey)
            // so concurrent writes across hubs collapse silently instead of raising
            // ER_DUP_ENTRY (which db.doQuery would log before our catch could filter it).
            let query = `INSERT IGNORE INTO oracle_submissions (round_number, coin_pair, validator_pubkey, price, sources)
                         VALUES (?, ?, ?, ?, ?)`;
            inserts.push(this.db.doQuery(query, [round, p.coinPair, validatorPubkey, p.price, p.sources]));
        }

        // Settle every insert before the round proceeds so a persistence failure is
        // observable instead of fire-and-forget. Deliberately Promise.allSettled, NOT
        // Promise.all, and NOT re-thrown: a dropped audit row must never stall a
        // money-bearing consensus round (that would trade a benign audit gap for a
        // liveness bug). Failures are counted and surfaced via getDiagnostics().
        let results = await Promise.allSettled(inserts);
        let failed = 0;
        for (let r of results) {
            if (r.status === 'rejected') {
                failed++;
                console.error('Oracle: Error persisting submission:', r.reason);
            }
        }
        if (failed > 0) {
            this.failedSubmissionPersists += failed;
            this.lastSubmissionPersistFailureRound = round;
            this.lastSubmissionPersistFailureCount = failed;
        }
    }

    // Prune old submission data (keep current and previous round only)
    _pruneSubmissions() {
        for (let [round] of this.submissions) {
            if (round < this.currentRound - 1) {
                this.submissions.delete(round);
            }
        }
    }
}

module.exports = OracleRound;
