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
 * XChain Hub - Oracle Publisher: shedding rounds a landed batch already carries
 *
 * The two ways this hub learns a window published: the indexer pushing a landed
 * batch back, and the pre-sweep read of the landing chain's indexer. Plus the
 * reverse seam, restoring rounds a reorg retracted so the window can publish again.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const hubConfig = require('../../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The chain every PRICE batch lands on, and therefore the indexer the backlog
// reconcile asks. Same constant the encoder wiring below assumes (DOGE_ENCODER_URL).
const PRICE_LANDING_COIN = 'DOGE';

// Rows asked of the landing chain's indexer per reconcile. A 2-round window
// publishes three wires an hour, so one page is about a week of windows; a
// truncated page is followed up on the next sweep, from the first round still
// buffered, so a longer backlog drains a page per sweep without a second call.
const LANDED_BATCH_PAGE = 500;

module.exports = {

    // ----- Landed-batch pruning -----

    // A batch covering [first,last] is on chain: shed those rounds from the buffer so
    // no catch-up sweep re-proposes them. Called from PriceAggregator when the indexer
    // pushes a landed batch (every hub, every batch) and from the pre-sweep chain read.
    //
    // This is the seam the observation prune above could not be. That prune keys on
    // price_snapshots rows stamped with a batch proof, and a validator that finalized
    // the round itself never gets one (the aggregator counts the pushed round a
    // duplicate and keeps the v0 proof), so on the fleet it fired for 2 rounds in
    // 1446 and every hub carried its whole history buffered. Measured 2026-09-07:
    // 704 closed windows per hub at boot, 4 re-published an hour, ~80% of them
    // duplicates of batches already valid on chain.
    //
    // Windows left with nothing buffered are memoized as assembled and lose any
    // takeover timer: there is nothing to propose and nothing to take over. A window
    // only PARTLY covered keeps its remaining rounds and stays re-proposable, which
    // is how a landed [49,49] still lets round 48 publish.
    noteBatchLanded(first, last, info) {
        let f = parseInt(first), l = parseInt(last);
        if (!Number.isFinite(f) || !Number.isFinite(l) || l < f) return 0;
        let pruned = 0;
        for (let r of Array.from(this._buffer.keys())) {
            if (r >= f && r <= l && this._buffer.delete(r)) pruned++;
        }
        for (let w = this.windowIndexOf(f); w <= this.windowIndexOf(l); w++) {
            if (this.bufferedRange(w * this.batchWindowRounds, w * this.batchWindowRounds + this.batchWindowRounds - 1).length > 0) continue;
            this.noteAssembled(w);
            let state = this._windows.get(w);
            if (state && state.timer) clearTimeout(state.timer);
            this._windows.delete(w);
            let takeover = this._takeoverTimers.get(w);
            if (takeover) { clearTimeout(takeover); this._takeoverTimers.delete(w); }
        }
        if (pruned > 0) {
            this.landedBatchPrunedRounds += pruned;
            this.rewriteBufferFile(this.bufferedRange(-Infinity, Infinity));
            let via = info && info.sourceChain ? ' pushed from ' + info.sourceChain +
                (info.actionIndex !== undefined && info.actionIndex !== null ? ' action ' + info.actionIndex : '') : '';
            logger.info('OraclePublisher: shed ' + pruned + ' buffered round(s) in [' + f + ',' + l +
                '] after their batch landed on chain' + via);
        }
        return pruned;
    },

    // Ask the landing chain's indexer which pending windows already carry a valid
    // batch, and shed those before the sweep re-proposes anything. This is what
    // handles a buffer that filled BEFORE noteBatchLanded existed (or while the push
    // feed was dark): the pushes for those batches are long gone, and the indexer is
    // the only chain-derived record every hub can reach.
    //
    // Fails OPEN, on purpose: with no indexer URL, an unreachable indexer, or an
    // indexer too old to know getpricebatches, the sweep proceeds exactly as before.
    // Failing closed would mean a hub that cannot reach its indexer never catches up
    // at all, including the one window that closed while it was restarting, and the
    // fee-gate cost of that is real while the cost of a duplicate is only a fee. The
    // failure is logged once per distinct reason and counted, so a hub that is
    // silently re-publishing duplicates is visible in getoraclepublisherstatus.
    async reconcileBacklogAgainstChain() {
        let pending = this.pendingCatchupWindows();
        if (pending.length === 0) return 0;
        let first = pending[0] * this.batchWindowRounds;
        let last  = pending[pending.length - 1] * this.batchWindowRounds + this.batchWindowRounds - 1;
        let answer = await this.fetchLandedBatches(first, last);
        if (!answer) return 0;
        this.chainReconcileRuns++;
        let pruned = 0, windowsBefore = pending.length;
        for (let b of answer.batches) pruned += this.noteBatchLanded(b.first_round, b.last_round, null);
        if (pruned > 0) {
            this.chainReconcilePrunedRounds += pruned;
            let remaining = this.pendingCatchupWindows().length;
            logger.info('OraclePublisher: ' + pruned + ' buffered round(s) in [' + first + ',' + last +
                '] are already carried by ' + answer.batches.length + ' valid PRICE batch(es) on ' +
                PRICE_LANDING_COIN + '; ' + (windowsBefore - remaining) + ' of ' + windowsBefore +
                ' pending window(s) shed without re-publishing' +
                (answer.truncated ? ' (page full; the rest is checked next sweep)' : ''));
        }
        return pruned;
    },

    // { batches: [{first_round,last_round}], truncated } from the landing chain's
    // indexer, or null when it cannot be asked. The URL resolves the way every other
    // per-coin indexer read on the hub does (env <COIN>_INDEXER_API_URL, then the hub's
    // configs table via XChainHub._resolveIndexerUrl); the key is the same per-coin
    // x-api-key the anchor publisher attaches, because getpricebatches is a
    // federation read on the indexer.
    async fetchLandedBatches(first, last) {
        let url = null;
        try {
            if (this.hub && typeof this.hub._resolveIndexerUrl === 'function') {
                url = await this.hub._resolveIndexerUrl(PRICE_LANDING_COIN);
            } else {
                // Literal names, deliberately: a computed process.env[expr] read is
                // invisible to the env-var documentation gate.
                url = hubConfig.DOGE_INDEXER_API_URL || hubConfig.DOGE_INDEXER_URL || null;
            }
        } catch (e) {
            return this.chainReconcileFailed('cannot resolve the ' + PRICE_LANDING_COIN + ' indexer URL: ' + (e && e.message));
        }
        if (!url) return this.chainReconcileFailed('no ' + PRICE_LANDING_COIN + ' indexer URL configured (set ' +
            PRICE_LANDING_COIN + '_INDEXER_API_URL)');
        let cfg = (this.hub && this.hub.p2pConfig) || {};
        let key = hubConfig.DOGE_INDEXER_API_KEY || cfg.DOGE_INDEXER_API_KEY || '';
        let result;
        try {
            result = await this.indexerRpc(url, key, 'getpricebatches',
                { first_round: first, last_round: last, limit: LANDED_BATCH_PAGE });
        } catch (e) {
            return this.chainReconcileFailed('getpricebatches on ' + url + ' failed: ' + (e && e.message));
        }
        if (!result || result.error || !Array.isArray(result.batches)) {
            return this.chainReconcileFailed('getpricebatches on ' + url + ' answered ' +
                (result && result.error ? JSON.stringify(result.error) : 'without a batch list'));
        }
        let batches = [];
        for (let b of result.batches) {
            let f = parseInt(b && b.first_round), l = parseInt(b && b.last_round);
            if (Number.isFinite(f) && Number.isFinite(l) && l >= f) batches.push({ first_round: f, last_round: l });
        }
        this._chainReconcileWarned = null;   // healthy again: the next failure logs again
        return { batches: batches, truncated: !!result.truncated };
    },

    chainReconcileFailed(reason) {
        this.chainReconcileFailures++;
        if (this._chainReconcileWarned !== reason) {
            this._chainReconcileWarned = reason;
            logger.warn('OraclePublisher: cannot check the buffered backlog against the chain (' + reason +
                '); the catch-up sweep will re-propose windows the chain may already carry');
        }
        return null;
    },

    // JSON-RPC to an indexer, separated so tests can stand in for the wire.
    async indexerRpc(url, key, method, params) {
        let headers = { 'Content-Type': 'application/json' };
        if (key) headers['x-api-key'] = key;
        let resp = await axios.post(url, { jsonrpc: '2.0', method: method, params: params || {}, id: 1 },
            { headers: headers, timeout: 15000 });
        if (resp && resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp && resp.data ? resp.data.result : null;
    },

    // Put rounds BACK into the buffer from this hub's own finalized price_snapshots
    // rows, so a window whose batch was retracted by a reorg can be re-proposed. Once
    // noteBatchLanded sheds a landed window there is no other copy of its content on
    // a hub that did not lead it; before it existed the rounds were simply never shed.
    // Only v0-proofed rows qualify: a batch-sourced row's reference_block is the
    // landing height, not the round's BTC anchor, and it is being retracted anyway.
    async restoreBufferedRounds(rounds) {
        if (!this.db) return 0;
        let want = rounds.filter(r => !this._buffer.has(r));
        if (want.length === 0) return 0;
        let rows;
        try {
            rows = await this.db.findV0PriceSnapshotsForRounds(want, 'finalized');
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: cannot restore retracted round(s) ' + want.join(',') +
                ' to the buffer from price_snapshots; they cannot be re-published: ', e && e.message));
            return 0;
        }
        let derived = new Map();
        for (let row of (rows || [])) {
            let r = parseInt(row.round_number);
            let ts = parseInt(row.block_timestamp), anchor = parseInt(row.reference_block);
            if (!Number.isFinite(r) || !Number.isFinite(ts) || !Number.isFinite(anchor)) continue;
            if (row.coin_pair === null || row.coin_pair === undefined || row.price === null || row.price === undefined) continue;
            let entry = derived.get(r);
            if (!entry) {
                entry = { round: r, timestamp: ts, btcBlockHeight: anchor, pairs: [] };
                let admit = this.admission.columnsAdmitBlocks(row);
                if (admit !== null) entry.admitBlocks = admit;
                derived.set(r, entry);
            }
            entry.pairs.push({ pair: String(row.coin_pair), price: String(row.price) });
        }
        let restored = 0;
        for (let [r, entry] of derived) {
            if (entry.pairs.length === 0) continue;
            this._buffer.set(r, entry);
            this.noteWindowRound(r);
            restored++;
        }
        if (restored > 0) {
            this.rewriteBufferFile(this.bufferedRange(-Infinity, Infinity));
            logger.info('OraclePublisher: restored ' + restored + ' retracted round(s) to the buffer from ' +
                'price_snapshots so their window can be re-published');
        }
        return restored;
    },

};
