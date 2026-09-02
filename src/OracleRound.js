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
const XchainPriceSource = require('./XchainPriceSource.js');
const { isXchainPriceActive, roundStartSeconds } = require('./xchain_price_activation.js');
const { isAdmissibleSigner, provenPubkey } = require('./lib/chain_signer_admission.js');
const { roundBand, describeImplausibleRound } = require('./lib/oracle_round_band.js');
const { PRICE_MAX, DEFAULT_ORACLE_ROUND_INTERVAL_MS,
        DEFAULT_ORACLE_SUBMISSION_WINDOW_MS, DERIVED_PAIRS } = require('./constants.js');

const ORACLE_PRICE_SUBMIT = 'ORACLE_PRICE_SUBMIT';

// Render the XCHAIN/USD derivation metadata for the round log (§10 step 6).
//
// §5 claims manipulation of this pair is "visible". That claim is only true if the
// inputs behind a print are recorded somewhere an operator can read after the fact,
// so this line is part of the design rather than debug chatter. It carries the
// window height range, the fill counts (used, clamped, excluded), both volumes, the
// winsorization reference, and - critically - the RAW pre-winsorize VWAP beside the
// published rate. A round where those two differ is a round where the defence fired,
// and nothing else in the system would say so.
//
// Deliberately one line and human-readable: it lands in the same log a hub operator
// already tails for `Oracle: Round`, and a structured sink can be added later without
// changing what the derivation computes.
function formatXchainPriceMeta(meta) {
    if (!meta) return '(no metadata)';
    let w = meta.window || {};
    // Rendered with the bound semantics visible, because they are load-bearing: the
    // low bound is EXCLUSIVE and the high bound INCLUSIVE, which is what makes
    // consecutive rounds tile without double-counting a block's fills.
    let parts = ['window (' + (w.fromBlockExclusive != null ? w.fromBlockExclusive : '?') +
                 ', ' + (w.toBlockInclusive != null ? w.toBlockInclusive : '?') + ']'];

    if (meta.derived) {
        parts.push(meta.usedFills + ' fills');
        parts.push(meta.clampedFills + ' clamped');
        parts.push(meta.droppedFills + ' excluded');
        parts.push('vol ' + meta.btcVolume + ' BTC / ' + meta.totalXchain + ' XCHAIN');
        parts.push('raw ' + meta.rawXchainBtc + ' -> published ' + meta.xchainBtc + ' BTC');
        parts.push('ref ' + meta.refRate);
    } else {
        parts.push('carry-forward from ' + meta.carriedFrom);
        parts.push(meta.fillCount + ' fills in window');
        if (meta.reason) parts.push(meta.reason);
        // Present only when the volume gate was what held the price back, and it is
        // the field that distinguishes "the market was quiet" from "the market traded
        // and we chose not to follow it yet".
        if (meta.btcVolume !== undefined)
            parts.push('vol ' + meta.btcVolume + ' BTC vs threshold ' +
                       (meta.minBtcVolume === null ? 'DISABLED' : meta.minBtcVolume));
        if (meta.wouldHaveBeen !== undefined)
            parts.push('would have been ' + meta.wouldHaveBeen + ' BTC');
    }
    return '(' + parts.join(', ') + ')';
}

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
        // Boundary-alignment setTimeout handle. Tracked so stop() can cancel it
        // during the (up to a full roundInterval) window before it fires and
        // installs roundTimer; an untracked handle leaks an interval across
        // stop()/recreate and orphans the fresh roundTimer on stop()->start().
        this.boundaryTimer     = null;
        this._roundInFlight    = false;   // round self-overlap guard, see _executeRound()

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
        // Defaults shared with api.js/XChainHub.js via constants.js (#2653): a hub
        // constructed without a populated p2pConfig must land on the same cadence
        // as its peers, since the interval anchors round numbering federation-wide.
        this.roundInterval          = this.config.ORACLE_ROUND_INTERVAL || DEFAULT_ORACLE_ROUND_INTERVAL_MS;
        this.submissionWindow       = this.config.ORACLE_SUBMISSION_WINDOW || DEFAULT_ORACLE_SUBMISSION_WINDOW_MS;
        // Per-round cap on collected peer submissions. api.js passes the env value
        // through unparsed, so the parse and the default live here only. Unlike the
        // retention window below, 0 is NOT a "disable" setting: maxSubmissionsPerRound
        // gates ingest at line ~677, so 0 (or a negative) would drop every peer
        // submission and stall the round silently. Both fall back to the default.
        this.maxSubmissionsPerRound = parseInt(this.config.ORACLE_MAX_SUBMISSIONS_PER_ROUND);
        if (!Number.isFinite(this.maxSubmissionsPerRound) || this.maxSubmissionsPerRound <= 0) {
            this.maxSubmissionsPerRound = 200;
        }
        // Retention window (in rounds) for the oracle_submissions audit table.
        // oracle_submissions is a purely diagnostic per-validator trail: the
        // finalized value lives durably in price_snapshots and dropped rows are
        // explicitly tolerated (Promise.allSettled in _persistSubmissions). Without
        // a bound the table appends validators x coin_pairs rows every round for the
        // life of the deployment. Keep the most recent N rounds; 0 disables pruning.
        // Default ~90 days at the 10-minute round default, mirroring telemetry_pings.
        this.submissionsRetentionRounds = parseInt(this.config.ORACLE_SUBMISSIONS_RETENTION_ROUNDS);
        if (!Number.isFinite(this.submissionsRetentionRounds) || this.submissionsRetentionRounds < 0) {
            this.submissionsRetentionRounds = 12960;
        }
        this.priceMax               = PRICE_MAX;

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
        // (see _executeRoundInner) so its rejection has nowhere else to land: without
        // these the oracle_submissions audit table grows for the process lifetime and
        // the first operator signal is DB pressure. _submissionsPruneDark is an edge
        // latch, not a counter: the sweep runs every round, so an unlatched warn would
        // reprint the same fault forever (same posture as OraclePublisher._logSnapshotDark).
        this.submissionsPruneFailures = 0;
        this.lastSubmissionsPruneFailureRound = null;
        this._submissionsPruneDark = false;

        // Edge latch for the out-of-band round warning. Holds the highest
        // round already announced, so a standing sentinel is named once rather than
        // on every diagnostics poll; see getSubmissionsInfo.
        this._lastImplausibleRoundWarned = null;

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
    _xchainPriceGateOpen() {
        return this._xchainPriceGateOpenFor(this.currentRound);
    }

    // The same gate keyed on an EXPLICIT round rather than the one being composed now.
    // The drop-marker path in OracleConsensus (item 3521) runs against a STORED round,
    // which need not be currentRound: a hub writes markers for the round it just
    // finalized while its own currentRound may already have advanced, so reading the
    // gate off currentRound there would answer for the wrong instant near the
    // threshold. Same fail-closed contract; see xchain_price_activation.js.
    _xchainPriceGateOpenFor(round) {
        let t = roundStartSeconds(round, this.epochStart, this.roundInterval);
        if (t === null) return false;
        return isXchainPriceActive(t, this.currentBtcNetwork);
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
            // Symmetric wiring for the increment: the streak advances on the same
            // durable event the reset does, so the live gauge and the hydrated value
            // share one semantic (item 4942).
            this._skippedHandler = () => this.noteRoundSkipped();
            this.oracleConsensus.on('round:skipped', this._skippedHandler);
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
        if (this._skippedHandler && this.oracleConsensus && typeof this.oracleConsensus.removeListener === 'function') {
            this.oracleConsensus.removeListener('round:skipped', this._skippedHandler);
            this._skippedHandler = null;
        }
        if (this.initialRoundTimer) {
            clearTimeout(this.initialRoundTimer);
            this.initialRoundTimer = null;
        }
        if (this.boundaryTimer) {
            clearTimeout(this.boundaryTimer);
            this.boundaryTimer = null;
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

    // Advance the skip streak on a round that became a durable non-finalized record.
    // Sole authoritative writer of the increment (wired to the consensus
    // 'round:skipped' event in start()), because that event fires once per round from
    // _markLocallySkipped's idempotent guard, which is precisely the round set
    // _hydrateFreshnessCounters counts. The three local increments this replaced did
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
        // Each diagnostic read carries its own *ReadError marker (item 5548):
        // without one a failed read serves the same empty array as a clean
        // round, and a consumer keying warn on droppedPairCount > 0 reads the
        // failure as healthy. Additive booleans, always emitted, false on success.
        let skippedRounds = [];
        let droppedPairs = [];
        let skippedRoundsReadError = false;
        let droppedPairsReadError = false;
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
            skippedRoundsReadError = true;
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
            droppedPairsReadError = true;
            console.warn('Oracle: failed to read per-pair drops for diagnostics:', err);
        }

        // Rounds ALREADY STORED outside the plausible band.
        //
        // PriceAggregator refuses an out-of-band round at write time, but that
        // cannot retract what is already in the table: a regtest venue's e2e price
        // sentinels (round 888100012 and its family, written straight into the DB by
        // the price-seed fixtures), a row from before this check existed, or a
        // hand-seeded probe. The lost-round detector walks the round range
        // in this table looking for holes, so ONE such row either swallows the whole
        // scan or invents a hundred-million-round gap. Naming them here lets a
        // detector drop them and still scan the real range.
        //
        // Reported, never deleted: this is a diagnostics read, and a row an operator
        // has not seen is not a row the hub should quietly destroy.
        let band = roundBand({ epochStartMs: this.epochStart, roundIntervalMs: this.roundInterval });
        let implausibleRounds = [];
        let implausibleRoundsReadError = false;
        if (band) {
            try {
                let rows = await this.db.doQuery(
                    'SELECT DISTINCT round_number FROM price_snapshots WHERE round_number > ? ' +
                    'ORDER BY round_number DESC LIMIT 50', [band.max]);
                implausibleRounds = rows.map(r => Number(r.round_number));
            } catch (err) {
                // Same additive-marker contract as the two reads above: without it a
                // failed read serves the same empty array as a clean table.
                implausibleRoundsReadError = true;
                console.warn('Oracle: failed to read out-of-band rounds for diagnostics:', err);
            }
            // EDGE-LATCHED on the highest out-of-band round, same posture as
            // _submissionsPruneDark: diagnostics are polled, so an unlatched warn
            // would reprint the same standing fault into every log tail forever.
            // A NEW out-of-band round (a higher one) re-announces itself.
            if (implausibleRounds.length && implausibleRounds[0] !== this._lastImplausibleRoundWarned) {
                this._lastImplausibleRoundWarned = implausibleRounds[0];
                console.warn('Oracle: price_snapshots carries ' + implausibleRounds.length +
                             ' round(s) past the plausible band: ' +
                             describeImplausibleRound(implausibleRounds[0], band));
            }
        }

        return {
            currentRound:             this.currentRound,
            roundStartTime:           this.roundStartTime,
            roundInterval:            this.roundInterval,
            submissionWindow:         this.submissionWindow,
            submissions:              info,
            skippedRounds:            skippedRounds,
            skippedCount:             skippedRounds.length,
            skippedRoundsReadError:   skippedRoundsReadError,
            droppedPairs:             droppedPairs,
            droppedPairCount:         droppedPairs.length,
            droppedPairsReadError:    droppedPairsReadError,
            // The band this hub judges round numbers against, and any row
            // already stored outside it. `roundBand` is null when the local schedule
            // is unresolvable, which a consumer must read as "not checked" rather
            // than as "clean" - hence the band rides beside the list.
            roundBand:                    band,
            implausibleRounds:            implausibleRounds,
            implausibleRoundCount:        implausibleRounds.length,
            implausibleRoundsReadError:   implausibleRoundsReadError,
            // Write-time refusals by the ingest paths, so a peer pushing out-of-band
            // rounds is visible even when nothing was ever stored.
            implausibleRoundRejections:   this.hub && this.hub.priceAggregator
                ? (this.hub.priceAggregator.implausibleRoundRejections || 0)
                : 0,
            failedSubmissionPersists:      this.failedSubmissionPersists,
            lastSubmissionPersistFailureRound: this.lastSubmissionPersistFailureRound,
            lastSubmissionPersistFailureCount: this.lastSubmissionPersistFailureCount,
            // Retention-sweep failures. Additive and count-only: the log carries the
            // driver message, this payload is the public read tier (see
            // _onSubmissionsPruneFailure). Without these a stalled sweep is visible
            // only to whoever is tailing the hub log.
            submissionsPruneFailures:          this.submissionsPruneFailures,
            lastSubmissionsPruneFailureRound:  this.lastSubmissionsPruneFailureRound,
            consecutiveSkippedRounds: this.consecutiveSkippedRounds,
            // PBFT finalization-timeout evictions (leader and follower seats),
            // mirroring StateCheckpointEngine getStats().round_timeouts so the
            // dashboard can alert on quorum-loss frequency (reviews 1468/1469).
            round_timeouts:           this.oracleConsensus
                ? (this.oracleConsensus._roundTimeouts || 0)
                : 0,
            // Rounds that opened on this hub and were recorded as abandoned before
            // finalizing. Broader than round_timeouts, which only sees the
            // two PBFT seats that held a pending round: the follower seat waiting on
            // a PROPOSE that never came moved no counter at all, which is how a lost
            // round left four of five validators with nothing to show for it.
            abandoned_rounds:         this.oracleConsensus
                ? (this.oracleConsensus._abandonedRounds || 0)
                : 0,
            lastAbandonedRound:       this.oracleConsensus
                ? (this.oracleConsensus._lastAbandonedRound != null
                    ? this.oracleConsensus._lastAbandonedRound : null)
                : null,
            // Rounds finalized with only one uncorrelated upstream behind a
            // normally-multi-source pair. A different failure from round_timeouts above:
            // the round reached quorum and was signed normally, so nothing else in this
            // payload moves, while PRICE v0 was published with no outlier rejection
            // behind it. Monotonic for the process, same as its sibling.
            single_source_rounds:     this.oracleConsensus
                ? (this.oracleConsensus._singleSourceRounds || 0)
                : 0,
            lastSingleSourceRound:    this.oracleConsensus
                ? (this.oracleConsensus._lastSingleSourceRound != null
                    ? this.oracleConsensus._lastSingleSourceRound : null)
                : null,
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

        // Align to the next round boundary, then run on a steady interval.
        // Capture the handle so stop() can cancel it before it fires; null it
        // inside the callback so the idempotency guard in start() sees a clean
        // slate once the interval has taken over.
        this.boundaryTimer = setTimeout(() => {
            this.boundaryTimer = null;
            runRound();
            this.roundTimer = setInterval(runRound, this.roundInterval);
        }, timeToNextRound);
    }

    // Execute a single round: fetch prices, broadcast submission.
    //
    // Round self-overlap guard (house convention:
    // FullNodeChallengeRound._tick). The round-number test below looks like a guard but
    // is not one: it fences a REPEAT of the same round, and the next interval fires with
    // a NEW round number, so it passes. Everything after it reads and writes
    // this.currentRound across several awaits (network resolve, chain-tip read, the
    // external price fetch, the XCHAIN/USD derive, the submission persist), so a round
    // that outruns roundInterval has its currentRound reassigned underneath it by the
    // round that fired on top: the slow round then broadcasts ITS prices stamped with the
    // NEW round number, records them over the newer round's own entry in the submission
    // map, and persists the audit row under that number. Peers keep only the first
    // submission per sender per round (_handleMessage), so the federation aggregates one
    // price set while this hub's own map, DB row and finalization see the other: it
    // disagrees with the quorum about what it submitted. The reassignment also clobbers
    // currentBtcBlockHeight, so both rounds anchor to a height neither of them read.
    // Skipping the overlapping round drops one round's submission, which is recoverable
    // (round numbers are wall-clock derived and resync on the next tick); interleaving
    // corrupts the round already in flight. The guard is a wrapper rather than inline so
    // the finally cannot be skipped by any of the body's early returns; a rejected fetch
    // must not wedge the oracle for the process lifetime.
    async _executeRound() {
        if (this._roundInFlight) {
            console.warn('Oracle: previous round still in flight; skipping this round tick');
            return;
        }
        this._roundInFlight = true;
        try {
            return await this._executeRoundInner();
        } finally {
            this._roundInFlight = false;
        }
    }

    async _executeRoundInner() {
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
            // Remembered for the derived-pair composition gate below, which needs the network
            // synchronously. Left UNSET when this resolve throws, so a hub that could
            // not determine its own network fails the gate closed rather than guessing.
            this.currentBtcNetwork = network;
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
        // Best-effort DB retention for the oracle_submissions audit table. Fire-and-
        // forget: a retention failure must never stall or crash a money-bearing
        // consensus round (same posture as the tolerated audit-row insert failures).
        // Not awaiting is the requirement; DISCARDING the rejection was not, and it
        // made this the only error path in the round loop with no log and no counter.
        // The round number is captured HERE rather than read inside the handler: the
        // sweep settles asynchronously and this.currentRound may already have advanced.
        this._pruneSubmissionsDb().catch(err => this._onSubmissionsPruneFailure(err, this.currentRound));

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
            // instead of the round vanishing without a trace. The skip streak is
            // advanced by that durable write's 'round:skipped' event, not here: a
            // local fetch failure the federation then salvages is not a skipped
            // round, and counting it here also double-counted a round that went on
            // to hit the chain-tip-fallback skip below (item 4942).
            this._scheduleFinalization(this.currentRound);
            return;
        }

        if (!prices || prices.length === 0) {
            console.warn('Oracle: No prices available for round ' + this.currentRound);
            // Same rationale as the fetch-failure path above: record the gap, and
            // let the durable skip write advance the streak.
            this._scheduleFinalization(this.currentRound);
            return;
        }

        // Append the derived XCHAIN/USD pair, if the activation gate has
        // opened on this network for this round. Deliberately OUTSIDE fetchPrices():
        // it is not fetched, it is computed from this validator's own BTC indexer
        // rows, and it must not be able to disturb the 36 API pairs. The source never
        // throws and returns null to abstain, so a hub without indexer access - or one
        // whose chain-tip anchor is unreliable - simply omits the pair while the rest
        // of the round proceeds untouched (§6 local-failure taxonomy).
        //
        // The gate is checked HERE rather than inside the source because it is not a
        // property of this hub's ability to derive: a hub that could compute the pair
        // perfectly well must still not submit it before the federation-wide instant
        // (§8 deploy order), regardless of local config.
        //
        // Fed this round's own BTC/USD from the fetch above, because the published
        // value is on-chain XCHAIN/BTC x the validator's own BTC/USD (§6).
        if (this.xchainPriceSource && this._xchainPriceGateOpen()) {
            let btcUsd = prices.find(p => p.coinPair === 'BTC/USD');
            let entry  = await this.xchainPriceSource.derive({
                round:            this.currentRound,
                referenceHeight:  this.currentBtcBlockHeight,
                btcUsdPrice:      btcUsd ? btcUsd.price : null,
                chainTipReliable: !this.chainTipFallbackActive,
            });
            if (entry) {
                // meta is local observability only (§10 step 6) and is NOT part of the
                // signed payload; strip it so the gossiped entry is shaped exactly like
                // every other pair and the canonical payload stays byte-identical.
                let { meta, ...wire } = entry;
                prices.push(wire);
                console.log('Oracle: derived ' + wire.coinPair + '=' + wire.price +
                    ' ' + formatXchainPriceMeta(meta));
            }
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
                        // _storeSkippedRound emits 'round:skipped' once the row is
                        // durable, which is what advances the streak (item 4942); a
                        // local increment here would double-count a round whose fetch
                        // had already failed.
                        this.oracleConsensus._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                            'chain-tip fallback active, anchor unreliable').catch(err =>
                            console.error('Oracle: Failed to store skipped round ' + round + ':', err.message));
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
    // A submission counts only if the chain-effective signer set or the local
    // registry attributes its PROVEN signing key. Shared definition (and the full
    // security argument) in lib/chain_signer_admission.js.
    _isRegisteredSender(envelope) {
        return isAdmissibleSigner(this.peerManager, envelope);
    }

    _handleMessage(envelope) {
        if (envelope.type !== ORACLE_PRICE_SUBMIT) return;

        let { round, prices, sources } = envelope.data;
        // Round 0 is a real, valid round (first interval after ORACLE_EPOCH_START); guard
        // on integer/non-negative, not falsiness, or a genesis round-0 submission is dropped.
        if (!Number.isInteger(round) || round < 0 || !prices || !Array.isArray(prices)) return;

        // Drop submissions whose signing key neither the chain nor the registry
        // attributes. Without this gate a single authorized key can broadcast many
        // submissions, each naming a distinct fake `sender`, Sybil-stuffing the
        // trimmed-median aggregate and the ORACLE_MIN_SUBMISSIONS diversity floor
        // from one node. The dedup below closes that off for good by keying on the
        // proven key rather than on the self-asserted sender.
        if (!this._isRegisteredSender(envelope)) return;

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

        // The PROVEN signing key of this envelope, which the gate above has already
        // established the chain or the registry attributes. Taken from the envelope
        // rather than looked up by addr in the registry: a chain-attributed
        // validator has no registry row, so the old lookup returned null for it and
        // its submission was dropped downstream as unresolvable. Dedup on this key:
        // one key may present under several addrs, so a sender-keyed first-wins
        // alone lets a single signing key submit once per addr, multiplying its
        // weight in the trimmed median and the ORACLE_MIN_SUBMISSIONS floor.
        let senderPubkey = provenPubkey(envelope);
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
            // Proven signing key (lowercase hex), or null only on a pre-bootstrap
            // envelope that carried none. OracleConsensus keys its snapshot
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

    // Bound the durable oracle_submissions audit table to the retention window.
    // The in-memory _pruneSubmissions only trims the Map; without this the table
    // grows monotonically. Keyed to round_number (indexed) so the DELETE is cheap
    // and deterministic; keeps the most recent submissionsRetentionRounds rounds.
    // oracle_submissions is diagnostic-only (finalized values live in
    // price_snapshots), so dropping aged rows is safe and never consensus-visible.
    async _pruneSubmissionsDb() {
        if (!this.submissionsRetentionRounds || this.submissionsRetentionRounds <= 0) return;
        let cutoff = this.currentRound - this.submissionsRetentionRounds;
        if (cutoff <= 0) return;
        let result = await this.db.doQuery(
            'DELETE FROM oracle_submissions WHERE round_number < ?',
            [cutoff]);
        let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
        if (deleted > 0) {
            console.log('Oracle submissions retention: pruned ' + deleted +
                ' rows older than round ' + cutoff + ' (keep ' +
                this.submissionsRetentionRounds + ' rounds)');
        }
        // Latch clears only after a DELETE actually completed, never on the two
        // early returns above: those mean the sweep did not run, which is not
        // evidence that a dark DB is reachable again.
        if (this._submissionsPruneDark) {
            this._submissionsPruneDark = false;
            console.warn('Oracle submissions retention: prune recovered at round ' +
                this.currentRound + ' (' + this.submissionsPruneFailures +
                ' failure(s) since start)');
        }
    }

    // The only trace a failed retention sweep leaves. Counters are monotonic (like
    // failedSubmissionPersists) so a fault that has since recovered is still visible
    // to getSubmissionsInfo; the warn fires once per dark spell, on the transition in.
    //
    // The error MESSAGE is logged and deliberately not put on the counters:
    // getoraclesubmissions is in the hub's public read tier (only getallconfigs is a
    // gated read), and a raw driver error can carry a DB user, host or schema detail.
    // getSubmissionsInfo already draws this line for droppedPairsReadError, which
    // exposes a boolean and logs the exception.
    _onSubmissionsPruneFailure(err, round) {
        this.submissionsPruneFailures++;
        this.lastSubmissionsPruneFailureRound = round != null ? round : this.currentRound;
        if (this._submissionsPruneDark) return;
        this._submissionsPruneDark = true;
        console.warn('Oracle submissions retention: prune FAILED at round ' +
            this.lastSubmissionsPruneFailureRound +
            '; the oracle_submissions audit table will grow until it recovers: ' +
            ((err && err.message) ? err.message : err));
    }
}

module.exports = OracleRound;
// Exported for test only: the §10 step 6 audit line is a deliverable of this item,
// so it is asserted rather than eyeballed in a log.
module.exports.formatXchainPriceMeta = formatXchainPriceMeta;
