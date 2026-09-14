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
 * XChain Hub - ROLLCALL round: publish
 *
 * What reaches DOGE and when: the per-tick advance, the sweep and self-publish
 * roles, the chunked fee-bearing publish itself, and the on-chain read that
 * keeps a publish from paying for signatures already landed.
 *
 * src/rollcall/round.js installs every method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods, so callers and tests keep
 * reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const { isAmbiguousSendError }   = require('../../lib/idempotent_broadcast.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const { roundClass, ACTION_DATA_CEILING } = require('./wire.js');

// The cap is per EPOCH, not per build: a v1 epoch carries the GATES field in
// every action, so its pairs-per-action budget is what the ceiling leaves
// after that string. chunkPairs falls back to the v0 41 on a non-positive
// size, so the refusal has to happen here rather than there. Null means this
// epoch's GATES field leaves no room for a pair at all.
function planChunks(self, state, pairs, kind){
    let maxPairs = roundClass().maxPairsForGates(state.gates);
    if(maxPairs < 1){
        logger.error('RollcallRound: the GATES field is ' + String(state.gates).length +
                      ' bytes, leaving no room for a signature pair inside the ' +
                      ACTION_DATA_CEILING + '-byte action-data ceiling (epoch ' + state.epoch +
                      ', ' + kind + '); refusing to publish an action the decoder would drop');
        return null;
    }
    return roundClass().chunkPairs(pairs, maxPairs);
}

// RESERVE one token per chunk, because one chunk is one transaction and one
// fee. check() above is a PURE predicate read once for the whole batch, so on
// its own an N-chunk roll call spends N fees against a single pre-send answer
// and walks straight past the per-window ceiling by N-1. Reservation consumes
// the budget in the same synchronous turn, which is the shape spend_guard.js
// documents for an awaited send and the one AttestationBatchPublisher
// .broadcastWindow() already uses. check() STAYS: reserve() takes no balance
// argument, so dropping it would silently retire the ROLLCALL_MIN_BALANCE
// wallet floor.
function reserveChunkBudget(self, state, kind, chunkCount){
    let tokens = [];
    for(let i = 0; i < chunkCount; i++){
        let token = self.spendGuard.reserve();
        if(!token){
            // Read the reason BEFORE releasing: giving the slots back first
            // re-opens the very gate that tripped, and the line then names a
            // ceiling that was never the one in the way.
            let why = self.spendGuard.noteBlocked();
            for(let t of tokens) self.spendGuard.release(t);
            logger.warn('RollcallRound: ' + why + ' (epoch ' + state.epoch +
                         ', ' + kind + ', ' + chunkCount + ' chunk(s)); deferring publish');
            return null;
        }
        tokens.push(token);
    }
    return tokens;
}

// Re-read the operator pause before EVERY chunk. Each chunk is its own
// awaited transaction and its own fee, and the pause is an out-of-band
// runtime toggle (SpendGuard.pauseCapability from the control RPC), so a
// pause landing while chunk i-1 is in flight has to stop the chunks that
// have not gone out yet. Neither the pre-loop check() nor the reservations
// can see it: both were taken in one earlier synchronous turn. Every
// delivered chunk stays in state.sent, so the publish after a resume
// rebuilds only the undelivered tail rather than paying twice.
function pausedMidBatch(self, state, kind, chunks, tokens, i, key){
    if(!self.spendGuard.isPaused()) return false;
    for(let j = i; j < tokens.length; j++) self.spendGuard.release(tokens[j]);
    // Phase 'failed', not a new 'paused' phase: loadSpendLog decides
    // after a restart from these phases, and only 'failed' un-commits an
    // epoch whose chunks never went out. A phase the loader does not know
    // leaves the bare 'intent' standing, which would quarantine the epoch
    // permanently for a hub the operator merely paused and resumed.
    self.recordSpend({ phase: 'failed', epoch: state.epoch, kind,
                        delivered: state.sent.size, remaining: chunks.length - i,
                        error: 'operator pause: ' + self.spendGuard.noteBlocked() });
    logger.warn(self.spendGuard.noteBlocked() + ' (epoch ' + state.epoch +
                 ', ' + kind + '); ' + (chunks.length - i) + ' of ' + chunks.length +
                 ' chunk(s) not broadcast');
    self._committed.delete(key);
    return true;
}

// One chunk on the wire: charge its reservation and record what it carried.
function noteChunkSent(self, state, kind, chunk, token, res, myPubkey){
    // The reservation IS the spend; record() here would count it twice.
    self.spendGuard.commit(token);
    let txid = (res && res.txid) ? String(res.txid) : null;
    if(txid) state.txids.push(txid);
    // Mark delivery per chunk, not per batch: a later chunk's failure
    // must not un-send the ones already on the wire.
    for(let p of chunk){
        state.sent.add(p.pubkey);
        if(p.pubkey === myPubkey) state.ownSigOnWire = true;
    }
    self.recordSpend({ phase: 'sent', epoch: state.epoch, kind, txid, pairs: chunk.length,
                        rank: state.myRank });
    logger.info('RollcallRound: published epoch=' + state.epoch + ' ' + kind + ' pairs=' + chunk.length +
                (txid ? ' txid=' + txid : '') +
                (state.myRank > 0 ? ' [SWEEPER: rank ' + state.myRank + ' of ' + state.order.length +
                                    '; the elected leader left these signatures off chain]' : ''));
}

// A chunk that threw: 'held' when the send may have landed, 'retry' when it
// definitively did not.
function settleChunkFailure(self, state, kind, chunks, tokens, i, key, e){
    if(isAmbiguousSendError(e)){
        // The send may have been accepted, so this chunk's reservation is
        // a real spend and only the untried chunks give their budget back.
        self.spendGuard.commit(tokens[i]);
        for(let j = i + 1; j < tokens.length; j++) self.spendGuard.release(tokens[j]);
        // Keep the epoch committed and say so on disk, so an operator
        // reconciling on chain has the epoch without stdout retention.
        self.recordSpend({ phase: 'ambiguous', epoch: state.epoch, kind,
                            error: e && e.message ? String(e.message).slice(0, 200) : String(e) });
        logger.warn(nodeUtil.format('RollcallRound: AMBIGUOUS publish send (epoch ' + state.epoch + ', ' + kind +
                     '); NOT re-broadcasting to avoid a double spend:', e && e.message ? e.message : e));
        return 'held';
    }
    // Definitive: nothing left this chunk, so it consumes no budget, and
    // neither do the chunks after it. Keeping them reserved would make a
    // failed send cost the window an allowance it never spent.
    for(let j = i; j < tokens.length; j++) self.spendGuard.release(tokens[j]);
    self.recordSpend({ phase: 'failed', epoch: state.epoch, kind, delivered: state.sent.size,
                        error: e && e.message ? String(e.message).slice(0, 200) : String(e) });
    logger.warn(nodeUtil.format('RollcallRound: publish failed (epoch ' + state.epoch + ', ' + kind + '):',
                 e && e.message ? e.message : e));
    self._committed.delete(key);
    return 'retry';
}

module.exports = {

    // ── publish ──────────────────────────────────────────────────────────────

    async advance(state, tipBlock){
        let since = tipBlock - state.epoch;
        if(since > this.acceptWindow) return;       // nothing can land any more
        let myPubkey = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        if(!myPubkey) return;

        if(state.order === null){
            let order = await this._electionOrder(state.epoch);
            if(order === null) return;              // unresolved: abstain, retry next tick
            state.order  = order;
            state.leader = order.length > 0 ? order[0] : null;
            state.myRank = order.indexOf(myPubkey);
        }

        await this.maybePublish(state, myPubkey, since);
        await this.maybeSelfPublish(state, myPubkey, since);
    },

    async maybePublish(state, myPubkey, since){
        if(state.published) return;
        if(since < this.publishDelayBlocks) return;
        if(!this._rankUnlocked(state.order, myPubkey, since)) return;
        if(state.sigs.size === 0) return;
        if(!this.requireBroadcast()) return;

        let onChain = await this.onChainSigners(state);
        // Both branches below also exclude state.sent. Already on the wire from this
        // hub's own earlier chunks is the same answer as already on chain: the DOGE
        // read lags indexing by longer than a tick, so without it the retry after a
        // partial failure re-broadcasts, and re-pays for, every chunk that went out.
        let pairs;
        if(onChain === null){
            // The DOGE read is undecidable. The LEADER publishes anyway: its job
            // is to publish every epoch and at worst it pays a duplicate fee that
            // the union rule absorbs. A SWEEPER exists only to fill gaps, and one
            // that cannot see the gaps has nothing to add, so it defers to a later
            // tick rather than paying to re-publish what the leader already landed.
            if(state.myRank !== 0) return;
            pairs = Array.from(state.sigs, ([pubkey, sig]) => ({ pubkey, sig }))
                        .filter(p => !state.sent.has(p.pubkey));
        } else {
            pairs = Array.from(state.sigs, ([pubkey, sig]) => ({ pubkey, sig }))
                        .filter(p => !onChain.has(p.pubkey) && !state.sent.has(p.pubkey));
        }
        if(pairs.length === 0) return;

        state.published = true;   // one sweep publish per epoch per hub; see below
        let ok = await this.publishPairs(state, myPubkey, pairs, 'sweep');
        // A definitive failure releases the slot so a later tick can retry inside
        // the window, and the retry now rebuilds only the pairs that were never
        // broadcast. An ambiguous send does NOT release: the DOGE node may have
        // accepted the transaction, and re-broadcasting would burn the fee twice
        // for a roll call that is already landing.
        if(ok === 'retry') state.published = false;
    },

    async maybeSelfPublish(state, myPubkey, since){
        if(state.selfPublished) return;
        if(since < this.selfPublishBlocks) return;
        let mySig = state.sigs.get(myPubkey);
        if(!mySig) return;                       // nothing of ours to rescue
        if(state.ownSigOnWire) return;           // our own publish already carried it
        if(!this.requireBroadcast()) return;

        let onChain = await this.onChainSigners(state);
        // Unresolved read: publish. This is the censorship escape hatch, and the
        // thing it escapes is precisely a federation whose answers cannot be
        // trusted; one extra transaction is cheaper than an eviction.
        if(onChain && onChain.has(myPubkey)) return;

        state.selfPublished = true;
        let ok = await this.publishPairs(state, myPubkey, [{ pubkey: myPubkey, sig: mySig }], 'self');
        if(ok === 'retry') state.selfPublished = false;
        if(ok === 'sent') state.ownSigOnWire = true;
    },

    // Broadcast one or more ROLLCALL actions carrying `pairs`. Returns 'sent',
    // 'retry' (a definitive failure; the caller may release its slot, and every
    // chunk that DID go out is recorded in state.sent so the retry rebuilds only
    // the undelivered tail) or 'held' (ambiguous; the slot stays claimed).
    async publishPairs(state, myPubkey, pairs, kind){
        let key = kind === 'self' ? (state.epoch + ':self') : String(state.epoch);
        if(this._committed.has(key)){
            logger.warn('RollcallRound: epoch ' + state.epoch + ' (' + kind + ') already carries a committed ' +
                         'publish spend in ' + this.spendLogPath + '; NOT re-broadcasting after restart');
            return 'held';
        }

        // Balance floor plus the runtime pause and the per-window spend ceiling,
        // checked BEFORE anything is built. A blocked publish is a deferral, not
        // a failure: an inert federation publishes nothing and every epoch closes
        // unrolled, which evicts nobody.
        // A balance source that THROWS reports null, not undefined: undefined means
        // "this hub wired no balance source and the floor is inert", while an
        // unreadable wallet must fail closed rather than look unconfigured.
        let balance;
        let signer = this.resolveSigner();
        if(signer.getBalanceFn){
            try { balance = await signer.getBalanceFn(); } catch(_){ balance = null; }
            if(balance === undefined) balance = null;
        }
        let g = this.spendGuard.check(balance === undefined ? {} : { balance });
        if(!g.ok){
            logger.warn('RollcallRound: ' + g.reason + ' (epoch ' + state.epoch + ', ' + kind + '); deferring publish');
            return 'retry';
        }

        let chunks = planChunks(this, state, pairs, kind);
        if(!chunks) return 'retry';

        let tokens = reserveChunkBudget(this, state, kind, chunks.length);
        if(!tokens) return 'retry';

        // Durable intent BEFORE the money moves and AFTER the reservation, and the
        // broadcast is GATED on it: an unwritable audit path must not let a real DOGE
        // fee be spent with no recoverable trace, and a batch the ceiling declined
        // must leave no orphan intent line behind.
        if(!this.recordSpend({ phase: 'intent', epoch: state.epoch, kind, pairs: pairs.length, chunks: chunks.length })){
            for(let t of tokens) this.spendGuard.release(t);
            logger.error('RollcallRound: spend-audit path unwritable at ' + this.spendLogPath +
                          '; deferring the publish for epoch ' + state.epoch +
                          ' rather than spending a DOGE fee with no durable record');
            return 'retry';
        }
        this._committed.add(key);

        let result = 'sent';
        for(let i = 0; i < chunks.length; i++){
            if(pausedMidBatch(this, state, kind, chunks, tokens, i, key)) return 'retry';
            let chunk = chunks[i];
            let wire = this.buildWire(state.epoch, state.ledgerHash, myPubkey, chunk, state.gates);
            try {
                let res = await this.broadcast(wire);
                noteChunkSent(this, state, kind, chunk, tokens[i], res, myPubkey);
            } catch(e){
                return settleChunkFailure(this, state, kind, chunks, tokens, i, key, e);
            }
        }
        return result;
    },

    // Which of the signatures this hub holds are already on chain for the epoch.
    // Returns a Set of pubkeys, or null when the answer cannot be trusted.
    //
    // `max_block_time` is a WINDOW CUT the DOGE indexer applies to its own blocks.
    // The chain's cut is the BTC header stamp at E + ACCEPT_WINDOW, which does not
    // exist yet while we are still publishing, so this read uses a generous
    // wall-clock bound instead: any DOGE block it admits is one that landed before
    // the real cut, because we only publish while the tip is inside the window.
    // The answer is therefore a subset of what will count, never a superset, so it
    // can cost a duplicate fee and can never cost a missing signature.
    async onChainSigners(state){
        let keys = Array.from(state.sigs.keys());
        if(keys.length === 0) return new Set();
        let res;
        try {
            res = await this.dogeIndexerCall('getrollcallsigners', {
                network:        this.network,
                epoch_height:   state.epoch,
                // Two hours of slack over wall clock: a DOGE miner may stamp a
                // block that far ahead, and excluding such a block would only
                // under-report what is already landed.
                max_block_time: Math.floor(Date.now() / 1000) + 7200,
                pubkeys:        keys,
                publishers:     []
            });
        } catch(e){
            return null;
        }
        if(!res || typeof res !== 'object' || !res.signers || typeof res.signers !== 'object') return null;
        // A null hcut means no DOGE block is inside the window yet, so the empty
        // maps are a shape and not a positive "none".
        if(res.hcut === null || res.hcut === undefined) return null;
        let out = new Set();
        for(let pk of Object.keys(res.signers)){
            let row = res.signers[pk];
            if(!row) continue;
            // A row carried under a different ledger_hash is one the BTC close
            // will discard, so it is not presence and must not suppress a real
            // publish of the same key.
            if(String(row.ledger_hash || '').toLowerCase() !== state.ledgerHash) continue;
            out.add(String(pk).toLowerCase());
        }
        state.onChainCount = out.size;
        return out;
    }
};
