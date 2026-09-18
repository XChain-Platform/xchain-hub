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
 * XChain Hub - Attestation cross-chain relay: the poll's reads
 *
 * Pages the federation list reads, refreshes the home and origin pending views each
 * tick, and filters refused relay rows once ATTEST_RELAY_REJECT_SLOT is armed. Every
 * read here fails closed by keeping the previous view. Installed on
 * AttestationRelay.prototype by src/attestation/relay.js.
 *
 ********************************************************************/

'use strict';

const axios      = require('axios');
// The refused-slot rule is a registry row on the block-TIME plane, read by literal
// key (W5); the clock goes in activeAt's time slot.
const gateRegistry = require('../../consensus/gate_registry');
const RELAY_REJECT_SLOT_KEY = 'attest_relay_reject_slot_activation.ATTEST_RELAY_REJECT_SLOT_ACTIVATION';
const { HOME_CHAIN, PAGE_LIMIT, MAX_PAGES, REFUSED_REQUEST_STATUS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Page a federation list read to exhaustion under the keyset cursor both attest
    // reads expose. Returns ok:false when the indexer is unreachable, which every
    // caller treats as "keep the previous view" rather than "the set is empty":
    // acting on a blind view is what double-broadcasts a fee.
    async fetchAllPages(coin, method, listField){
        let rows   = [];
        let latest = null;
        let cursor = null;
        for(let page = 0; page < MAX_PAGES; page++){
            let params = { limit: PAGE_LIMIT };
            if(cursor){
                params.after_block_index  = cursor.block_index;
                params.after_action_index = cursor.action_index;
            }
            let res;
            try { res = await this.indexerCall(coin, method, params); }
            catch(e){ return { ok: false, rows: [], latest: null }; }
            if(!res || !Array.isArray(res[listField])) return { ok: false, rows: [], latest: null };
            if(page === 0) latest = Number(res.latest_block_index);
            let pageRows = res[listField];
            rows = rows.concat(pageRows);
            if(pageRows.length < PAGE_LIMIT) break;
            let last = pageRows[pageRows.length - 1];
            cursor = { block_index: Number(last.block_index), action_index: Number(last.action_index) };
        }
        return { ok: true, rows: rows, latest: latest };
    },

    // Snapshot the home chain's pending request_ids. A materialized v3 lands here the
    // moment it is indexed (as an ordinary pending request row), which is why this is
    // kept alongside the wider _homeRelayed view: it answers "already materialized"
    // from a second, independently refreshed source, and from the chain itself rather
    // than from local bookkeeping, so it also covers a v3 broadcast by a PEER.
    async refreshHomePending(){
        if(!this.indexers[HOME_CHAIN] || !this.indexers[HOME_CHAIN].url) return;
        let res = await this.fetchAllPages(HOME_CHAIN, 'getpendingattestation_requests', 'requests');
        if(!res.ok) return;   // home indexer unreachable: keep the previous view rather than relaying blind
        this._homePending = new Set(res.rows.map(r => String(r.request_id || '').toLowerCase()));
    },

    async pollOriginRequests(coin){
        let res = await this.fetchAllPages(coin, 'getpendingattestation_requests', 'requests');
        if(!res.ok){
            // Same fail-closed stance as the home view, and it is what makes the
            // response leg safe: a stale-but-absent origin row would read as "the v4
            // already landed" and silently retire a relay that never happened.
            this._originPending[coin] = null;
            return;
        }
        this._originPending[coin] = new Map(res.rows.map(r => [String(r.request_id || '').toLowerCase(), r]));

        let latest = Number(res.latest);
        if(!Number.isFinite(latest)) return;
        // The tip the eviction pass measures this chain's deadlines against.
        this._originLatest[coin] = latest;
        for(let req of res.rows){
            try { await this.maybeMaterialize(coin, latest, req); }
            catch(e){
                logger.warn('AttestationRelay: materialize attempt failed for ' +
                    String(req && req.request_id).substring(0, 16) + '...: ' + (e && e.message));
            }
        }
    },

    // The response leg's discovery half, and the request leg's authoritative
    // already-materialized view. The home indexer answers with every request it holds
    // as a materialized relay leg, each carrying its terminal response when one
    // exists; a row that carries one is work this driver owes back to an origin chain.
    // Returns the rows for the acting pass, or null when the read failed, which leaves
    // the previous view standing rather than relaying blind.
    async refreshHomeRelayed(){
        if(!this.indexers[HOME_CHAIN] || !this.indexers[HOME_CHAIN].url) return null;
        let res = await this.fetchAllPages(HOME_CHAIN, 'getrelayedattestation_requests', 'requests');
        if(!res.ok) return null;
        let rows = await this.withoutRefusedRows(res.rows);
        this._homeRelayed = new Set(rows.map(r => String(r.request_id || '').toLowerCase()));
        return { ok: res.ok, rows: rows, latest: res.latest };
    },

    // Drop the REFUSED rows from the relayed view, but only once
    // ATTEST_RELAY_REJECT_SLOT is armed on the home chain.
    //
    // The indexer's relayed read returns a v3-materialized request at ANY lifecycle
    // status, a refusal included, and the driver treats every row in it as proof the
    // request is already on the home chain. A REFUSED row is the opposite: the id was
    // named by a malformed v3, nothing was attested, and the request the origin chain
    // is still waiting for was never materialized. While the gate was inert that row
    // also occupied the id in every indexer's DB (the single-v0 guard counts it), so
    // suppressing the broadcast was correct: the honest v3 would have been dropped on
    // arrival and the fee burned once per poll. Above the threshold the indexer stores
    // no such row, so a refusal can no longer stand in the honest relay's way and the
    // hub must stop letting one stand in its own.
    //
    // Only the wide relayed view needs this. The pending view never carries a refusal
    // (a refused request is not pending), and the per-id re-read a co-signer does
    // before a v4 demands a terminal response row, which a refused request cannot have
    // (a v1 is admitted only against a pending request).
    async withoutRefusedRows(rows){
        if(!Array.isArray(rows) || rows.length === 0) return Array.isArray(rows) ? rows : [];
        // The gate read costs a config lookup, so it is only taken when there is
        // actually a refusal in the view. A healthy fleet has none and pays nothing.
        if(!rows.some(r => String(r && r.request_status) === REFUSED_REQUEST_STATUS)) return rows;
        if(!await this.rejectSlotArmed()) return rows;
        let kept = rows.filter(r => String(r && r.request_status) !== REFUSED_REQUEST_STATUS);
        logger.warn('AttestationRelay: ignoring ' + (rows.length - kept.length) +
                     ' REFUSED ' + HOME_CHAIN + ' relay row(s) in the materialized view ' +
                     '(ATTEST_RELAY_REJECT_SLOT armed on ' + this.network +
                     '); the requests they name are still owed a relay');
        return kept;
    },

    // Is ATTEST_RELAY_REJECT_SLOT armed on the home chain as of its tip?
    //
    // PLANE: the home chain's own consensus timestamp, which is the plane the indexer
    // half resolves on (the LANDING block's block time), read off the chain_tips an
    // indexer pushes to this hub. A missing db, a hub no indexer has pushed a tip to,
    // or an unparseable/zero time answers NOT ARMED, which is the pre-arm behaviour
    // this method is a correction to: it costs a relay that waits, never a fee spent
    // on a v3 the fleet drops.
    async rejectSlotArmed(){
        let blockTime = null;
        try {
            if(this.db && typeof this.db.getChainTip === 'function'){
                let tip = await this.db.getChainTip(HOME_CHAIN, this.network);
                let t   = Number(tip && tip.blockTime);
                // getChainTip returns 0 for a tip row with no time, so 0 is "unknown"
                // here rather than a timestamp, and a 0-threshold network must not read
                // it as armed.
                if(Number.isFinite(t) && t > 0) blockTime = t;
            }
        } catch(e){
            blockTime = null;
        }
        if(blockTime == null){
            this.logRejectSlotPlaneOnce();
            return false;
        }
        return gateRegistry.activeAt(RELAY_REJECT_SLOT_KEY, this.network, null, null, blockTime);
    },

    logRejectSlotPlaneOnce(){
        if(this._rejectSlotPlaneLogged) return;
        this._rejectSlotPlaneLogged = true;
        logger.warn('AttestationRelay: no ' + HOME_CHAIN + ' tip time on ' + this.network +
                     ', so ATTEST_RELAY_REJECT_SLOT cannot be resolved; REFUSED relay rows still ' +
                     'count as materialized (wire an indexer tip push to lift this)');
    },

    async relayHomeResponses(home){
        let latest = Number(home.latest);
        if(!Number.isFinite(latest)) return;
        for(let row of home.rows){
            if(row.response_action_index == null) continue;   // nothing fulfilled yet
            try { await this.maybeRelayResponse(latest, row); }
            catch(e){
                logger.warn('AttestationRelay: response relay attempt failed for ' +
                    String(row && row.request_id).substring(0, 16) + '...: ' + (e && e.message));
            }
        }
    },

    async indexerCall(coin, method, params){
        let ix = this.indexers[coin];
        if(!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if(ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 },
                                    { headers, timeout: 15000 });
        if(resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        let result = resp.data ? resp.data.result : null;
        if(result && result.error) throw new Error('indexer error: ' + String(result.error));
        return result;
    }

};
