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
const LANDED_BATCH_PAGE = 500;

function finiteInteger(value){
    if(typeof value !== 'number' && typeof value !== 'string') return null;
    if(typeof value === 'string' && value.trim() === '') return null;
    let number = Number(value);
    return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

module.exports = {

    async reconcilePendingAgainstChain(pending){
        if(pending.length === 0) return pending;
        let starts = pending.map(window => Number(window.windowStart));
        let from = Math.min(...starts), to = Math.max(...starts);
        let answer = await this.fetchLandedAttestBatches(from, to);
        if(!answer) return pending;

        this.stats.chainReconcileRuns++;
        let wanted = new Set(starts);
        let landed = new Set();
        for(let batch of answer.batches){
            let start = batch.window_start;
            if(!wanted.has(start) || batch.window_end !== start + this.windowS) continue;
            await this.recordLandedWindow(start, batch.window_end,
                batch.tx_hash || null, batch.row_count);
            landed.add(start);
        }
        this.stats.chainReconcileLandedWindows += landed.size;
        if(answer.truncated){
            // A full page proves only that its listed windows landed. Any omitted
            // window may have been pushed off the page, so absence is not evidence
            // until a later non-truncated answer covers the range.
            this.stats.windowsDeferred += pending.length - landed.size;
            return [];
        }
        return pending.filter(window => !landed.has(Number(window.windowStart)));
    },

    async fetchLandedAttestBatches(from, to){
        let url = null;
        try {
            if(this.hub && typeof this.hub.resolveIndexerUrl === 'function'){
                url = await this.hub.resolveIndexerUrl(LANDING_COIN);
            } else {
                url = hubConfig.DOGE_INDEXER_API_URL || hubConfig.DOGE_INDEXER_URL || null;
            }
        } catch(e){
            return this.chainReconcileFailed('cannot resolve the ' + LANDING_COIN +
                ' indexer URL: ' + (e && e.message));
        }
        if(!url) return this.chainReconcileFailed('no ' + LANDING_COIN +
            ' indexer URL configured (set ' + LANDING_COIN + '_INDEXER_API_URL)');

        let cfg = (this.hub && this.hub.p2pConfig) || {};
        let key = hubConfig.DOGE_INDEXER_API_KEY || cfg.DOGE_INDEXER_API_KEY || '';
        let result;
        try {
            result = await this.indexerRpc(url, key, 'getattestbatches',
                { window_start_from: from, window_start_to: to, limit: LANDED_BATCH_PAGE });
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
            batches.push(Object.assign({}, batch, { window_start: start, window_end: end }));
        }
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
