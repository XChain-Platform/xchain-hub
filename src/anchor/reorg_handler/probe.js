/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Reorg handler - self-verification against our own node
 *
 * The indexer probes that decide whether this hub confirms a claimed reorg: the node
 * must serve the new hash at the height, and its reorg history must show the old hash
 * orphaned there. Anything short of that is an abstain.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const hubConfig = require('../../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Verify a claimed reorg against our OWN indexer. Returns a truthy
    // `{ blockTimeMs }` object only on positive confirmation: the node serves
    // `newHash` at `reorgHeight`, the height is within [tip - maxReorgDepth, tip],
    // the response names the federation network, and the node's reorg history
    // shows `oldHash` was actually orphaned at that height. blockTimeMs is the served
    // block's block_time in ms (the rollback anchor; null when the indexer carries
    // no block_time). Anything else (no endpoint, RPC error, lagging node still on
    // oldHash, network mismatch) returns false, which callers treat as ABSTAIN,
    // never as proof of absence. Concurrent calls for the same observation share
    // one in-flight probe.
    verifyReorgAgainstOwnNode(chain, reorgHeight, oldHash, newHash) {
        let key = chain + ':' + reorgHeight + ':' + oldHash + ':' + newHash;
        let inFlight = this._verifying.get(key);
        if (inFlight) return inFlight;

        let probe = this.probeOwnNode(chain, reorgHeight, oldHash, newHash)
            .catch(err => {
                logger.warn(nodeUtil.format('Reorg: self-verification failed for %s:', key, err && err.message));
                return false;
            });
        this._verifying.set(key, probe);
        probe.finally(() => this._verifying.delete(key));
        return probe;
    },

    async probeOwnNode(chain, reorgHeight, oldHash, newHash) {
        let ix = this.indexers[chain];
        if (!ix || !ix.url) return false;                    // cannot verify → abstain

        let tip = await this._indexerCall(chain, 'getblockhashes', {});
        if (!tip || tip.block_index == null) return false;
        let tipIndex = Number(tip.block_index);
        if (!Number.isFinite(tipIndex)) return false;
        if (reorgHeight > tipIndex) return false;            // above our tip
        if (reorgHeight < tipIndex - this.maxReorgDepth) return false;  // deeper than the bound

        let bh = (reorgHeight === tipIndex)
            ? tip
            : await this._indexerCall(chain, 'getblockhashes', { block_index: reorgHeight });
        if (!bh || !bh.block_hash) return false;
        // Refuse a network-agnostic or cross-network answer (mirrors
        // StateCheckpointEngine's checkpoint refusal).
        if (!bh.network || (this.network && String(bh.network) !== this.network)) return false;

        let served = String(bh.block_hash).toLowerCase();
        if (served !== newHash || newHash === oldHash) return false;

        // The "before" half (REORG-OLDHASH-UNVERIFIED-1): serving newHash at
        // reorgHeight is trivially true on the honest chain, so on its own it
        // lets a single Byzantine reporter pair the real canonical hash with a
        // fabricated oldHash and reach full honest quorum over a reorg that
        // never happened. Require our OWN node's reorg evidence (the decoder's
        // REORG events, surfaced by the indexer's getreorghistory) to confirm
        // oldHash was the canonical-then-orphaned hash at reorgHeight; abstain
        // otherwise. Liveness holds: an indexer that serves newHash at that
        // height necessarily processed the reorg, so its decoder recorded the
        // orphaned hashes in the same pass.
        if (!(await this.confirmOldHashOrphaned(chain, reorgHeight, oldHash))) return false;

        // block_time (unix seconds) of OUR OWN node's block at reorgHeight: the
        // consensus-uniform rollback anchor (every hub reads its own copy of the
        // same quorum-verified block). Nullable: an indexer predating block_time
        // yields the legacy reporter-timestamp bound.
        let blockTimeMs = (Number(bh.block_time) > 0) ? Number(bh.block_time) * 1000 : null;
        return { blockTimeMs };
    },

    // Whether our own indexer's reorg history shows `oldHash` was orphaned at
    // `reorgHeight`. Queries by height only and matches the hash locally, so a
    // legacy REORG event (recorded before the decoder stored hashes; block_hash
    // null) at that exact height is accepted as evidence a real reorg orphaned
    // a block there, while a recorded-but-different hash is refused. Any error
    // shape (RPC error, indexer predating getreorghistory, malformed response)
    // is an abstain, never a throw.
    async confirmOldHashOrphaned(chain, reorgHeight, oldHash) {
        let hist;
        try {
            hist = await this._indexerCall(chain, 'getreorghistory', { block_index: reorgHeight });
        } catch (err) {
            logger.warn(nodeUtil.format('Reorg: getreorghistory probe failed for %s:%s:',
                chain, reorgHeight, err && err.message));
            return false;
        }
        if (!hist || hist.error || !Array.isArray(hist.events)) return false;
        let sawUnrecorded = false;
        for (let ev of hist.events) {
            if (!ev || !Array.isArray(ev.blocks)) continue;
            for (let b of ev.blocks) {
                if (!b || Number(b.block_index) !== Number(reorgHeight)) continue;
                // An unrecorded hash is NOT a confirmation. The indexer sets
                // block_hash null deliberately so a caller can tell "no hash recorded"
                // apart from "hash did not match" (reorg_history_query.js parseReorgEvent);
                // treating them alike fails OPEN and accepts ANY claimed oldHash at this
                // height, which reduces the orphaned-hash check to "some reorg happened here" and
                // re-opens the divergent-digest mode. Keep scanning: another event
                // may carry the real hash for the same height.
                if (b.block_hash === null || b.block_hash === undefined) { sawUnrecorded = true; continue; }
                if (String(b.block_hash).toLowerCase() === oldHash) return true;
            }
        }
        // Escape hatch, off by default. Restores the earlier fail-open behavior for an
        // operator who knowingly runs against history with unrecorded hashes and
        // would rather co-sign than abstain. Measured 2026-07-29: 3 of 171 recorded
        // orphaned blocks on mainnet carry a null hash (DOGE 6280198 + 6279100,
        // LTC 3137602), so the abstention cost of leaving this off is those heights.
        if (sawUnrecorded && String(hubConfig.REORG_ALLOW_UNRECORDED_OLDHASH || '') === '1') {
            logger.warn('Reorg: accepting UNVERIFIED oldHash at ' + chain + ':' + reorgHeight +
                ' because REORG_ALLOW_UNRECORDED_OLDHASH=1 (the orphaned hash is unrecorded, so this ' +
                'co-signs a claim this node cannot check)');
            return true;
        }
        if (sawUnrecorded)
            logger.warn('Reorg: abstaining at ' + chain + ':' + reorgHeight +
                ': a reorg IS recorded at this height but its orphaned hash was never recorded, so the ' +
                'claimed oldHash cannot be verified)');
        return false;
    },

    async _indexerCall(coin, method, params) {
        let ix = this.indexers[coin];
        if (!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if (ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if (resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

};
