/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Match the protocol's maximum batch size. This keeps the one-table presence
// read, SQL placeholder list and signature/ingest work bounded while allowing a
// maximum-size valid batch to fit in one pass.
const PRICE_RESTORE_ROUND_CAP = 256;
// An old indexer may be upgraded after the hub. Retry often enough to recover
// without a hub restart, but not often enough to turn every repair tick into an
// unsupported RPC and log line during a rolling deployment.
const PRICE_RESTORE_UNSUPPORTED_BACKOFF_MS = 30 * 60_000;
// No cursor table is added for a best-effort repair. On restart, revisit roughly
// four weeks at the production cadence, which covers recent reorg losses without
// repeating the historical walk from round zero.
const PRICE_RESTORE_RECENT_ROUNDS = 4096;
const MAX_ROUND = Number.MAX_SAFE_INTEGER;
const PRICE_LANDING_COIN = 'DOGE';

function stoppedResult() {
    return { ran: false, reason: 'repair stopped' };
}

function warnRestoreOnce(reason) {
    if (this._priceRestoreWarned === reason) return;
    this._priceRestoreWarned = reason;
    logger.warn('PriceAggregator: active-chain PRICE repair is waiting (' + reason + ')');
}

function requestedRange(windows, cursor, walkingOlder, oldest) {
    if (Array.isArray(windows) && windows.length > 0) {
        let first = Math.min(...windows.map(w => Number(w.first)));
        let last = Math.max(...windows.map(w => Number(w.last)));
        return { first, last, bounded: true };
    }
    if (walkingOlder) {
        return { first: Math.max(oldest, cursor - PRICE_RESTORE_ROUND_CAP + 1),
            last: cursor, bounded: false, older: true };
    }
    return { first: cursor, last: MAX_ROUND, bounded: false };
}

function resetBackgroundWalk() {
    this._priceRestoreCursor = null;
    this._priceRestoreRecentStart = null;
    this._priceRestoreOldestRound = null;
    this._priceRestoreWalkingOlder = false;
}

function advanceBackgroundWalk(range, chosen, answer) {
    if (range.older) {
        this._priceRestoreCursor = range.first - 1;
        if (this._priceRestoreCursor < this._priceRestoreOldestRound)
            resetBackgroundWalk.call(this);
        return;
    }
    let finished = chosen.batches.length === answer.batches.length && !answer.truncated;
    if (chosen.batches.length > 0 && !finished) {
        let last = chosen.batches[chosen.batches.length - 1];
        this._priceRestoreCursor = Number(last.last_round) + 1;
        return;
    }
    if (this._priceRestoreRecentStart > this._priceRestoreOldestRound) {
        this._priceRestoreWalkingOlder = true;
        this._priceRestoreCursor = this._priceRestoreRecentStart - 1;
    } else {
        resetBackgroundWalk.call(this);
    }
}

function selectBatches(batches, range) {
    let selected = [], rounds = new Set();
    for (let batch of (Array.isArray(batches) ? batches : [])) {
        let first = Math.max(Number(batch.first_round), range.first);
        let last = Math.min(Number(batch.last_round), range.last);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) continue;
        let additions = [];
        for (let round = first; round <= last; round++) if (!rounds.has(round)) additions.push(round);
        if (rounds.size > 0 && rounds.size + additions.length > PRICE_RESTORE_ROUND_CAP) break;
        if (additions.length > PRICE_RESTORE_ROUND_CAP) continue;
        additions.forEach(round => rounds.add(round));
        selected.push(batch);
    }
    return { batches: selected, rounds: Array.from(rounds).sort((a, b) => a - b) };
}

function presentRounds(rows) {
    let present = new Set();
    for (let row of (Array.isArray(rows) ? rows : [])) {
        let round = Number(row && row.round_number);
        if (Number.isSafeInteger(round) && row.status !== 'skipped') present.add(round);
    }
    return present;
}

async function initializeBackgroundWalk(windows) {
    if ((Array.isArray(windows) && windows.length > 0) || this._priceRestoreCursor !== null) return null;
    let latest = await this.db.findLatestPriceSnapshotRound();
    if (this._priceRestoreStopped) return stoppedResult();
    let oldest = await this.db.findOldestPriceSnapshotRound();
    if (this._priceRestoreStopped) return stoppedResult();
    this._priceRestoreOldestRound = Math.min(oldest, latest);
    this._priceRestoreRecentStart = Math.max(this._priceRestoreOldestRound,
        latest - PRICE_RESTORE_RECENT_ROUNDS + 1);
    this._priceRestoreWalkingOlder = false;
    this._priceRestoreCursor = this._priceRestoreRecentStart;
    return null;
}

async function prepareRestorePass(windows) {
    let stopped = await initializeBackgroundWalk.call(this, windows);
    if (stopped) return { result: stopped };
    let range = requestedRange(windows, this._priceRestoreCursor || 0,
        this._priceRestoreWalkingOlder, this._priceRestoreOldestRound || 0);
    let answer = await this.fetchPriceBatchesForRestore(range.first, range.last);
    if (this._priceRestoreStopped) return { result: stoppedResult() };
    if (!answer) return { result: { ran: false, reason: 'batch metadata unavailable' } };
    let chosen = selectBatches(answer.batches, range);
    if (chosen.batches.length === 0) {
        if (!range.bounded) advanceBackgroundWalk.call(this, range, chosen, answer);
        return { result: { ran: true, considered: 0, restored: 0 } };
    }
    let rows = await this.db.findPriceSnapshotRowsForRounds(chosen.rounds);
    if (this._priceRestoreStopped) return { result: stoppedResult() };
    return { range, answer, chosen, rows, present: presentRounds(rows) };
}

function targetRounds(batch, range, present, rewritePending) {
    let targets = new Set();
    for (let round = Number(batch.first_round); round <= Number(batch.last_round); round++) {
        if (round >= range.first && round <= range.last &&
            (!present.has(round) || rewritePending.has(round))) targets.add(round);
    }
    return targets;
}

async function deleteRefusedRewrite(payload) {
    if (this._priceRestoreStopped) return 0;
    let action = Number(payload && payload.action_index);
    let generation = Number(payload && payload.push_generation);
    if (!Number.isSafeInteger(action) || !Number.isSafeInteger(generation) || generation < 0) return 0;
    await this.db.insertPriceTombstonesForRetraction(
        PRICE_LANDING_COIN, action, action, generation, true, true);
    if (this._priceRestoreStopped) return 0;
    let result = await this.db.deletePriceSnapshotsForRetraction(
        PRICE_LANDING_COIN, action, action, generation, true, true);
    let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
    if (deleted > 0) this.emit('row:deleted', { table: 'price_snapshots', source_chain: PRICE_LANDING_COIN,
        from_action_index: action, to_action_index: action, retraction_generation: generation });
    return deleted;
}

async function restoreBatch(batch, state, now) {
    let targets = targetRounds(batch, state.range, state.present, state.rewritePending);
    if (targets.size === 0) return {};
    let fetched = await this.fetchPriceBatchPayloadForRestore(batch.action_index);
    if (this._priceRestoreStopped) return { result: stoppedResult() };
    if (fetched && fetched.unsupported) {
        this._priceRestoreUnsupportedUntil = now + PRICE_RESTORE_UNSUPPORTED_BACKOFF_MS;
        logger.warn('PriceAggregator: the landing indexer does not provide getpricebatchpayload; ' +
            'active-chain PRICE repair will retry after a 30 minute compatibility backoff');
        return { result: { ran: false, reason: 'indexer method unavailable' } };
    }
    if (!fetched || !fetched.payload) {
        warnRestoreOnce.call(this, (fetched && fetched.error) || 'batch payload unavailable');
        return {};
    }
    let requestedAction = Number(batch.action_index);
    if (fetched.payload.source_chain !== PRICE_LANDING_COIN ||
        Number(fetched.payload.action_index) !== requestedAction) {
        warnRestoreOnce.call(this, 'batch payload identity does not match its request');
        return { refused: targets.size };
    }
    return ingestRestoredBatch.call(this, fetched.payload, targets, state);
}

async function ingestRestoredBatch(payload, targets, state) {
    let target = new Set(payload.rounds
        .map(round => Number(round && round.round))
        .filter(round => Number.isSafeInteger(round) && round >= state.range.first &&
            round <= state.range.last && targets.has(round)));
    if (target.size === 0) return {};
    let existingTargets = [...target].filter(round => state.present.has(round));
    let result = await this.receiveValidatedBatch(PRICE_LANDING_COIN, payload,
        { existingRows: state.rows, targetRounds: target });
    if (this._priceRestoreStopped) return { result: stoppedResult() };
    if (result && result.accepted) {
        target.forEach(round => state.present.add(round));
        existingTargets.forEach(round => state.rewritePending.delete(round));
        return { restored: result.stored, rewritten: existingTargets.length };
    }
    if (result && result.reason === 'stale (retracted generation)' && existingTargets.length > 0)
        await deleteRefusedRewrite.call(this, payload);
    return { refused: target.size };
}

async function restoreChosenBatches(prepared, rewriteRounds, now) {
    let state = Object.assign(prepared, {
        rewritePending: new Set(Array.isArray(rewriteRounds) ? rewriteRounds.map(Number) : [])
    });
    let totals = { restored: 0, rewritten: 0, refused: 0 };
    for (let batch of prepared.chosen.batches) {
        let outcome = await restoreBatch.call(this, batch, state, now);
        if (outcome.result) return outcome.result;
        totals.restored += outcome.restored || 0;
        totals.rewritten += outcome.rewritten || 0;
        totals.refused += outcome.refused || 0;
    }
    this._priceRestoreWarned = null;
    if (!prepared.range.bounded)
        advanceBackgroundWalk.call(this, prepared.range, prepared.chosen, prepared.answer);
    if (totals.restored > 0) logger.info('PriceAggregator: restored ' + totals.restored +
        ' PRICE round(s) from valid active-chain batches');
    return Object.assign({ ran: true, considered: prepared.chosen.rounds.length }, totals);
}

async function runPriceChainRestorePass(windows, rewriteRounds) {
    if (this._priceRestoreStopped) return stoppedResult();
    let now = this.priceRestoreNow();
    if (this._priceRestoreUnsupportedUntil > now)
        return { ran: false, reason: 'indexer method unavailable' };
    try {
        let prepared = await prepareRestorePass.call(this, windows);
        if (prepared.result) return prepared.result;
        return await restoreChosenBatches.call(this, prepared, rewriteRounds, now);
    } catch (e) {
        warnRestoreOnce.call(this, nodeUtil.format(e && e.message ? e.message : e));
        return { ran: false, reason: e && e.message ? e.message : String(e) };
    }
}

module.exports = {
    PRICE_RESTORE_ROUND_CAP,
    PRICE_LANDING_COIN,
    runPriceChainRestorePass,
    stoppedResult,
    warnRestoreOnce
};
