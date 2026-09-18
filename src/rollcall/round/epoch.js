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
 * XChain Hub - ROLLCALL round: the tick and the epoch
 *
 * When this hub signs: the poll that opens and prunes rounds, the newest epoch
 * it may sign for, and the epoch run that signs and gossips.
 *
 * src/rollcall/round.js installs every method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods, so callers and tests keep
 * reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const rca                        = require('../../consensus/gates/rollcall_gate.js');
const { CANONICAL_REORG_BUFFER } = require('../../consensus/snapshot_reorg_buffer.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const { XROLLCALL_SIGN } = require('./wire.js');

// How far past the accept window a finished round is kept in memory, so a late
// gossiped signature or a status read still finds it before it is pruned.
const ROUND_RETENTION_BLOCKS = 24;

// The epoch's advisory member set: the well-formed keys of the whole-federation
// snapshot, which the chain's responsible set is a subset of.
function memberSet(snap){
    let members = new Set();
    for(let v of snap.validators){
        let pk = String((v && v.pubkey) || v || '').toLowerCase();
        if(/^[0-9a-f]{64}$/.test(pk)) members.add(pk);
    }
    return members;
}

// A fresh round record: the epoch's signed form, the collected signatures, and
// the per-role publish slots the ladder spends.
function newRoundState(ctx){
    let { epoch, ledgerHash, canonical, members, gates } = ctx;
    return {
        epoch, ledgerHash, canonical, members, gates,
        sigs:         new Map(),   // pubkey -> sig, deduped, verified
        signed:       false,
        order:        null,        // election order, resolved lazily at publish time
        leader:       null,
        myRank:       -1,
        published:    false,       // this hub has spent its per-epoch sweep publish
        selfPublished:false,
        ownSigOnWire: false,       // our own signature rode one of OUR broadcasts
        // Pubkeys this hub has actually put on the wire for this epoch, marked
        // per CHUNK rather than per batch. A multi-action publish that fails
        // half way releases its slot, and without this the retry rebuilds the
        // whole set and pays a second fee for signatures already broadcast.
        sent:         new Set(),
        onChainCount: null,        // last observed count from the DOGE read
        txids:        [],
        startedAt:    Date.now(),
    };
}

// Sign. EVERY validator signs, wallet or not: the sweepers exist so a hub
// with no DOGE wallet still gets rolled, so a wallet requirement here
// would evict exactly the validators the sweepers were built to carry.
function signEpoch(self, state, myPubkey){
    if(!myPubkey) return;
    let { epoch, ledgerHash, canonical, members } = state;
    let stored = self._signatures.get(epoch);
    let sig;
    if(stored && stored.ledgerHash === ledgerHash){
        // Restart re-emit: the same signature, not a fresh one.
        sig = stored.sig;
    } else {
        sig = self.identity.sign(canonical);
        self.recordSignature({ epoch, pubkey: myPubkey, ledger_hash: ledgerHash, sig });
        self._signatures.set(epoch, { ledgerHash, sig });
    }
    state.signed = true;
    // Our own signature goes through the same membership rule as a peer's,
    // so the collected set has one definition rather than two. A hub with
    // no active stake is in no responsible set and cannot be evicted.
    if(members.has(myPubkey)) state.sigs.set(myPubkey, sig);
    if(self.peerManager) self.peerManager.broadcast(XROLLCALL_SIGN, { epoch, pubkey: myPubkey, sig });
}

module.exports = {

    // ── the tick ─────────────────────────────────────────────────────────────

    async tick(){
        // In-flight guard, the house convention: a tick makes several sequential
        // RPC round trips at a 15s timeout against a 30s poll, so under a slow
        // indexer the next interval fires while this one is still awaiting, and
        // two overlapping ticks would both pass the rounds.has() test before
        // either reached rounds.set().
        if(this._ticking) return;
        this._ticking = true;
        try {
            let tip = await this.indexerCall('getblockhashes', {});
            let tipBlock = (tip && tip.block_index != null) ? Number(tip.block_index) : null;
            if(!Number.isFinite(tipBlock)) return;
            this.lastTip = tipBlock;

            let epoch = this.newestSignableEpoch(tipBlock);
            if(epoch !== null && !this.rounds.has(epoch)) await this.runEpoch(epoch, tipBlock);

            // Every open round advances on every tick, not just the newest: the
            // sweeper ladder and the self-publish escape hatch both unlock on the
            // tip moving away from an epoch that was created blocks ago.
            for(let [e, state] of this.rounds){
                if(tipBlock - e > this.acceptWindow + ROUND_RETENTION_BLOCKS){ this.rounds.delete(e); continue; }
                try { await this.advance(state, tipBlock); }
                catch(err){ logger.warn(nodeUtil.format('RollcallRound: epoch ' + e + ' advance failed:', err && err.message ? err.message : err)); }
            }
        } finally {
            this._ticking = false;
        }
    },

    // The newest epoch boundary this hub may sign for at `tipBlock`: buried by
    // CANONICAL_REORG_BUFFER (signing for a block that can still be reorged out
    // would produce a signature over a ledger_hash nobody else ever sees) and
    // still inside the accept window (past it, no signature can land). Null when
    // no such epoch exists.
    //
    // Epoch 0 is a REAL epoch on regtest, so a falsy check on the height is a bug.
    newestSignableEpoch(tipBlock){
        if(!Number.isFinite(this.interval) || this.interval <= 0) return null;
        let epoch = Math.floor(tipBlock / this.interval) * this.interval;
        // The newest boundary may not be buried yet; step back one interval.
        if(tipBlock - epoch < CANONICAL_REORG_BUFFER) epoch -= this.interval;
        if(epoch < 0) return null;
        if(!rca.isRollcallEpoch(epoch, this.network)) return null;
        if(!rca.isRollcallActive(epoch, this.network)) return null;
        if(tipBlock - epoch > this.acceptWindow) return null;
        return epoch;
    },

    // ── sign + gossip ────────────────────────────────────────────────────────

    async runEpoch(epoch, tipBlock){
        let bh = await this.indexerCall('getblockhashes', { block_index: epoch });
        let ledgerHash = (bh && bh.ledger_hash) ? String(bh.ledger_hash).toLowerCase() : '';
        if(!/^[0-9a-f]{64}$/.test(ledgerHash)){
            logger.warn('RollcallRound: epoch=' + epoch + ' skipped (no ledger_hash from the BTC indexer)');
            return;
        }

        // The advisory member set: every staker with any active stake at the
        // epoch (CapabilitySnapshot buries the height itself, landing on the same
        // block the chain's responsible set resolves at). UNFLOORED and
        // capability-free on purpose, so it is a superset of the chain's R(E):
        // the chain decides membership, and a hub-side floor could only ever
        // discard a signature the chain would have counted.
        //
        // An unresolved snapshot (any indexer failure) makes this hub ABSTAIN for
        // the epoch rather than degrade to a partial set. A partial set is not a
        // smaller answer, it is a different one: this hub would drop honest peers'
        // signatures as outsiders and publish a roll call missing them, and an
        // absence is an eviction.
        let snap = await this.capabilitySnapshot.getActiveWeightSnapshot(epoch);
        if(!snap || !Array.isArray(snap.validators)){
            logger.warn('RollcallRound: epoch=' + epoch + ' skipped (whole-federation snapshot unresolved; ' +
                         'ABSTAINING rather than collecting against a partial member set)');
            return;
        }
        let members = memberSet(snap);

        // Resolved ONCE per epoch and carried on the round state: the canonical this
        // hub signs, the canonical it verifies every peer's signature against
        // (onSign reads state.canonical) and the wire it publishes must all be the
        // same form, and re-deriving the form at each of those sites is how they
        // would come to disagree mid-epoch.
        let gates     = this.gatesFor(epoch);
        let canonical = this.canonical(epoch, ledgerHash, gates);
        let myPubkey  = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;

        let state = newRoundState({ epoch, ledgerHash, canonical, members, gates });
        this.rounds.set(epoch, state);

        signEpoch(this, state, myPubkey);

        // Peers that signed before this hub opened the round: judged now, by the
        // same rule as a live message, and dropped from the holding area either way.
        let early = this._earlySigs.get(epoch);
        this._earlySigs.delete(epoch);
        for(let e of this._earlySigs.keys()) if(e < epoch) this._earlySigs.delete(e);
        if(early) for(let [pk, sig] of early) this.onSign({ epoch, pubkey: pk, sig });

        logger.info('RollcallRound: epoch=' + epoch + ' ledger_hash=' + ledgerHash.substring(0, 16) +
                    '... members=' + members.size + ' signed=' + (state.signed ? 'yes' : 'no identity') +
                    ' v=' + (gates === null ? '0' : '1' + ' gates=' + gates.split(',').length));
    }
};
