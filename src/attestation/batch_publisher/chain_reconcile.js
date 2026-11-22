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
 * AttestationBatchPublisher: landed-window chain reconciliation
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

const LANDING_COIN = 'DOGE';
const LANDED_BATCH_WINDOW_LIMIT = 8;

function finiteInteger(value){
    if(typeof value !== 'number' && typeof value !== 'string') return null;
    if(typeof value === 'string' && value.trim() === '') return null;
    let number = Number(value);
    return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

module.exports = {

    async reconcilePendingAgainstChain(pending){
        if(pending.length === 0) return pending;
        let remaining = [];
        let hadUsableAnswer = false;
        // Query each pending window alone. Page occupancy must not depend on landed
        // windows between pending ones, and duplicate heads for one window must never
        // defer another window.
        for(let index = 0; index < pending.length; index++){
            let window = pending[index];
            let start = Number(window.windowStart);
            let answer = await this.fetchLandedAttestBatches(start, start);
            if(!answer){
                if(index === 0 && !pending.some(candidate => candidate.reopened)) return pending;
                // Stop after the first failure rather than stacking RPC timeouts. A
                // reopened window still requires a chain answer proving absence.
                for(let later of pending.slice(index))
                    if(!later.reopened) remaining.push(later);
                break;
            }
            hadUsableAnswer = true;
            let landed = answer.batches.find(batch =>
                batch.window_start === start && batch.window_end === start + this.windowS);
            if(landed){
                await this.recordLandedWindow(start, landed.window_end,
                    landed.tx_hash || null, landed.row_count);
                this.stats.chainReconcileLandedWindows++;
            } else if(answer.truncated){
                this.stats.windowsDeferred++;
            } else {
                remaining.push(window);
            }
        }
        if(hadUsableAnswer) this.stats.chainReconcileRuns++;
        return remaining;
    },

    // The landing chain's indexer as { url, key }, or { failure } naming why not.
    async landingIndexer(){
        let url = null;
        try {
            if(this.hub && typeof this.hub.resolveIndexerUrl === 'function'){
                url = await this.hub.resolveIndexerUrl(LANDING_COIN);
            } else {
                url = hubConfig.DOGE_INDEXER_API_URL || hubConfig.DOGE_INDEXER_URL || null;
            }
        } catch(e){
            return { failure: 'cannot resolve the ' + LANDING_COIN + ' indexer URL: ' + (e && e.message) };
        }
        if(!url) return { failure: 'no ' + LANDING_COIN + ' indexer URL configured (set ' +
                                   LANDING_COIN + '_INDEXER_API_URL)' };
        let cfg = (this.hub && this.hub.p2pConfig) || {};
        return { url, key: hubConfig.DOGE_INDEXER_API_KEY || cfg.DOGE_INDEXER_API_KEY || '' };
    },

    async fetchLandedAttestBatches(from, to){
        let indexer = await this.landingIndexer();
        if(indexer.failure) return this.chainReconcileFailed(indexer.failure);
        let { url, key } = indexer;
        let result;
        try {
            result = await this.indexerRpc(url, key, 'getattestbatches',
                { window_start_from: from, window_start_to: to, limit: LANDED_BATCH_WINDOW_LIMIT });
        } catch(e){
            return this.chainReconcileFailed('getattestbatches on ' + url +
                ' failed: ' + (e && e.message));
        }
        if(!result || result.error || !Array.isArray(result.batches)){
            return this.chainReconcileFailed('getattestbatches on ' + url + ' answered ' +
                (result && result.error ? JSON.stringify(result.error) : 'without a batch list'));
        }

        let batches = [];
        for(let batch of result.batches){
            if(!batch) continue;
            let start = finiteInteger(batch.window_start);
            let end = finiteInteger(batch.window_end);
            if(start === null || end === null) continue;
            let rowCount = finiteInteger(batch.row_count);
            batches.push(Object.assign({}, batch, {
                window_start: start,
                window_end:   end,
                row_count:    rowCount !== null && rowCount >= 0 ? rowCount : 0,
                tx_hash:      typeof batch.tx_hash === 'string' && batch.tx_hash ? batch.tx_hash : null
            }));
        }
        this._chainReconcileWarned = null;
        return { batches: batches, truncated: !!result.truncated };
    },

    chainReconcileFailed(reason){
        this.stats.chainReconcileFailures++;
        if(!this._chainReconcileWarned) this._chainReconcileWarned = new Set();
        if(!this._chainReconcileWarned.has(reason)){
            this._chainReconcileWarned.add(reason);
            logger.warn('AttestationBatchPublisher: cannot check pending windows against the chain (' +
                reason + '); the sweep may re-publish windows the chain already carries');
        }
        return null;
    },

    async indexerRpc(url, key, method, params){
        let headers = { 'Content-Type': 'application/json' };
        if(key) headers['x-api-key'] = key;
        let resp = await axios.post(url,
            { jsonrpc: '2.0', method: method, params: params || {}, id: 1 },
            { headers: headers, timeout: 15000 });
        if(resp && resp.data && resp.data.error)
            throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp && resp.data ? resp.data.result : null;
    }

};
