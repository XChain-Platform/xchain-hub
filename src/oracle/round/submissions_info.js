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
 * XChain Hub - Oracle Round Diagnostics Payload
 *
 * The getoraclesubmissions read: the in-memory submission map, the durable
 * skipped/dropped/out-of-band reads beside it, and the field groups that make
 * up the payload. The groups are assembled in the order they are declared, so
 * the payload's key order is the one consumers have always seen.
 *
 ********************************************************************/

const { roundBand, describeImplausibleRound } = require('../oracle_round_band.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Get all submissions as a serializable object (for JSON-RPC diagnostics)
    async getSubmissionsInfo() {
        let info = collectSubmissionsByRound.call(this);

        let skippedRounds = [];
        let droppedPairs = [];
        let skippedRoundsReadError = false;
        let droppedPairsReadError = false;
        try {
            let rows = await this.db.findPriceSnapshotRoundsSkippedWithNoFinalized();
            skippedRounds = rows.map(r => Number(r.round_number));
        } catch (err) {
            // Non-fatal: diagnostics still return the in-memory state if the read fails
            skippedRoundsReadError = true;
            logger.warn(nodeUtil.format('Oracle: failed to read skipped rounds for diagnostics:', err));
        }
        try {
            // Per-pair drops (item #180): pairs skipped inside a round that
            // otherwise finalized (aggregation clamp / deviation gate / trim, or
            // absent from the leader's proposal), so a single pair silently
            // ceasing to publish is observable while the round looks healthy.
            let rows = await this.db.findPriceSnapshotsSkippedWithFinalizedRound();
            droppedPairs = rows.map(r => ({ round: Number(r.round_number), coinPair: r.coin_pair }));
        } catch (err) {
            droppedPairsReadError = true;
            logger.warn(nodeUtil.format('Oracle: failed to read per-pair drops for diagnostics:', err));
        }

        let band = roundBand({ epochStartMs: this.epochStart, roundIntervalMs: this.roundInterval });
        let implausibleRounds = [];
        let implausibleRoundsReadError = false;
        if (band) {
            try {
                let rows = await this.db.findPriceSnapshotRoundsAfter(band.max);
                implausibleRounds = rows.map(r => Number(r.round_number));
            } catch (err) {
                // Same additive-marker contract as the two reads above: without it a
                // failed read serves the same empty array as a clean table.
                implausibleRoundsReadError = true;
                logger.warn(nodeUtil.format('Oracle: failed to read out-of-band rounds for diagnostics:', err));
            }
            warnNewImplausibleRound.call(this, implausibleRounds, band);
        }

        return Object.assign({},
            roundStateFields.call(this, info),
            skipAndDropFields(skippedRounds, skippedRoundsReadError, droppedPairs, droppedPairsReadError),
            outOfBandFields.call(this, band, implausibleRounds, implausibleRoundsReadError),
            persistCounterFields.call(this),
            consensusGaugeFields.call(this),
            chainTipFields.call(this));
    }

};

// Every round still held in memory, sender by sender, as the plain object the
// JSON-RPC layer serializes.
function collectSubmissionsByRound() {
    let info = {};
    for (let [round, subs] of this.submissions) {
        info[round] = {};
        for (let [sender, data] of subs) {
            info[round][sender] = data;
        }
    }
    return info;
}

// EDGE-LATCHED on the highest out-of-band round, same posture as
// _submissionsPruneDark: diagnostics are polled, so an unlatched warn
// would reprint the same standing fault into every log tail forever.
// A NEW out-of-band round (a higher one) re-announces itself.
function warnNewImplausibleRound(implausibleRounds, band) {
    if (implausibleRounds.length && implausibleRounds[0] !== this._lastImplausibleRoundWarned) {
        this._lastImplausibleRoundWarned = implausibleRounds[0];
        logger.warn('Oracle: price_snapshots carries ' + implausibleRounds.length +
                     ' round(s) past the plausible band: ' +
                     describeImplausibleRound(implausibleRounds[0], band));
    }
}

// The live round's own cadence and its in-memory submissions.
function roundStateFields(info) {
    return {
        currentRound:             this.currentRound,
        roundStartTime:           this.roundStartTime,
        roundInterval:            this.roundInterval,
        submissionWindow:         this.submissionWindow,
        submissions:              info
    };
}

// Recently skipped rounds, so operators can detect feed-outage gaps straight
// from the diagnostics RPC. In-memory submission maps only retain the current
// and previous round (see pruneSubmissions), so a missed round is otherwise
// invisible; the durable record lives in price_snapshots (status='skipped',
// written when a round produces no usable prices).
// skippedRounds keeps its whole-round semantic (no pair finalized): the
// per-pair skip markers _storeSnapshot writes for partially-dropped rounds
// (item #180) must not inflate the feed-outage count. Those partial drops
// surface separately as droppedPairs.
// Each diagnostic read carries its own *ReadError marker (item 5548):
// without one a failed read serves the same empty array as a clean
// round, and a consumer keying warn on droppedPairCount > 0 reads the
// failure as healthy. Additive booleans, always emitted, false on success.
function skipAndDropFields(skippedRounds, skippedRoundsReadError, droppedPairs, droppedPairsReadError) {
    return {
        skippedRounds:            skippedRounds,
        skippedCount:             skippedRounds.length,
        skippedRoundsReadError:   skippedRoundsReadError,
        droppedPairs:             droppedPairs,
        droppedPairCount:         droppedPairs.length,
        droppedPairsReadError:    droppedPairsReadError
    };
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
function outOfBandFields(band, implausibleRounds, implausibleRoundsReadError) {
    return {
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
            : 0
    };
}

// Audit-row and retention-sweep failures, plus the live skip streak.
function persistCounterFields() {
    return {
        failedSubmissionPersists:      this.failedSubmissionPersists,
        lastSubmissionPersistFailureRound: this.lastSubmissionPersistFailureRound,
        lastSubmissionPersistFailureCount: this.lastSubmissionPersistFailureCount,
        // Retention-sweep failures. Additive and count-only: the log carries the
        // driver message, this payload is the public read tier (see
        // onSubmissionsPruneFailure). Without these a stalled sweep is visible
        // only to whoever is tailing the hub log.
        submissionsPruneFailures:          this.submissionsPruneFailures,
        lastSubmissionsPruneFailureRound:  this.lastSubmissionsPruneFailureRound,
        consecutiveSkippedRounds: this.consecutiveSkippedRounds
    };
}

// The consensus-side round gauges this hub reads off its oracle engine.
function consensusGaugeFields() {
    return {
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
        oracle_fetch_failures:    this.fetchFailures
    };
}

// Freshness of the last finalized round and of the BTC anchor behind it.
function chainTipFields() {
    return {
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
