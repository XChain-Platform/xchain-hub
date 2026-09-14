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
 * XChain Hub - Call Follower Verification
 *
 * The independent confirmation a peer runs before signing a relay row: the bounds on the
 * leader's choice fields, the dispatch re-fetched field for field from this hub's own source
 * indexer, and the result re-read from its own target indexer at confirmation depth.
 *
 ********************************************************************/

const { RELAY_MIN_FUTURE_S } = require('../../lib/relay_margin.js');
// Canonical integer-spelling guard for the signed fields (see lib/canonical_int.js).
const { allCanonicalInts } = require('../../lib/canonical_int.js');
const { ALLOWED_CHAINS, RESULT_STATUSES, CANONICAL_INT_FIELDS } = require('./constants.js');

module.exports = {
    // Independent confirmation a peer runs before signing a leader's proposed
    // row. Dispatch: the request must exist on OUR source-chain indexer, field-
    // for-field, at confirmation depth. Result: the execution outcome must
    // exist on OUR target-chain indexer, byte-for-byte, at confirmation depth.
    // A Byzantine leader cannot get us to sign a relay we can't independently see.
    async validateProposedMatch(row){
        if(!row || !ALLOWED_CHAINS.includes(row.source_chain) || !ALLOWED_CHAINS.includes(row.target_chain)) return false;
        if(row.source_chain === row.target_chain) return false;
        if(String(row.round_id).toLowerCase() !== this._roundId(row.phase, String(row.call_id).toLowerCase())) return false;

        // Canonical integer spellings. These fields are signed verbatim but
        // re-derived from a BIGINT round-trip by xexec.js and the archive verifier, so
        // a leader-supplied '041' would pass every Number()-based check below, collect
        // an honest quorum, and finalize a row whose signatures no verifier can ever
        // rebuild - permanently stranding the call, because rowExists still sees it.
        // Fail closed BEFORE any numeric comparison; honest leaders build these with
        // Number(), so this never fires on an honest round.
        if(!CANONICAL_INT_FIELDS[row.phase]) return false;
        if(!allCanonicalInts(row, CANONICAL_INT_FIELDS[row.phase])) return false;

        // Leader-choice fields are adopted (not byte-matched) by followers, so
        // bound them: effective_time in a window ahead of our clock, snapshot_block
        // within a day of BTC blocks of our own tip view (when we can resolve
        // one). Pinning an ancient snapshot_block would let a Byzantine leader
        // select a stale validator set for indexer-side signature verification.
        //
        // The window is ASYMMETRIC. The upper guard is the old griefing
        // bound: a far-future row would never settle. The lower guard is a
        // propagation floor: an effective_time at or behind our clock makes the row
        // eligible the instant it finalizes, so an indexer that already holds it
        // injects a block earlier than one still receiving it, and their action-index
        // counters (which feed the call_id preimage) fork for good. A faulty leader,
        // or one whose XCALL_RELAY_MARGIN_BLOCKS was zeroed, is refused here even
        // though its own producer-side floor was bypassed. RELAY_MIN_FUTURE_S is far
        // below any producer margin, so this costs an honest round nothing: it still
        // tolerates 3600 - RELAY_MIN_FUTURE_S seconds of adverse clock skew.
        let now = this._nowSeconds();
        if(!Number.isFinite(Number(row.effective_time)) ||
           Number(row.effective_time) - now > 3600 ||
           Number(row.effective_time) - now < RELAY_MIN_FUTURE_S) return false;
        let myBlock = await this.resolveSnapshotBlock();
        if(myBlock != null && Math.abs(Number(row.snapshot_block) - Number(myBlock)) > 144) return false;

        // The admission map is a leader-choice field too, and above the activation it is
        // the field that decides WHEN every indexer binds this row. Bound it against our
        // own tips before the phase re-derivation, which is the expensive half.
        if(!(await this.checkProposedAdmission(row))) return false;

        if(row.phase === 'dispatch') return await this.validateDispatch(row);
        if(row.phase === 'result')   return await this.validateResult(row);
        return false;
    },

    async validateDispatch(row){
        let res;
        try { res = await this._indexerCall(row.source_chain, 'getcrosschaincall', { call_id: String(row.call_id) }); }
        catch(e){ return false; }
        if(!res || res.exists !== true || !res.call) return false;
        if(String(res.network || '') !== String(row.network || '')) return false;

        let call  = res.call;
        let latest = Number(res.latest_block_index);
        let depth  = latest - Number(call.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[row.source_chain]) return false;

        // Lifecycle gates, mirroring maybeDispatch. The leader path never
        // even sees an expired or settled request: it polls getpendingcrosschaincalls
        // (SQL-filtered to request_status='pending') and refuses to START a round once
        // the deadline is reached. The follower path re-fetches by call_id through
        // getcrosschaincall, which serves the row whatever its lifecycle state, so
        // without these two lines a round begun just before expiry finalizes after it:
        // honest followers co-sign, the target executes the dispatch, and the source
        // has meanwhile fired the terminal 'expired' callback for the same request.
        // The deadline predicate is the leader's byte-for-byte, so a follower can only
        // ever be as strict as the hub that proposed the round, never stricter.
        if(call.deadline_block != null && Number(call.deadline_block) <= latest) return false;
        if(call.request_status != null && String(call.request_status) !== 'pending') return false;

        return Number(call.action_index)           === Number(row.source_action_index) &&
               Number(call.source_contract_index)  === Number(row.source_contract_index) &&
               String(call.target_chain)           === String(row.target_chain) &&
               Number(call.target_contract_index)  === Number(row.target_contract_index) &&
               String(call.method)                 === String(row.method) &&
               String(call.params_json || '[]')    === String(row.params_json) &&
               Number(call.gas_limit)              === Number(row.gas_limit) &&
               (Number(call.cross_hops) || 0)      === (Number(row.cross_hops) || 0) &&
               // Pin the source-reorg fence generation to the value our own source
               // indexer reports for this call (mirrors the DEX validateProposedMatch
               // per-leg pin). push_generation is stamped onto the row but never
               // enters the signed canonical, so without this a Byzantine leader
               // could inflate it and evade a later source-keyed retraction fence.
               (Number(call.push_generation) || 0) === (Number(row.push_generation) || 0);
    },

    async validateResult(row){
        // The dispatch row must already be finalized in our own DB (we never
        // vouch for a result of a dispatch we don't know).
        // Treat a retracted dispatch as absent, exactly as the sibling dispatch lookups
        // do (a reorg marks status='retracted' + broadcasts a deletion). Without this
        // filter a follower co-signs a result round bound to a dispatch its own reorg
        // already retracted.
        let d = await this.db.getCrossChainCallByCallId(String(row.call_id).toLowerCase());
        if(!d.length) return false;
        if(String(d[0].source_chain) !== String(row.source_chain) ||
           String(d[0].target_chain) !== String(row.target_chain) ||
           String(d[0].network)      !== String(row.network || '')) return false;
        // Pin the dispatch-inherited reorg-fence metadata to our OWN dispatch row.
        // source_action_index and push_generation are NOT in the signed result
        // canonical, yet retractCallsForReorg selects by source_action_index and
        // fences by push_generation. A Byzantine round leader could otherwise stamp
        // a divergent value here; followers would co-sign and persist it, and a
        // later source-chain reorg retraction could then miss the sibling result
        // row while catching the dispatch (breaking the both-phases-retracted
        // invariant). Reject any result row whose inherited metadata does not match
        // the dispatch row we independently finalized.
        if(Number(d[0].source_action_index)   !== Number(row.source_action_index) ||
           Number(d[0].push_generation || 0)  !== Number(row.push_generation || 0)) return false;

        let res;
        try { res = await this._indexerCall(row.target_chain, 'getcrosschaincallresult', { call_id: String(row.call_id) }); }
        catch(e){ return false; }
        if(!res || res.exists !== true) return false;

        let latest = Number(res.latest_block_index);
        let depth  = latest - Number(res.executed_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[row.target_chain]) return false;

        let resultStatus = RESULT_STATUSES.includes(res.status) ? String(res.status) : 'error';
        let payload = (res.return_payload_b64 == null) ? '' : String(res.return_payload_b64);
        return resultStatus === String(row.result_status) &&
               this._sha256(payload) === this._sha256(String(row.return_payload_b64 == null ? '' : row.return_payload_b64));
    },
};
