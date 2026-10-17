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
 * AttestationBatchPublisher: windows a retraction reopened
 *
 * A validated DOGE retraction turns a window's `landed` or `sent` marker into
 * `reopened` (markers.js). A reorg returns the un-landed batch to the mempool, and
 * there it is normally re-mined within a block or two; no client this hub has can
 * see the mempool, so the only safe signal is the chain itself. A reopened window is
 * therefore offered only once the DOGE indexer's tip (getlatestblock) has advanced
 * REOPEN_WAIT_BLOCKS past the tip at which a sweep first saw it reopened, and
 * chain_reconcile.js publishes it only when the indexer answered fully and listed no
 * landed batch for it. The tip is trusted only upward: a lower reported tip (a resync,
 * a restored database, a lagging replica) never advances the wait. The first
 * sighting is kept in a small file beside the buffer, so a restart neither forgets
 * the wait nor shortens it; a retraction resets it and a landing drops it, so an
 * earlier reopen of the same window cannot shorten a later one; a missing or
 * unreadable file restarts every wait, which only delays.
 *
 * Installed on AttestationBatchPublisher.prototype by src/attestation/batch_publisher.js.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const { MAX_CATCHUP_WINDOWS } = require('./constants.js');

// DOGE's target block interval, which turns a batch window into the blocks it spans.
const DOGE_BLOCK_S = 60;
// The fewest DOGE blocks a reopened window waits, whatever the window length: the
// same reorg-depth bound the roll-call rail waits out (10 on mainnet and testnet, where
// a 3600 s window already spans 60 blocks; 3 on regtest, whose miner closes a block
// every 5 to 30 s and whose e2e venue runs 30 s windows).
const REOPEN_MIN_BLOCKS = Object.freeze({ mainnet: 10, testnet: 10, regtest: 3 });
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Every window a retraction reopened, and the DOGE tip to measure their waits on
    // (null when there are none or the tip cannot be read, which offers none). The same
    // read prunes the first-sighting file to the windows still reopened.
    async reopenedState(){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return { starts: [], tip: null };
        let rows = await db.findAttestPublishedBatchesByNetworkAndStatus(this.network, 'reopened');
        let starts = (rows || []).map(r => Number(r.window_start)).filter(s => Number.isFinite(s) && s >= 0);
        this.pruneReopenSeen(starts);
        return { starts, tip: starts.length ? await this.readReopenTip() : null };
    },

    // The landing indexer's tip, or null when it cannot be asked or answers without one.
    async readReopenTip(){
        let indexer = await this.landingIndexer();
        if(indexer.failure) return null;
        try {
            let res = await this.indexerRpc(indexer.url, indexer.key, 'getlatestblock', {});
            let tip = res && res.block_index !== null && res.block_index !== undefined ? Number(res.block_index) : NaN;
            return Number.isFinite(tip) ? tip : null;
        } catch(e){
            return null;
        }
    },

    // Windows a validated retraction reopened that the horizon no longer reaches. The
    // reorg, not the clock, made them owed, so the horizon cannot excuse them and the
    // boot floor does not apply. At most MAX_CATCHUP_WINDOWS per sweep, oldest first, so
    // a burst of retractions cannot hold the live window behind it. The publisher ladder
    // climbs one rank per sweep that offers the window, starting at the leader, so a
    // reopened window does not fund every hub's batch at once.
    reopenedBelowHorizon(current, reopened){
        let horizon = current - MAX_CATCHUP_WINDOWS * this.windowS;
        let starts = reopened.starts.filter(s => s < horizon && this.reopenedReady(s, reopened.tip))
            .sort((a, b) => a - b).slice(0, MAX_CATCHUP_WINDOWS);
        return starts.map(start => {
            let offered = this._reopenedOffers.get(start) || 0;
            this._reopenedOffers.set(start, offered + 1);
            return { windowStart: start, age: Math.min(offered, MAX_CATCHUP_WINDOWS - 1), reopened: true };
        });
    },

    // The DOGE blocks a reopened window waits: the blocks one batch window spans, and
    // never fewer than this network's reorg-depth floor.
    reopenWaitBlocks(){
        let floor = REOPEN_MIN_BLOCKS[this.network];
        if(!Number.isFinite(floor)) floor = REOPEN_MIN_BLOCKS.mainnet;
        return Math.max(Math.ceil(this.windowS / DOGE_BLOCK_S), floor);
    },

    // True once the tip has advanced REOPEN_WAIT_BLOCKS past where a sweep first saw
    // this window reopened; the first sighting is recorded here. No tip, no progress.
    reopenedReady(windowStart, tip){
        if(!Number.isFinite(tip)) return false;
        let seen = this.reopenSeen();
        let key = String(windowStart);
        if(!Number.isFinite(Number(seen[key]))){
            seen[key] = tip;
            this.saveReopenSeen();
            logger.info('AttestationBatchPublisher: window ' + windowStart + ' is reopened by a retraction; ' +
                        'it is offered again ' + this.reopenWaitBlocks() + ' DOGE blocks after tip ' + tip +
                        ' if the chain still shows no batch for it');
            return false;
        }
        return tip - Number(seen[key]) >= this.reopenWaitBlocks();
    },

    // The window was claimed for a publish or left `reopened`; its wait is spent.
    forgetReopened(windowStart){
        let seen = this.reopenSeen();
        if(!(String(windowStart) in seen)) return;
        delete seen[String(windowStart)];
        this.saveReopenSeen();
    },

    pruneReopenSeen(stillReopened){
        let seen = this.reopenSeen();
        let keep = new Set(stillReopened.map(String));
        let gone = Object.keys(seen).filter(k => !keep.has(k));
        if(gone.length === 0) return;
        for(let k of gone) delete seen[k];
        this.saveReopenSeen();
    },

    reopenSeen(){
        if(this._reopenSeen) return this._reopenSeen;
        let parsed = {};
        // A publisher built without its files keeps the sightings in memory only.
        if(!this.reopenSeenPath){ this._reopenSeen = parsed; return parsed; }
        try {
            let raw = JSON.parse(fs.readFileSync(this.reopenSeenPath, 'utf8'));
            if(raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw;
        } catch(e){
            if(e && e.code !== 'ENOENT')
                logger.warn('AttestationBatchPublisher: cannot read ' + this.reopenSeenPath + ' (' + e.message +
                            '); every reopened window waits a full window from now');
        }
        this._reopenSeen = parsed;
        return parsed;
    },

    // Written whole to a sibling and renamed over the file, so a crash leaves the old
    // copy or the new one. A failed write keeps the wait in memory for this process.
    saveReopenSeen(){
        if(!this.reopenSeenPath) return;
        let tmp = this.reopenSeenPath + '.next';
        try {
            fs.writeFileSync(tmp, JSON.stringify(this._reopenSeen || {}));
            fs.renameSync(tmp, this.reopenSeenPath);
        } catch(e){
            logger.error('AttestationBatchPublisher: cannot write ' + this.reopenSeenPath + ': ' + (e && e.message));
        }
    }

};
