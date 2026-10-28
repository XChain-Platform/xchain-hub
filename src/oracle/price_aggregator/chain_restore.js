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
 * XChain Hub - restore PRICE rounds from valid active-chain batches
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const axios = require('axios');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Match the protocol's maximum batch size. This keeps the one-table presence
// read, SQL placeholder list and signature/ingest work bounded while allowing a
// maximum-size valid batch to fit in one pass.
const PRICE_RESTORE_ROUND_CAP = 256;
const PRICE_RESTORE_INTERVAL_MS = 60_000;
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

function stoppedResult() {
    return { ran: false, reason: 'repair stopped' };
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

function resolveQueuedAsStopped() {
    for (let job of (this._priceRestoreQueue || []).splice(0)) job.resolve(stoppedResult());
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
    if (deleted > 0) this.emit('row:deleted', { table: 'price_snapshots', source_chain: PRICE_LANDING_COIN, from_action_index: action,
        to_action_index: action, retraction_generation: generation });
    return deleted;
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

function warnRestoreOnce(reason) {
    if (this._priceRestoreWarned === reason) return;
    this._priceRestoreWarned = reason;
    logger.warn('PriceAggregator: active-chain PRICE repair is waiting (' + reason + ')');
}

module.exports = {

    // Resolve the landing indexer for standalone hubs that do not construct an
    // OraclePublisher. Validator hubs normally use the publisher reader below.
    async resolvePriceLandingIndexer() {
        let url = null;
        if (this.hub && typeof this.hub.resolveIndexerUrl === 'function')
            url = await this.hub.resolveIndexerUrl(PRICE_LANDING_COIN);
        else
            url = hubConfig.DOGE_INDEXER_API_URL || hubConfig.DOGE_INDEXER_URL || null;
        if (!url) throw new Error('no DOGE indexer URL configured');
        let cfg = (this.hub && this.hub.p2pConfig) || {};
        return { url, key: hubConfig.DOGE_INDEXER_API_KEY || cfg.DOGE_INDEXER_API_KEY || '' };
    },

    async priceLandingRpc(method, params) {
        let target = await this.resolvePriceLandingIndexer();
        let headers = { 'Content-Type': 'application/json' };
        if (target.key) headers['x-api-key'] = target.key;
        let response = await axios.post(target.url,
            { jsonrpc: '2.0', method, params: params || {}, id: 1 },
            { headers, timeout: 15000 });
        if (response && response.data && response.data.error) {
            let err = new Error('indexer RPC error: ' + JSON.stringify(response.data.error));
            err.rpcCode = response.data.error.code;
            throw err;
        }
        return response && response.data ? response.data.result : null;
    },

    async fetchPriceBatchesForRestore(first, last) {
        let publisher = this.hub && this.hub.oraclePublisher;
        if (publisher && typeof publisher.fetchLandedBatches === 'function')
            return publisher.fetchLandedBatches(first, last, PRICE_RESTORE_ROUND_CAP);
        let result = await this.priceLandingRpc('getpricebatches',
            { first_round: first, last_round: last, limit: PRICE_RESTORE_ROUND_CAP });
        if (!result || !Array.isArray(result.batches)) throw new Error('invalid getpricebatches response');
        return result;
    },

    async fetchPriceBatchPayloadForRestore(actionIndex) {
        let publisher = this.hub && this.hub.oraclePublisher;
        if (publisher && typeof publisher.fetchLandedBatchPayload === 'function')
            return publisher.fetchLandedBatchPayload(actionIndex);
        try {
            let payload = await this.priceLandingRpc('getpricebatchpayload', { action_index: actionIndex });
            if (!payload || !Array.isArray(payload.rounds) || !Array.isArray(payload.sigs))
                return { error: 'invalid price batch payload response' };
            return { payload };
        } catch (e) {
            if (e && e.rpcCode === -32601) return { unsupported: true };
            return { error: e && e.message ? e.message : 'price batch payload read failed' };
        }
    },

    async priceRoundsCarriedByChain(rounds) {
        let publisher = this.hub && this.hub.oraclePublisher;
        if (publisher && typeof publisher.roundsCarriedByChain === 'function')
            return publisher.roundsCarriedByChain(rounds);
        if (!Array.isArray(rounds) || rounds.length === 0) return new Set();
        let answer = await this.fetchPriceBatchesForRestore(Math.min(...rounds), Math.max(...rounds));
        let carried = new Set();
        for (let round of rounds)
            if (answer.batches.some(batch => round >= Number(batch.first_round) &&
                round <= Number(batch.last_round))) carried.add(round);
        return carried;
    },

    priceRestoreSetInterval(fn, ms) {
        return setInterval(fn, ms);
    },

    priceRestoreClearInterval(handle) {
        clearInterval(handle);
    },

    startPriceChainRestore() {
        if (this._priceRestoreTimer) return false;
        this._priceRestoreStopped = false;
        this._priceRestoreTimer = this.priceRestoreSetInterval(() => {
            if (this._priceRestoreStopped || this._priceRestoreRunning ||
                (this._priceRestoreQueue || []).some(job => job.background)) return;
            let repair = this.repairPriceRoundsFromChain();
            this._lastPriceRestoreBackground = repair;
            repair.catch(e => {
                warnRestoreOnce.call(this, e && e.message ? e.message : String(e));
            });
        }, PRICE_RESTORE_INTERVAL_MS);
        if (typeof this._priceRestoreTimer.unref === 'function') this._priceRestoreTimer.unref();
        return true;
    },

    stopPriceChainRestore() {
        this._priceRestoreStopped = true;
        if (this._priceRestoreTimer) this.priceRestoreClearInterval(this._priceRestoreTimer);
        this._priceRestoreTimer = null;
        for (let scheduled of (this._priceRestoreScheduled || [])) {
            clearImmediate(scheduled.handle);
            scheduled.resolve({ ran: false, reason: 'repair stopped' });
        }
        if (this._priceRestoreScheduled) this._priceRestoreScheduled.clear();
        resolveQueuedAsStopped.call(this);
    },

    priceRestoreNow() {
        return Date.now();
    },

    // Retractions acknowledge before repair begins. The serialized repair queue
    // still guarantees that this exact window runs immediately after an active pass.
    schedulePriceChainRestore(windows, rewriteRounds) {
        if (this._priceRestoreStopped) return Promise.resolve(stoppedResult());
        if (!this._priceRestoreScheduled) this._priceRestoreScheduled = new Set();
        let resolveScheduled;
        let promise = new Promise(resolve => { resolveScheduled = resolve; });
        let scheduled = { resolve: resolveScheduled, handle: null };
        scheduled.handle = setImmediate(() => {
            this._priceRestoreScheduled.delete(scheduled);
            if (this._priceRestoreStopped) {
                resolveScheduled(stoppedResult());
                return;
            }
            this.repairPriceRoundsFromChain(windows, rewriteRounds).then(resolveScheduled);
        });
        this._priceRestoreScheduled.add(scheduled);
        this._lastPriceRestoreSchedule = promise;
        return promise;
    },

    repairPriceRoundsFromChain(windows, rewriteRounds) {
        if (this._priceRestoreStopped) return Promise.resolve(stoppedResult());
        if (!this._priceRestoreQueue) this._priceRestoreQueue = [];
        let promise = new Promise(resolve => {
            this._priceRestoreQueue.push({ windows, rewriteRounds, resolve,
                background: windows === undefined && rewriteRounds === undefined });
        });
        this.drainPriceChainRestoreQueue();
        return promise;
    },

    async drainPriceChainRestoreQueue() {
        if (this._priceRestoreRunning || this._priceRestoreStopped) return;
        this._priceRestoreRunning = true;
        try {
            while (this._priceRestoreQueue && this._priceRestoreQueue.length > 0) {
                if (this._priceRestoreStopped) {
                    resolveQueuedAsStopped.call(this);
                    break;
                }
                let job = this._priceRestoreQueue.shift();
                let result;
                try {
                    result = await this.runPriceChainRestorePass(job.windows, job.rewriteRounds);
                } catch (e) {
                    warnRestoreOnce.call(this, nodeUtil.format(e && e.message ? e.message : e));
                    result = { ran: false, reason: e && e.message ? e.message : String(e) };
                }
                job.resolve(this._priceRestoreStopped ? stoppedResult() : result);
            }
        } finally {
            this._priceRestoreRunning = false;
            if (this._priceRestoreStopped) resolveQueuedAsStopped.call(this);
            else if (this._priceRestoreQueue && this._priceRestoreQueue.length > 0)
                this.drainPriceChainRestoreQueue();
        }
    },

    async runPriceChainRestorePass(windows, rewriteRounds) {
        if (this._priceRestoreStopped) return stoppedResult();
        let now = this.priceRestoreNow();
        if (this._priceRestoreUnsupportedUntil > now)
            return { ran: false, reason: 'indexer method unavailable' };
        try {
            if ((!Array.isArray(windows) || windows.length === 0) && this._priceRestoreCursor === null) {
                let latest = await this.db.findLatestPriceSnapshotRound();
                if (this._priceRestoreStopped) return stoppedResult();
                let oldest = await this.db.findOldestPriceSnapshotRound();
                if (this._priceRestoreStopped) return stoppedResult();
                this._priceRestoreOldestRound = Math.min(oldest, latest);
                this._priceRestoreRecentStart = Math.max(this._priceRestoreOldestRound,
                    latest - PRICE_RESTORE_RECENT_ROUNDS + 1);
                this._priceRestoreWalkingOlder = false;
                this._priceRestoreCursor = this._priceRestoreRecentStart;
            }
            let range = requestedRange(windows, this._priceRestoreCursor || 0,
                this._priceRestoreWalkingOlder, this._priceRestoreOldestRound || 0);
            let answer = await this.fetchPriceBatchesForRestore(range.first, range.last);
            if (this._priceRestoreStopped) return stoppedResult();
            if (!answer) return { ran: false, reason: 'batch metadata unavailable' };
            let chosen = selectBatches(answer.batches, range);
            if (chosen.batches.length === 0) {
                if (!range.bounded) advanceBackgroundWalk.call(this, range, chosen, answer);
                return { ran: true, considered: 0, restored: 0 };
            }

            let rows = await this.db.findPriceSnapshotRowsForRounds(chosen.rounds);
            if (this._priceRestoreStopped) return stoppedResult();
            let present = presentRounds(rows);
            let rewritePending = new Set(Array.isArray(rewriteRounds) ? rewriteRounds.map(Number) : []);
            let restored = 0, rewritten = 0, refused = 0;
            for (let batch of chosen.batches) {
                let targets = new Set();
                for (let round = Number(batch.first_round); round <= Number(batch.last_round); round++) {
                    if (round >= range.first && round <= range.last &&
                        (!present.has(round) || rewritePending.has(round))) targets.add(round);
                }
                if (targets.size === 0) continue;

                let fetched = await this.fetchPriceBatchPayloadForRestore(batch.action_index);
                if (this._priceRestoreStopped) return stoppedResult();
                if (fetched && fetched.unsupported) {
                    this._priceRestoreUnsupportedUntil = now + PRICE_RESTORE_UNSUPPORTED_BACKOFF_MS;
                    logger.warn('PriceAggregator: the landing indexer does not provide getpricebatchpayload; ' +
                        'active-chain PRICE repair will retry after a 30 minute compatibility backoff');
                    return { ran: false, reason: 'indexer method unavailable' };
                }
                if (!fetched || !fetched.payload) {
                    warnRestoreOnce.call(this, (fetched && fetched.error) || 'batch payload unavailable');
                    continue;
                }
                let requestedAction = Number(batch.action_index);
                if (fetched.payload.source_chain !== PRICE_LANDING_COIN ||
                    Number(fetched.payload.action_index) !== requestedAction) {
                    warnRestoreOnce.call(this, 'batch payload identity does not match its request');
                    refused += targets.size;
                    continue;
                }

                let target = new Set(fetched.payload.rounds
                    .map(round => Number(round && round.round))
                    .filter(round => Number.isSafeInteger(round) && round >= range.first &&
                        round <= range.last && targets.has(round)));
                if (target.size === 0) continue;
                let existingTargets = [...target].filter(round => present.has(round));
                let result = await this.receiveValidatedBatch(PRICE_LANDING_COIN, fetched.payload,
                    { existingRows: rows, targetRounds: target });
                if (this._priceRestoreStopped) return stoppedResult();
                if (result && result.accepted) {
                    restored += result.stored;
                    target.forEach(round => present.add(round));
                    existingTargets.forEach(round => {
                        rewritePending.delete(round);
                        rewritten++;
                    });
                } else {
                    if (result && result.reason === 'stale (retracted generation)' && existingTargets.length > 0)
                        await deleteRefusedRewrite.call(this, fetched.payload);
                    refused += target.size;
                }
            }

            this._priceRestoreWarned = null;
            if (!range.bounded) advanceBackgroundWalk.call(this, range, chosen, answer);
            if (restored > 0) logger.info('PriceAggregator: restored ' + restored +
                ' PRICE round(s) from valid active-chain batches');
            return { ran: true, considered: chosen.rounds.length, restored, rewritten, refused };
        } catch (e) {
            warnRestoreOnce.call(this, nodeUtil.format(e && e.message ? e.message : e));
            return { ran: false, reason: e && e.message ? e.message : String(e) };
        }
    }

};
