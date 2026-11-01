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
const {
    PRICE_RESTORE_ROUND_CAP,
    PRICE_LANDING_COIN,
    runPriceChainRestorePass,
    stoppedResult,
    warnRestoreOnce
} = require('./chain_restore_pass');

const PRICE_RESTORE_INTERVAL_MS = 60_000;

function resolveQueuedAsStopped() {
    for (let job of (this._priceRestoreQueue || []).splice(0)) job.resolve(stoppedResult());
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
        return runPriceChainRestorePass.call(this, windows, rewriteRounds);
    }

};
