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
 * XChain Hub - Call Relay Polling
 *
 * Both legs of the relay as the engine discovers them: confirmed XCALL requests on a source
 * chain and the dispatch round each opens, the injected execution's outcome on a target
 * chain and its result round, plus the backoff that keeps a result-less dispatch from
 * pinning the poll window, and the operator-visible reads over the same rows.
 *
 ********************************************************************/

const { XCALL_MAX_HOPS } = require('../../constants.js');
const { ALLOWED_CHAINS, RESULT_STATUSES, RESULT_BACKOFF_BASE_MS, RESULT_BACKOFF_MAX_MS, RESULT_BACKOFF_EXCLUDE_MAX, RESULT_BACKOFF_MAP_MAX, CALL_LIST_MAX } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // Return operator-visible relay backlog depth and lifetime failure counter.
    // Mirrors getattestationstats: pending_relay_count is the number of dispatch
    // rows per target chain that do not yet have a result row; result_attempt_failures
    // is a process-lifetime count of per-call errors in pollTargetResults.
    async getStats(){
        let rows = [];
        try {
            // Mirror pollTargetResults' retracted-result filter so the backlog
            // count matches what the engine will actually re-relay: a
            // dispatch whose only result row is 'retracted' is pending again.
            rows = await this.db.findCrossChainCallsByPhase();
        } catch(e){
            logger.warn('CrossChainCall: getStats query failed: ' + (e && e.message));
        }
        let pending_by_chain = {};
        for(let r of rows) pending_by_chain[r.target_chain] = Number(r.pending_relay_count);
        return {
            pending_relay_count:      rows.reduce((s, r) => s + Number(r.pending_relay_count), 0),
            pending_by_chain:         pending_by_chain,
            result_attempt_failures:  this._resultAttemptFailures
        };
    },

    // Surface one XCALL relay lifecycle for the explorer/dashboard. Reads
    // the hub's OWN cross_chain_calls table and returns both phases keyed by call_id
    // as { call_id, dispatch, result }. dispatch/result are null when absent (e.g. a
    // dispatched call whose target execution has not been relayed back yet). Includes
    // retracted rows so a caller can see a reorged-away call's last-known state; the
    // row's own `status` field distinguishes finalized from retracted. Read-only.
    async getCall(callId){
        if(!callId) return null;
        let rows = await this.db.findCrossChainCallPhasesByCallId(String(callId));
        if(!rows || rows.length === 0) return null;
        return {
            call_id:  String(callId),
            dispatch: rows.find(r => r.phase === 'dispatch') || null,
            result:   rows.find(r => r.phase === 'result')   || null
        };
    },

    // List XCALL relay rows for the explorer/dashboard, newest first,
    // with optional source_chain/target_chain/status/phase filters. Read-only.
    async listCalls({sourceChain, targetChain, status, phase, limit} = {}){
        let n = parseInt(limit);
        if(!Number.isInteger(n) || n <= 0) n = 50;
        if(n > CALL_LIST_MAX) n = CALL_LIST_MAX;
        return await this.db.findCrossChainCallsForSurface({sourceChain, targetChain, status, phase}, n);
    },

    async _poll(){
        if(this._polling) return;                       // never overlap slow polls
        this._polling = true;
        try {
            for(let coin of ALLOWED_CHAINS){
                if(!this.indexers[coin].url) continue;
                await this.pollSourceRequests(coin);
                await this.pollTargetResults(coin);
            }
        } finally {
            this._polling = false;
        }
    },

    // Discover XCALL v0 requests on `coin` that have reached confirmation depth
    // and have no dispatch row yet, and run a dispatch round for each.
    async pollSourceRequests(coin){
        let res;
        try { res = await this._indexerCall(coin, 'getpendingcrosschaincalls', { limit: 100 }); }
        catch(e){ return; }
        if(!res || !Array.isArray(res.calls) || !res.network) return;
        let latest = Number(res.latest_block_index);
        if(!Number.isFinite(latest)) return;

        for(let call of res.calls){
            try { await this.maybeDispatch(coin, String(res.network), latest, call); }
            catch(e){ logger.warn('CrossChainCall: dispatch attempt failed for ' +
                                   String(call && call.call_id).substring(0, 16) + '...: ' + (e && e.message)); }
        }
    },

    async maybeDispatch(coin, network, latestBlock, call){
        let callId = String(call.call_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(callId)) return;
        if(!ALLOWED_CHAINS.includes(call.target_chain) || call.target_chain === coin) return;

        // Confirmation gate: the one defense against relaying a reorg-able
        // request (the target-side execution cannot be retracted).
        let depth = latestBlock - Number(call.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return;

        // Deadline gate: the source chain will locally expire this request; a
        // late dispatch would be wasted work (the result callback loses the
        // exactly-once interlock race deterministically, but don't bother).
        if(call.deadline_block != null && Number(call.deadline_block) <= latestBlock) return;

        // Hop-cap gate (defense-in-depth): the indexer caps cross_hops at
        // XCALL_MAX_HOPS during execution, so a relay row that exceeds the cap
        // would be rejected at injection anyway. Drop it here to avoid a wasted
        // PBFT round and a stale dispatch row.
        if((Number(call.cross_hops) || 0) > XCALL_MAX_HOPS) return;

        let roundId = this._roundId('dispatch', callId);
        if(this._inflight.has(roundId)) return;
        if(await this.rowExists(callId, 'dispatch')) return;

        let snapshotBlock = await this.resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let row = this.buildDispatchRow(coin, network, call, callId, roundId, snapshotBlock);

        if(!await this.stampAdmission(row)) return;

        let validators = await this.resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(roundId);
        try {
            await this.consensus.propose(roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(roundId);
            throw e;
        }
    },

    buildDispatchRow(coin, network, call, callId, roundId, snapshotBlock){
        let row = {
            round_id:              roundId,
            call_id:               callId,
            phase:                 'dispatch',
            snapshot_block:        Number(snapshotBlock),
            network:               network,
            source_chain:          coin,
            source_action_index:   Number(call.action_index),
            source_contract_index: Number(call.source_contract_index),
            target_chain:          String(call.target_chain),
            target_contract_index: Number(call.target_contract_index),
            method:                String(call.method),
            params_json:           String(call.params_json || '[]'),
            gas_limit:             Number(call.gas_limit),
            cross_hops:            Number(call.cross_hops) || 0,
            effective_time:        this.relayEffectiveTime(String(call.target_chain)),
            result_status:         null,
            return_payload_b64:    null,
            // Source-chain reorg fence: the source indexer's generation
            // for this call, mirrored from getpendingcrosschaincalls. The result row
            // inherits it so a source-keyed retraction fences both phases by the same
            // generation. Metadata only; NOT part of the signed canonical.
            push_generation:       Number(call.push_generation) || 0
        };
        return row;
    },

    // Discover dispatch rows targeting `coin` whose injected execution has
    // completed at confirmation depth, and run a result round for each.
    async pollTargetResults(coin){
        // The result-leg join carries `AND r.status <> 'retracted'` for the same
        // reason rowExists does: after a deep reorg leaves a 'retracted'
        // result row, an unfiltered join would see r.id IS NOT NULL, exclude the
        // dispatch, and never re-relay the result (the call could then only deliver
        // the deterministic 'expired' callback). Filtering retracted result rows
        // back out re-opens re-discovery; maybeRelayResult re-relay is idempotent
        // (synthetic TX_HASH dedup) so re-relay after re-discovery is safe.
        // Exclude call_ids still inside their backoff window so a permanently
        // result-less dispatch cannot pin the ORDER BY id ASC window (M-14). Bounded
        // to keep the NOT IN list (and query) small; beyond the bound the remaining
        // parked rows fall back to the id-window, which is the pre-fix behavior only
        // for that pathological tail.
        let now = Date.now();
        let parked = [];
        for(let [cid, b] of this._resultBackoff){
            if(b.nextAt > now){ parked.push(cid); if(parked.length >= RESULT_BACKOFF_EXCLUDE_MAX) break; }
        }
        let pending = await this.db.findCrossChainCallDispatchesAwaitingResult(coin, parked);
        for(let d of pending){
            let callId = String(d.call_id).toLowerCase();
            try {
                // maybeRelayResult returns false when the result is not yet available
                // (missing / below depth): park it so it leaves the hot window. Any
                // other outcome (round proposed, or already in flight) clears backoff.
                let relayed = await this.maybeRelayResult(coin, d);
                if(relayed === false) this.parkResult(callId);
                else this._resultBackoff.delete(callId);
            } catch(e){
                this._resultAttemptFailures++;
                this.parkResult(callId);
                logger.warn('CrossChainCall: result attempt failed for ' +
                             callId.substring(0, 16) + '...: ' + (e && e.message));
            }
        }
    },

    // Park a result-less dispatch with exponential backoff so it exits the hot poll
    // window; it re-enters once nextAt elapses. See RESULT_BACKOFF_* rationale.
    parkResult(callId){
        let evicting = !this._resultBackoff.has(callId) && this._resultBackoff.size >= RESULT_BACKOFF_MAP_MAX;
        if(evicting){
            let oldest = this._resultBackoff.keys().next().value;
            if(oldest !== undefined) this._resultBackoff.delete(oldest);
        }
        let b = this._resultBackoff.get(callId) || { attempts: 0, nextAt: 0 };
        b.attempts++;
        let delay = Math.min(RESULT_BACKOFF_BASE_MS * Math.pow(2, b.attempts - 1), RESULT_BACKOFF_MAX_MS);
        b.nextAt = Date.now() + delay;
        this._resultBackoff.set(callId, b);
    },

    // Returns true when the result exists and a relay round was proposed (or is
    // already in flight); false when the result is not yet available (missing on the
    // target indexer, or not yet at confirmation depth) so the caller can park it (M-14).
    async maybeRelayResult(coin, dispatch){
        let callId = String(dispatch.call_id).toLowerCase();
        let roundId = this._roundId('result', callId);
        if(this._inflight.has(roundId)) return true;   // round already progressing; don't park

        let res;
        try { res = await this._indexerCall(coin, 'getcrosschaincallresult', { call_id: callId }); }
        catch(e){ return false; }
        if(!res || res.exists !== true) return false;

        // Execution must be at confirmation depth on the target chain before the
        // federation vouches for it back to the source chain (a shallow target
        // reorg would otherwise relay an outcome that never finalized).
        let latest = Number(res.latest_block_index);
        let depth  = latest - Number(res.executed_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return false;

        let resultStatus = RESULT_STATUSES.includes(res.status) ? String(res.status) : 'error';

        let snapshotBlock = await this.resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let row = {
            round_id:              roundId,
            call_id:               callId,
            phase:                 'result',
            snapshot_block:        Number(snapshotBlock),
            network:               String(dispatch.network),
            source_chain:          String(dispatch.source_chain),
            source_action_index:   Number(dispatch.source_action_index),
            source_contract_index: Number(dispatch.source_contract_index),
            target_chain:          coin,
            target_contract_index: Number(dispatch.target_contract_index),
            method:                String(dispatch.method),
            params_json:           String(dispatch.params_json),
            gas_limit:             Number(dispatch.gas_limit),
            cross_hops:            Number(dispatch.cross_hops) || 0,
            effective_time:        this.relayEffectiveTime(String(dispatch.source_chain)),
            result_status:         resultStatus,
            return_payload_b64:    (res.return_payload_b64 == null) ? '' : String(res.return_payload_b64),
            // Inherit the source generation from the dispatch row so the source-keyed
            // reorg retraction fences this result phase by the same generation.
            push_generation:       Number(dispatch.push_generation) || 0
        };

        if(!await this.stampAdmission(row)) return;

        let validators = await this.resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(roundId);
        try {
            await this.consensus.propose(roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(roundId);
            throw e;
        }
        return true;   // result found and a relay round proposed; clear any backoff
    },
};
