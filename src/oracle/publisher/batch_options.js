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
 * XChain Hub - Oracle Publisher: construction of the PRICE batch rail and landing watch
 *
 * The second half of the constructor: the batch cadence config, the derived window
 * ceiling, the in-memory batch state, and the confirmed-UTXO reserve plus
 * confirmation watchdog. Split from the rail it configures so the clamp argument
 * and the sawtooth measurement it rests on stay next to the numbers they size.
 *
 ********************************************************************/

'use strict';

const hubConfig = require('../../config');
const { positiveIntConfig } = require('../../lib/config_int.js');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS } = require('../../constants.js');
const { worstCaseSnapshotAgeMs, maxBatchWindowRounds, pinnedMaxPriceAgeMs,
        DEFAULT_BATCH_LANDING_RESERVE_MS,
        LEGACY_BATCH_WINDOW_ROUNDS } = require('../price_batch_cadence.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// How often that sweep runs when there is nothing to catch up on. An hour at the
// shipped defaults: the refusals it recovers from are either transient or content
// drift that reconciliation repairs, and neither gets better by asking again sooner.
// See startBufferCatchupSweep.
const DEFAULT_BATCH_CATCHUP_INTERVAL_MS = 3600000;
// ...and how often it runs while a BACKLOG deeper than one sweep is waiting. Four
// windows an hour is a drain rate of 96 windows a day, and the fleet was measured on
// 2026-09-07 carrying 697 closed buffered windows per hub, which that rate needs seven
// months to walk once. The hourly idle is what made the backlog structurally
// undrainable; nothing about the serialization required it, because a sweep never has
// more than CATCHUP_WINDOWS_PER_SWEEP assemblies outstanding either way (see
// runCatchupSweepTick's in-flight await). At a minute a 697-window backlog is walked
// in about three hours instead.
const DEFAULT_BATCH_CATCHUP_BACKLOG_INTERVAL_MS = 60000;
// Failed catch-up attempts after which a window is retired from the sweep, and the
// minimum age of its FIRST failed attempt before that retirement may happen.
//
// Both bounds together, because either alone retires the wrong windows. A count alone
// retires a window that lost six attempts in six minutes to one peer rebooting; an age
// alone retires a window that has simply been waiting behind a long backlog for its
// first turn. What the pair describes is the only shape that is actually hopeless: a
// window this hub has proposed repeatedly, over hours, that the federation will not
// co-sign - the [32,32] "no finalized rounds in the window locally" and [46,47] "round
// 46 proposed but not finalized here" refusals measured on the fleet, which are content
// divergences no number of re-proposals can repair. Retiring those is what lets the
// windows behind them reach a slot.
const DEFAULT_CATCHUP_MAX_ATTEMPTS   = 6;
const DEFAULT_CATCHUP_RETIRE_AFTER_MS = 6 * 3600000;

// Millisecond knobs where 0 is a meaningful setting (it disables the timer it sizes),
// which positiveIntConfig cannot express because it rejects 0 as out of range.
function nonNegativeIntConfig(raw, dflt, name) {
    if (raw === undefined || raw === null || raw === '') return dflt;
    let n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 0) return n;
    logger.warn('config: ' + name + '="' + raw + '" is not a non-negative integer; using the default (' + dflt + ')');
    return dflt;
}

module.exports = {

    initBatchRailConfig(hub, cfg) {
        // ---------------- PRICE batch rail (spec section 7) ----------------

        // The network name still keys the remaining per-network rules the batch rail
        // reads (pair widening, sig tally, stake-weighted quorum).
        this.network = (hub && hub.network) ? String(hub.network) : '';

        // Read BEFORE the window size: the window ceiling is derived from the grace,
        // the round cadence and the pinned staleness bound (see below).
        this.batchGraceMs         = positiveIntConfig(
            hubConfig.ORACLE_BATCH_GRACE_MS || cfg.ORACLE_BATCH_GRACE_MS,
            300000, 'ORACLE_BATCH_GRACE_MS');
        this.batchBufferMaxRounds = positiveIntConfig(
            hubConfig.ORACLE_BATCH_BUFFER_MAX_ROUNDS || cfg.ORACLE_BATCH_BUFFER_MAX_ROUNDS,
            4032, 'ORACLE_BATCH_BUFFER_MAX_ROUNDS');
        this.batchCatchupIntervalMs = positiveIntConfig(
            hubConfig.ORACLE_BATCH_CATCHUP_INTERVAL_MS || cfg.ORACLE_BATCH_CATCHUP_INTERVAL_MS,
            DEFAULT_BATCH_CATCHUP_INTERVAL_MS, 'ORACLE_BATCH_CATCHUP_INTERVAL_MS');
        // The backlog cadence, clamped so it can never be SLOWER than the idle one: a
        // deployment that deliberately slows the sweep down has not asked for a faster
        // one under load.
        this.batchCatchupBacklogIntervalMs = Math.min(
            this.batchCatchupIntervalMs,
            positiveIntConfig(
                hubConfig.ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS || cfg.ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS,
                DEFAULT_BATCH_CATCHUP_BACKLOG_INTERVAL_MS, 'ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS'));
        // 0 disables retirement entirely: every window is re-proposed forever, which is
        // the pre-fix behaviour and the right setting for an operator who would
        // rather a stuck backlog stay visible than be retired quietly.
        this.catchupMaxAttempts = nonNegativeIntConfig(
            hubConfig.ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS || cfg.ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS,
            DEFAULT_CATCHUP_MAX_ATTEMPTS, 'ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS');
        this.catchupRetireAfterMs = nonNegativeIntConfig(
            hubConfig.ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS || cfg.ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS,
            DEFAULT_CATCHUP_RETIRE_AFTER_MS, 'ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS');

    },

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
    initBatchWindow(cfg) {
        this.roundIntervalMs      = positiveIntConfig(
            hubConfig.ORACLE_ROUND_INTERVAL || cfg.ORACLE_ROUND_INTERVAL,
            DEFAULT_ORACLE_ROUND_INTERVAL_MS, 'ORACLE_ROUND_INTERVAL');
        this.batchLandingReserveMs = nonNegativeIntConfig(
            hubConfig.ORACLE_BATCH_LANDING_RESERVE_MS || cfg.ORACLE_BATCH_LANDING_RESERVE_MS,
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
            hubConfig.ORACLE_BATCH_WINDOW_ROUNDS || cfg.ORACLE_BATCH_WINDOW_ROUNDS,
            cadence.ceiling === null ? LEGACY_BATCH_WINDOW_ROUNDS : cadence.ceiling,
            'ORACLE_BATCH_WINDOW_ROUNDS');
        if (cadence.ceiling !== null && this.batchWindowRounds > cadence.ceiling) {
            logger.warn('config: ORACLE_BATCH_WINDOW_ROUNDS=' + this.batchWindowRounds +
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
            logger.warn('OraclePublisher: no batch window fits the ' +
                Math.round(this.oracleMaxPriceAgeMs / 1000) + 's fee-price staleness bound at a ' +
                Math.round(this.roundIntervalMs / 1000) + 's round interval with a ' +
                Math.round(this.batchGraceMs / 1000) + 's grace and a ' +
                Math.round(this.batchLandingReserveMs / 1000) + 's landing reserve. ' +
                'Publishing one round per batch anyway; native-coin fees will still go ' +
                'unpriceable between batches until the round interval or the grace comes down.');
        }
    },

    // The buffer, the window scheduler state and the batch counters.
    initBatchState() {
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
        // windowIndex -> { count, firstAt } for windows the catch-up sweep has proposed
        // and that produced no wire. Cleared the moment a window is assembled, so what
        // it holds is exactly the set of windows that keep failing. Bounded by the
        // pending set itself, which pendingCatchupWindows already bounds.
        this._catchupAttempts        = new Map();
        // Where the next sweep starts in the pending list. Without it every sweep spent
        // all four of its slots on the same four oldest windows, so a backlog whose head
        // was permanently unco-signable never advanced past it however long it ran: the
        // windows behind the head were never once proposed. This is the other half of
        // "structurally cannot drain".
        this._catchupCursor          = 0;
        this.batchCatchupRetiredWindows = 0;
        // Set by stop(), so a sweep tick that is mid-await when the publisher stops does
        // not re-arm the timer stop() just cleared.
        this._stopped                = false;
        // Rounds shed from the buffer because a batch carrying them was seen to land:
        // via the indexer's push into PriceAggregator (landedBatchPrunedRounds) or via
        // the pre-sweep read of the landing chain's indexer (chainReconcilePrunedRounds).
        // A backlog that climbs while both stay flat is a hub that hears no pushes and
        // cannot reach its indexer, which is the condition that re-publishes duplicates.
        this.landedBatchPrunedRounds   = 0;
        this.chainReconcileRuns        = 0;
        this.chainReconcilePrunedRounds = 0;
        this.chainReconcileFailures    = 0;
        this._chainReconcileWarned     = null;   // last failure reason logged, to log each once
    },

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
    initLandingState(cfg) {
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
        // a caller that drives checkPublishedConfirmations itself).
        this.confirmCheckIntervalMs   = nonNegativeIntConfig(
            hubConfig.ORACLE_PUBLISH_CONFIRM_CHECK_MS || cfg.ORACLE_PUBLISH_CONFIRM_CHECK_MS,
            300000, 'ORACLE_PUBLISH_CONFIRM_CHECK_MS');
        // Age past which a still-unconfirmed broadcast is logged rather than only
        // counted. DOGE targets one-minute blocks, so half an hour of silence is a
        // stall an operator should see, not ordinary latency.
        this.confirmStaleMs           = nonNegativeIntConfig(
            hubConfig.ORACLE_PUBLISH_CONFIRM_STALE_MS || cfg.ORACLE_PUBLISH_CONFIRM_STALE_MS,
            1800000, 'ORACLE_PUBLISH_CONFIRM_STALE_MS');
    },

};
