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
 * XChain Hub - Bridge Follower Verification
 *
 * What a peer runs before it signs a leader's proposed row: the round ids it re-derives for
 * itself, the bounds it holds a leader's choice fields to, and the independent re-read of
 * the transfer or the policy from this hub's own indexer.
 *
 ********************************************************************/

const crypto = require('crypto');
const { RELAY_MIN_FUTURE_S } = require('../../lib/relay_margin.js');
const { allCanonicalInts } = require('../../lib/canonical_int.js');
const { ALLOWED_CHAINS, PENDING_PAGE, TRANSFER_CANONICAL_INT_FIELDS, POLICY_CANONICAL_INT_FIELDS, SNAPSHOT_BLOCK_TOLERANCE } = require('./constants.js');

module.exports = {
    // sha256(XBRIDGE | network | src_chain:src_action_index | dest_chain:dest_address): one
    // id per source leg for the life of the chain, the CrossChainCallEngine._roundId shape
    // (a tagged preimage over the leg's own identity, nothing a hub reads from its own
    // clock or tip). snapshot_block is deliberately NOT in it. Every hub reads the BTC tip
    // from its own poll tick, so with the height inside the preimage three hubs whose
    // polls straddled one BTC block opened three rounds for one leg under three ids; a
    // PROPOSE for an id a follower never opened is buffered until it expires, and under a
    // stake-weighted quorum of equal validators every round needs every hub, so the leg
    // died at the round lifetime, every time, until a restart aligned the first polls.
    // The height is a leader-choice field now: the followers adopt it through the
    // consensus' snapshot rebind and validateTransfer bounds it to their own view.
    //
    // A retracted row keeps this id for the re-mined leg, which is what the revive branch
    // of db.insertBridgeTransfer is for. The id is hub-internal: the indexer verifies the
    // signatures over the mirrored row and never re-derives it.
    deriveTransferId(network, srcChain, srcActionIndex, destChain, destAddress){
        let s = 'XBRIDGE' +
                '|' + String(network || '') +
                '|' + String(srcChain) + ':' + String(srcActionIndex) +
                '|' + String(destChain) + ':' + String(destAddress);
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    },

    // sha256(network | origin_chain:tick | policy_seq | snapshot_block).
    deriveSnapshotId(network, originChain, tick, policySeq, snapshotBlock){
        let s = String(network || '') +
                '|' + String(originChain) + ':' + String(tick) +
                '|' + String(policySeq) +
                '|' + String(snapshotBlock);
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    },

    // ---------------------------------------------------------------------------
    // Follower verification
    // ---------------------------------------------------------------------------

    // What a peer runs before it signs a leader's proposed row. A Byzantine leader cannot
    // get us to sign a record we cannot independently see: the transfer is re-fetched from
    // OUR source-chain indexer field for field at OUR effective depth, and the policy is
    // re-read from OUR origin-chain indexer at the SAME origin_block and must hash the same.
    async validateProposedMatch(row){
        if(!row) return false;
        let hasTransfer = !!row.transfer_id;
        let hasPolicy   = !!row.snapshot_id;
        if(hasTransfer === hasPolicy) return false;

        // Leader-choice fields are ADOPTED, not re-derived, so bound them. effective_time
        // must sit in a window ahead of our own clock: the upper guard stops a far-future
        // stamp whose row never applies (a griefing hold on the escrow), the lower guard is
        // the propagation floor, because a row effective at or behind our clock is eligible
        // the instant it finalizes and two indexers then inject it at different blocks.
        let now = this._nowSeconds();
        if(!Number.isFinite(Number(row.effective_time)) ||
           Number(row.effective_time) - now > 3600 ||
           Number(row.effective_time) - now < RELAY_MIN_FUTURE_S) return false;
        // snapshot_block is the leader's own tip view, not part of either id, so this window
        // is the only thing that stops a Byzantine leader pinning an ancient validator set:
        // the CrossChainCallEngine.validateProposedMatch rule, the same 144 blocks, applied
        // to both families before any per-family gate reads the height.
        let myBlock = await this.resolveSnapshotBlock();
        if(myBlock != null && Math.abs(Number(row.snapshot_block) - Number(myBlock)) > SNAPSHOT_BLOCK_TOLERANCE) return false;
        // The snapshot block is a BTC height (the anchor that selects the validator set), so
        // it is judged against the BTC key. The source chain's own flag day is checked in
        // validateTransfer, at the height the leg was mined.
        if(!this.gateActive('bridge', Number(row.snapshot_block), 'BTC')) return false;

        return hasTransfer ? await this.validateTransfer(row) : await this.validatePolicy(row);
    },

    async validateTransfer(row){
        if(!(await this.transferGuardsHold(row))) return false;

        let res;
        try { res = await this._indexerCall(row.src_chain, 'getpendingbridgetransfers', { limit: PENDING_PAGE }); }
        catch(e){ return false; }
        if(!res || !Array.isArray(res.transfers)) return false;
        if(String(res.network || '') !== String(row.network || '')) return false;
        let latest = Number(res.latest_block_index);
        let leg = res.transfers.find(t => Number(t.src_action_index) === Number(row.src_action_index));
        if(!leg) return false;

        // Our OWN depth judgement, at the MIN_DEPTH our own indexer reports the lock stamped.
        let depth = latest - Number(leg.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.effectiveDepth(row.src_chain, leg.min_depth)) return false;

        // The SOURCE CHAIN's own flag day, at the height the leg was mined: the mirror of the
        // proposer's gate in maybeFinalizeTransfer, on the same (block, coin) pair, so a leg
        // from a chain that has not reached its own instant is refused by every follower
        // rather than admitted because BTC crossed first.
        if(!this.gateActive('bridge', Number(leg.block_index), row.src_chain)) return false;

        let fieldsMatch =
            String(leg.src_address)  === String(row.src_address) &&
            String(leg.dest_chain)   === String(row.dest_chain) &&
            String(leg.dest_address) === String(row.dest_address) &&
            String(leg.tick)         === String(row.tick) &&
            Number(leg.decimals)     === Number(row.decimals) &&
            this.amountsEqual(leg.amount, row.amount) &&
            // push_generation is stamped but never signed, so a Byzantine leader could
            // otherwise inflate it and evade the fence a later source-keyed retraction
            // applies (<= retraction_generation). Pin it to our own indexer's view.
            (Number(leg.push_generation) || 0) === (Number(row.push_generation) || 0);
        if(!fieldsMatch) return false;

        // The id re-derives from the leg alone; the leader's snapshot_block was bounded to
        // this hub's own tip window in validateProposedMatch and is otherwise adopted.
        let derived = this.deriveTransferId(row.network, row.src_chain, Number(row.src_action_index),
                                             row.dest_chain, row.dest_address);
        return String(derived).toLowerCase() === String(row.transfer_id).toLowerCase();
    },

    // What a proposed transfer must clear before this hub reads its own indexer: canonical
    // spellings, the chain pair, network and token gate, and both halves of source-leg uniqueness.
    async transferGuardsHold(row){
        if(!allCanonicalInts(row, TRANSFER_CANONICAL_INT_FIELDS)) return false;
        if(!ALLOWED_CHAINS.includes(row.src_chain) || !ALLOWED_CHAINS.includes(row.dest_chain)) return false;
        if(row.src_chain === row.dest_chain) return false;
        if(String(row.network || '') !== String(this.network || '')) return false;
        if(String(row.tick) !== 'XCHAIN' && !this.gateActive('token', Number(row.snapshot_block), 'BTC')) return false;

        // Source-leg uniqueness, the follower's OWN refusal (section 7, D14's poll/sign/
        // insert/retract cycle assumes one record per source leg): a leader could bypass its
        // own maybeFinalizeTransfer guard (be Byzantine, or lag on a stale in-memory set
        // after a restart) and propose a SECOND transfer for a leg this hub already holds a
        // persisted, non-retracted record for. Comparing ids rather than just existence lets
        // a re-validation of the SAME already-persisted round (an identical transfer_id,
        // e.g. a retried FINAL_SYNC) through, and refuses only a genuinely different one.
        // With the id a pure function of the leg, "different" now means a forged preimage.
        let existingId = await this.db.getBridgeTransferIdForSource(row.network, row.src_chain, Number(row.src_action_index));
        if(existingId && String(existingId).toLowerCase() !== String(row.transfer_id).toLowerCase()) return false;

        // Second half of the same refusal, for the window the database cannot speak to: a
        // round this hub already has OPEN for the leg has written nothing, so the read above
        // returns null. The row of THIS hub's own open round is exempt (its transfer_id maps
        // to the same leg key), and because every honest hub derives the one id for a leg,
        // a leader's row for a leg this hub opened a round for at its OWN tip carries that
        // same id and is co-signed: the leader's snapshot_block is adopted, not matched.
        let legKey = String(row.network || '') + '|' + String(row.src_chain || '') + ':' + Number(row.src_action_index);
        if(this._inflightSourceLegs.has(legKey) &&
           this._inflightTransferLeg.get(String(row.transfer_id).toLowerCase()) !== legKey) return false;
        return true;
    },

    async validatePolicy(row){
        // snapshot_block is a BTC height, as everywhere else the anchor is read.
        if(!this.gateActive('policy', Number(row.snapshot_block), 'BTC')) return false;
        if(!allCanonicalInts(row, POLICY_CANONICAL_INT_FIELDS)) return false;
        if(!ALLOWED_CHAINS.includes(row.origin_chain)) return false;
        if(String(row.network || '') !== String(this.network || '')) return false;
        if(!Number.isInteger(Number(row.policy_seq)) || Number(row.policy_seq) < 1) return false;
        if(!/^[0-9a-f]{64}$/.test(String(row.policy_hash || '').toLowerCase())) return false;

        // Never co-sign a SECOND content at a seq we already finalized: that is exactly the
        // conflicting-canonical shape SLASH judges, and signing it would make this validator
        // provably equivocating over its own record.
        let held = await this.db.getPolicySnapshotAtSeq(row.network, row.origin_chain, row.tick, Number(row.policy_seq));
        if(held && String(held.policy_hash).toLowerCase() !== String(row.policy_hash).toLowerCase()) return false;

        // Our own read, at the SAME origin_block, from our own origin indexer. A read
        // FAILURE abstains (no co-signature, the round retries next cycle); it never
        // refuses, because an unreachable indexer is our problem, not the leader's.
        let policy;
        try { policy = await this._indexerCall(row.origin_chain, 'gettokenpolicy',
                                               { tick: row.tick, origin_block: Number(row.origin_block) }); }
        catch(e){ return false; }
        if(!policy || policy.error) return false;

        let shaped = this.shapePolicy(policy);
        if(!shaped || shaped.oversized) return false;
        let hash = this.policyHash(shaped.allow, shaped.block, shaped.sleeping);
        if(hash !== String(row.policy_hash).toLowerCase()) return false;

        // The transport arrays must hash to the hash we just agreed on, or every destination
        // would refuse the row after we had already signed it.
        let asArray = (v) => {
            if(v === null || v === undefined) return null;
            try { let p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : undefined; }
            catch(e){ return undefined; }
        };
        let allow = asArray(row.allow_list);
        let block = asArray(row.block_list);
        if(allow === undefined || block === undefined) return false;
        if(!this.isCanonicalOrder(allow) || !this.isCanonicalOrder(block)) return false;
        if(this.policyHash(allow, block, Number(row.sleeping) === 1) !== hash) return false;

        let derived = this.deriveSnapshotId(row.network, row.origin_chain, row.tick,
                                             Number(row.policy_seq), Number(row.snapshot_block));
        return String(derived).toLowerCase() === String(row.snapshot_id).toLowerCase();
    },
};
