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
 * XChain Hub - Chain Tips
 *
 * The two tips this hub reads and the gates that date them: the COMMITTED
 * BTC tip a consensus round anchors on, and the per-chain ADMISSION tip a
 * mirrored row is first readable at.
 *
 ********************************************************************/

const { axiosFor } = require('./indexer_http.js');
const admissionHeight = require('../lib/admission_height.js');
const { blockIntervalS } = require('../lib/relay_margin.js');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS } = require('../constants.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const { getLogger } = require('../observability');
const logger = getLogger();

// One store per asynchronous proposal flow. The WeakMap keeps separate hub instances
// isolated even when tests or embedded callers deliberately use more than one in a scope.
const admissionTipMemo = new AsyncLocalStorage();

class ChainTips {

    // Resolve the latest BTC block index: first hub.db.getChainTip, populated by the
    // indexer's pushChainTip only when that indexer is configured with HUB_API_URL, on
    // the network resolveBtcIndexerUrl picks so the tip matches. Then a direct
    // getlatestblock call, which covers stacks where the tip push is not wired, local
    // regtest development among them, so block-boundary snapshotting still works. Null
    // when both paths fail, and null when the direct path only re-serves a height
    // btcDirectTipAcceptable dates as frozen.
    async resolveBtcLatestBlock(){
        // A cross-network configs tree makes this throw. Degrade to the documented null
        // rather than crashing the scheduler tick that called it.
        let network;
        try { network = await this.resolveBtcNetwork(); }
        catch (err) { logger.error(nodeUtil.format('XChainHub: cannot resolve BTC latest block:', err.message)); return null; }
        // Held past the block below: a rejected tip is still the only block_time the hub
        // has, and the direct path is dated against it.
        let pushedTip = null;
        try {
            pushedTip = await this.db.getChainTip('BTC', network);
            // Freshness bound on the pushed tip. If the co-located indexer halts,
            // getChainTip serves the same frozen row forever, so rounds would anchor to a
            // stale height. Fall through when the tip is stale or unverifiable.
            if(pushedTip && pushedTip.blockHeight && this.btcPushedTipFresh(pushedTip)) return pushedTip.blockHeight;
        } catch (_) { /* hub db down? fall through */ }
        let url = await this.resolveBtcIndexerUrl();
        if(!url) return null;
        try {
            let res = await axiosFor(this).post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method: 'getlatestblock', params: {}
            }, { timeout: 5000 });
            let result = res && res.data && res.data.result;
            if(!result || result.error) return null;
            // Guard against anchoring a snapshot on a stale tip. `lag` is how far the indexer's
            // committed tip trails the decoder's; an indexer processing far behind (repeated
            // contract watchdog timeouts, say) no longer reflects recent chain state, so past a
            // configurable gap treat the tip as untrustworthy and degrade rather than lock a
            // stale validator set into the consensus round.
            let maxLag = Number(hubConfig.MAX_INDEXER_LAG_BLOCKS);
            if(!Number.isFinite(maxLag) || maxLag < 0) maxLag = 200;
            if(result.lag != null && Number(result.lag) > maxLag){
                logger.warn('XChainHub: BTC indexer lag ' + result.lag +
                    ' exceeds MAX_INDEXER_LAG_BLOCKS (' + maxLag + '); ignoring stale tip');
                return null;
            }
            let directHeight = Number(result.block_index) || null;
            if(directHeight && !this.btcDirectTipAcceptable(directHeight, pushedTip)) return null;
            return directHeight;
        } catch (err) {
            logger.error(nodeUtil.format('XChainHub: failed to resolve BTC latest block from indexer:', err));
            return null;
        }
    }

    // Age gate for the DIRECT path, dated against the pushed tip the gate above rejected.
    // `lag` cannot see a halted chain: a stopped bitcoind freezes the decoder and the
    // committed tip together, so lag reads 0 while the height never moves.
    //
    // The bound is deliberately NOT MAX_TIP_AGE_S. A rejected pushed tip costs one HTTP
    // call, a rejected direct height returns null and stalls anchoring, so the two gates
    // price a false reject differently. Bitcoin block gaps are exponential with a 600s
    // mean, which refuses a live mainnet tip ~13.5% of the time at 1200s and ~6e-6 at
    // 7200s. A height that BEATS the pushed tip proves the chain moved and is always
    // taken, so only a height that has not moved can be dated as frozen.
    btcDirectTipAcceptable(directHeight, tip){
        if(!tip || !tip.blockHeight) return true;
        let blockTime = Number(tip.blockTime);
        if(!Number.isFinite(blockTime) || blockTime <= 0) return true;
        if(Number(directHeight) > Number(tip.blockHeight)) return true;
        let maxAge = Number(hubConfig.MAX_DIRECT_TIP_AGE_S);
        if(!Number.isFinite(maxAge) || maxAge <= 0) maxAge = 7200;
        let ageS = Math.floor(Date.now() / 1000) - blockTime;
        if(ageS <= maxAge) return true;
        logger.warn('XChainHub: direct BTC tip (height ' + directHeight + ') has not advanced past a tip ' +
            ageS + 's old, exceeding MAX_DIRECT_TIP_AGE_S (' + maxAge + '); treating the BTC stack as halted');
        return false;
    }

    // Freshness gate for the pushed BTC tip used by path 1 above. setChainTip stores
    // block_time alongside the height, so the age check costs no round-trip. Returns
    // false when the tip is older than MAX_TIP_AGE_S or its block_time is missing.
    // Default bound mirrors OracleRound: 2x the oracle round interval.
    btcPushedTipFresh(tip){
        let maxAge = Number(hubConfig.MAX_TIP_AGE_S);
        if(!Number.isFinite(maxAge) || maxAge <= 0){
            let roundIntervalMs = (this.p2pConfig && Number(this.p2pConfig.ORACLE_ROUND_INTERVAL)) || DEFAULT_ORACLE_ROUND_INTERVAL_MS;
            maxAge = Math.floor((2 * roundIntervalMs) / 1000);
        }
        let blockTime = Number(tip.blockTime);
        if(!Number.isFinite(blockTime) || blockTime <= 0){
            logger.warn('XChainHub: pushed BTC tip (height ' + tip.blockHeight +
                ') has no stored block_time; treating as unverifiable and falling through to the direct indexer path');
            return false;
        }
        let ageS = Math.floor(Date.now() / 1000) - blockTime;
        if(ageS > maxAge){
            // Info, not warn: a 1200s bound refuses ~13.5% of live mainnet blocks, the
            // direct path answers one call later, and btcDirectTipAcceptable is the
            // gate that warns when the chain has actually stopped.
            logger.info('XChainHub: pushed BTC tip (height ' + tip.blockHeight + ') is ' + ageS +
                's old, past MAX_TIP_AGE_S (' + maxAge + '): a long block gap, taking the direct indexer path');
            return false;
        }
        return true;
    }

    // ---- the ADMISSION tip, per chain (spec §5.2; C29, F35) ----------------
    //
    // A SIBLING of resolveBtcLatestBlock, not a generalization of it. That method
    // must keep serving the COMMITTED tip, because a validator set anchored on a
    // height the fleet has not committed is the failure its lag and freshness gates
    // exist to prevent. This one answers a different question: which block may a
    // mirrored row first be READ at, which the committed tip cannot answer at all.
    //
    // Reading the committed tip here is CIRCULAR and would fork. A barriered indexer
    // stops committing and stops pushing chain tips, so the hub's observed height
    // freezes at exactly the block the barrier is holding, and frozenHeight + margin
    // names a block the fleet has already passed. The decoder runs UPSTREAM of the
    // block loop and no mirror barrier gates it, so decoder_block keeps advancing
    // precisely while block_index is frozen: it is the one tip in the response that
    // is not downstream of the thing it exists to unblock.
    //
    // Default stall window, in blocks of the chain, before a decoder tip that has
    // not advanced is dated as frozen. Six blocks is about an hour on BTC, 15 minutes
    // on LTC and 6 minutes on DOGE, which is the same shape as the follower bound and
    // for the same reason: the window has to be a block count or it collapses on the
    // fast chains. Overridable per deployment, never per call.
    static get ADMISSION_TIP_STALL_BLOCKS(){ return 6; }

    // Share admission-tip reads only within one proposal. Nested users join the current
    // scope, while the next top-level proposal starts with an empty memo.
    withAdmissionTipMemo(fn){
        if(admissionTipMemo.getStore()) return fn();
        return admissionTipMemo.run(new WeakMap(), fn);
    }

    async resolveAdmissionTip(coin){
        let c = admissionHeight.normalizeChain(coin);
        if(c === null){
            logger.warn('XChainHub: admission tip requested for unusable chain ' + JSON.stringify(String(coin)));
            return null;
        }
        let url = await this.resolveIndexerUrl(c);
        if(!url){
            logger.warn('XChainHub: no ' + c + ' indexer URL configured; no admission tip for ' + c +
                '. Rows read by ' + c + ' cannot be finalized above the admission activation.');
            return null;
        }
        let result;
        try {
            let res = await axiosFor(this).post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method: 'getlatestblock', params: {}
            }, { timeout: 5000 });
            result = res && res.data && res.data.result;
        } catch (err) {
            logger.error(nodeUtil.format('XChainHub: failed to read the ' + c + ' admission tip from its indexer:', err.message));
            return null;
        }
        if(!result || result.error) return null;

        // MAX_INDEXER_LAG_BLOCKS is DELIBERATELY not applied here, and this is the
        // single easiest mistake to make on this path. That gate refuses a tip whose
        // `lag` (decoder_block - block_index) exceeds 200, so the round does not anchor
        // a validator set on a stale committed height. A barriered indexer IS a
        // high-lag indexer: lag is the barrier's own depth. Applying it here would
        // refuse the admission reading in precisely the case admission by height was
        // designed to serve, and the rail would stall for the reason it exists to fix.
        // Checked on the RAW value before coercing. Number(null) and Number('') are both 0,
        // a finite non-negative integer, so a bare Number() here would read an ABSENT
        // decoder_block as height 0 and stamp an admission height of 0 + margin: a row
        // admissible at a block every live chain passed years ago.
        let raw = result.decoder_block;
        let tip = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
        if(!Number.isSafeInteger(tip) || tip < 0){
            // A v6 indexer, or one that has not decoded a block yet. Refused, not
            // guessed: falling back to block_index here would reintroduce the circularity.
            logger.warn('XChainHub: ' + c + ' indexer returned no usable decoder_block (' +
                JSON.stringify(result.decoder_block) + '); no admission tip for ' + c);
            return null;
        }
        if(!this.admissionTipFresh(c, tip)) return null;
        return tip;
    }

    // Per-chain freshness gate for the admission tip. Today's gates (btcPushedTipFresh,
    // btcDirectTipAcceptable) are BTC-only and date a tip against a stored block_time;
    // the decoder tip carries no time, so this one dates it against the last height THIS
    // hub observed for that chain and how long ago it observed it.
    //
    // A height that BEATS the last observation proves the chain moved and is always
    // taken, exactly as btcDirectTipAcceptable takes an advancing height. Only a height
    // that has NOT moved can be dated as frozen, and only after the chain's own window.
    //
    // First sight is accepted and recorded: a tip we have never seen before cannot be
    // dated, and refusing it would make every hub restart a rail outage. The refusal
    // that matters is the frozen decoder, which needs two observations to see.
    admissionTipFresh(coin, tip){
        let c = admissionHeight.normalizeChain(coin);
        if(c === null) return false;
        if(!this._admissionTipSeen) this._admissionTipSeen = new Map();
        let nowMs = Date.now();
        let prev = this._admissionTipSeen.get(c);
        if(!prev || Number(tip) > Number(prev.height)){
            this._admissionTipSeen.set(c, { height: Number(tip), atMs: nowMs });
            return true;
        }
        let maxAgeS = Number(hubConfig.ADMISSION_TIP_MAX_AGE_S);
        if(!Number.isFinite(maxAgeS) || maxAgeS <= 0)
            maxAgeS = ChainTips.ADMISSION_TIP_STALL_BLOCKS * blockIntervalS(c);
        let ageS = Math.floor((nowMs - Number(prev.atMs)) / 1000);
        if(ageS > maxAgeS){
            logger.warn('XChainHub: the ' + c + ' decoder tip has not advanced past height ' + Number(tip) +
                ' in ' + ageS + 's, exceeding this chain\'s ' + maxAgeS + 's admission stall window; ' +
                'refusing to stamp an admission height for ' + c + ' rather than guessing one');
            return false;
        }
        return true;
    }

    // Every admission tip a row's read set needs, read in parallel. A chain whose tip is
    // refused comes back null rather than missing, so the caller's refusal names it.
    async resolveAdmissionTips(chains){
        let out = {};
        let want = [];
        for(let raw of (chains || [])){
            let c = admissionHeight.normalizeChain(raw);
            if(c === null){ out[String(raw)] = null; continue; }
            if(want.indexOf(c) === -1) want.push(c);
        }
        let scope = admissionTipMemo.getStore();
        let memo = null;
        if(scope){
            memo = scope.get(this);
            if(!memo){ memo = new Map(); scope.set(this, memo); }
        }
        let tips = await Promise.all(want.map((c) => {
            if(!memo) return this.resolveAdmissionTip(c).catch(() => null);
            if(!memo.has(c))
                memo.set(c, Promise.resolve().then(() => this.resolveAdmissionTip(c)).catch(() => null));
            return memo.get(c);
        }));
        want.forEach((c, i) => { out[c] = tips[i]; });
        return out;
    }

    // The producer's one entry point: the admission map for a row, or null when this hub
    // cannot justify one.
    //
    // Null is a REFUSAL TO FINALIZE the row, not a legacy row (C4). Above the activation
    // the engine that gets null must defer the row rather than sign it, because a guessed
    // admission height forks the federation while a refusal stalls one rail and says on
    // which chain. Below the activation no engine asks.
    //
    // @param {string} table the mirrored table, which picks the margin
    // @param {string[]} readSet the chains that read the row (admissionHeight.admissionReadSet)
    // @returns {Promise<object|null>}
    async resolveAdmitBlocks(table, readSet){
        let tips;
        try { tips = await this.resolveAdmissionTips(readSet); }
        catch (err) {
            logger.error(nodeUtil.format('XChainHub: admission tip read failed for ' + String(table) + ':', err.message));
            return null;
        }
        let missing = admissionHeight.missingAdmissionTips(readSet, tips);
        if(missing.length > 0){
            // Per chain, because that is the operator's whole diagnosis: which chain's
            // decoder went away, and therefore which rails stopped finalizing.
            for(let c of missing)
                logger.error('XChainHub: no fresh admission tip for ' + c + '; refusing to finalize ' +
                    String(table) + ' rows read by ' + c + ' until one is available');
            return null;
        }
        try { return admissionHeight.admitBlocks(readSet, tips, table); }
        catch (err) {
            logger.error(nodeUtil.format('XChainHub: cannot stamp an admission map for ' + String(table) + ':', err.message));
            return null;
        }
    }
}

module.exports = ChainTips;
