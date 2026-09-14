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
 * XChain Hub - Attestation cross-chain relay: finalized legs on the wire
 *
 * Takes a finalized round to its destination chain: rank-ordered failover, the spend
 * reservation and WAL intent around each send, and the per-chain broadcast rails.
 * Installed on AttestationRelay.prototype by src/attestation/relay.js.
 *
 ********************************************************************/

'use strict';

const crypto   = require('crypto');
const nodeUtil = require('node:util');
const { isAmbiguousSendError } = require('../../lib/idempotent_broadcast.js');
const { HOME_CHAIN } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- broadcast -----

    // The two legs' local state, selected by phase. Everything downstream of a
    // finalized round (retention, failover, WAL, spend guard) is one implementation
    // parameterised on this, so the legs cannot drift apart in the money path.
    legState(phase){
        return (phase === 'response')
            ? { wire: this._finalizedResponse, published: this._publishedResponses }
            : { wire: this._finalizedWire,     published: this._published };
    },

    async onRoundFinalized(ev){
        let row  = ev.row;
        let sigs = ev.signatures || [];
        this._inflight.delete(String(row.round_id));
        let phase = String(row.phase);
        if(phase !== 'request' && phase !== 'response') return;

        let rid = String(row.request_id).toLowerCase();
        if(sigs.length === 0){
            logger.warn('AttestationRelay: finalized ' + rid.substring(0, 16) + '... with no signatures; nothing to broadcast');
            return;
        }

        let fault = this._wireFault(row, sigs.length);
        if(fault){
            logger.error('AttestationRelay: dropping finalized ' + rid.substring(0, 16) + '... : ' + fault);
            return;
        }

        let response = (phase === 'response');
        // The request leg lands on BTC; the response leg lands back on the chain the
        // request came from.
        let coin = response ? String(row.origin_chain) : HOME_CHAIN;
        let wire = response ? this._buildResponseWire(row, sigs) : this._buildRequestWire(row, sigs);
        let rank = this._myRank(rid, ev);
        this.legState(phase).wire.set(rid, {
            rid: rid, wire: wire, coin: coin, phase: phase, finalizedAt: Date.now(), rank: rank
        });

        logger.info('AttestationRelay: finalized ' + phase + ' ' + rid.substring(0, 16) + '... ' +
                    (response
                        ? HOME_CHAIN + ':' + row.home_response_action_index + ' -> ' + coin + ' (' + row.status + ')'
                        : row.origin_chain + ':' + row.origin_action_index + ' -> ' + HOME_CHAIN) +
                    ' (' + sigs.length + ' sigs, snapshot ' + row.snapshot_block + ', rank ' + rank + ')');

        // Rank 0 is the round's broadcaster; every other rank waits out its failover
        // window in sweepFinalized so a silent leader costs one window, not the
        // request's whole deadline.
        if(rank === 0) await this.broadcast(phase, rid);
    },

    // This node's position in the hash-ordered signer set for the request. The same
    // sort rule the responsible-set derivations use, so every node computes the same
    // ordering and the step-ins are staggered rather than simultaneous.
    _myRank(rid, ev){
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if(!myPubkey) return -1;
        let sigs = (ev && ev.signatures) ? ev.signatures : [];
        let ordered = sigs
            .map(s => String(s.pubkey).toLowerCase())
            .map(pk => ({ pubkey: pk, hash: crypto.createHash('sha256').update(rid, 'utf8').update(pk, 'utf8').digest('hex') }))
            .sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        let idx = ordered.findIndex(v => v.pubkey === myPubkey);
        return idx;   // -1 when we did not sign, which sweepFinalized treats as never eligible
    },

    async sweepFinalized(){
        for(let phase of ['request', 'response']){
            let state = this.legState(phase);
            for(let [rid, entry] of state.wire){
                if(state.published.has(rid) || this.legLanded(phase, rid, entry)){
                    state.wire.delete(rid);
                    continue;
                }
                if(entry.rank < 0) continue;
                if(entry.rank === 0) continue;   // already attempted at finalization
                if(Date.now() - entry.finalizedAt < entry.rank * this.failoverWindowMs) continue;
                logger.warn('AttestationRelay: leader silent for the ' + phase + ' leg of ' +
                             rid.substring(0, 16) + '...; rank ' + entry.rank + ' stepping in');
                await this.broadcast(phase, rid);
            }
        }
    },

    // Has the destination chain accepted this leg, however it got there (our own
    // broadcast, a peer's, or a retry)? For the request leg the v3 shows up in BTC's
    // pending queue; for the response leg the v4 flips the origin request OUT of the
    // origin's pending queue. A pending view we failed to refresh is null and answers
    // "unknown", which retains the round rather than retiring it.
    legLanded(phase, rid, entry){
        if(phase === 'request') return this.homeHasRequest(rid);
        let pending = this._originPending[String(entry && entry.coin)];
        return Boolean(pending) && !pending.has(rid);
    },

    // Does the home chain already hold this request, at ANY lifecycle status? See the
    // note on _homeRelayed for why the pending queue alone is not that answer.
    homeHasRequest(rid){
        return this._homePending.has(rid) || this._homeRelayed.has(rid);
    },

    // Everything one send needs, taken in the order it was taken inline: the finalized
    // entry, the rail for its destination chain, the spend reservation and the durable
    // intent. Returns null when the leg cannot go out now, having handed back whatever
    // it took, and nothing here awaits, so no other driver can interleave between the
    // reservation and the WAL record it is paired with.
    prepareLegSend(phase, rid, state){
        let entry = state.wire.get(rid);
        if(!entry) return null;
        if(state.published.has(rid)) return null;

        let broadcaster = this.getBroadcaster(entry.coin);
        if(!broadcaster){
            logger.warn('AttestationRelay: no ' + entry.coin + ' broadcast rail configured for the ' + phase +
                         ' leg of ' + rid.substring(0, 16) + '...; retained for a later sweep');
            return null;
        }
        // RESERVE rather than allow(): the send in broadcast() is AWAITED and broadcast() has
        // two concurrent drivers, the rank-0 broadcast inside the unawaited
        // 'match:finalized' handler and the _poll sweep, with nothing serializing them.
        // src/lib/spend_guard.js forbids the pure allow()/record() pair around an
        // awaited send precisely for that shape: every in-flight caller reads the same
        // pre-send budget and they all spend past the ATTEST_RELAY count and USD
        // ceilings by the concurrency width. reserve() consumes the budget in this
        // synchronous turn, so the ceiling holds by construction; the reservation IS
        // the recorded spend, so record() must never be called on this path.
        let spendToken = this.spendGuard.reserve();
        if(!spendToken){
            logger.warn(this.spendGuard.noteBlocked() + ' (' + rid.substring(0, 16) + '...); retained for a later window');
            return null;
        }

        // The intent record goes down BEFORE the send so a crash mid-flight is
        // recoverable as ambiguous rather than invisible. See loadWal.
        if(!this.appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'intent' })){
            // Nothing goes on the wire without a durable record, so the leg stays
            // retryable and the reserved budget goes back.
            this.spendGuard.release(spendToken);
            logger.error('AttestationRelay: durable WAL write FAILED for ' + rid.substring(0, 16) +
                          '...; skipping broadcast (no on-chain spend without a durable record)');
            return null;
        }

        return { entry: entry, broadcaster: broadcaster, spendToken: spendToken };
    },

    async broadcast(phase, rid){
        let state = this.legState(phase);
        let send  = this.prepareLegSend(phase, rid, state);
        if(!send) return;

        let version = (phase === 'response') ? 'v4' : 'v3';
        try {
            let result = await send.broadcaster(send.entry.wire);
            this.noteLegSent(phase, rid, state, send, result, version);
        } catch(e){
            this.noteLegSendFailed(phase, rid, state, send, e, version);
        }
    },

    // A send that returned, settled in the order it settled inline.
    noteLegSent(phase, rid, state, send, result, version){
        this._broadcastSucceeded++;
        this.spendGuard.commit(send.spendToken);   // the reservation IS the fee charged to the window
        state.published.mark(rid);
        state.wire.delete(rid);
        this.appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'sent', txid: (result && result.txid) || null });
        logger.info('AttestationRelay: broadcast ATTEST ' + version + ' on ' + send.entry.coin + ' for ' +
                    rid.substring(0, 16) + '... txid=' + ((result && result.txid) ? result.txid : '?'));
    },

    noteLegSendFailed(phase, rid, state, send, e, version){
        this._broadcastFailed++;
        // An ambiguous failure may still have reached the node. Record it as sent so
        // no rank re-spends on a tx that might already be on the wire; the pending
        // refresh confirms it, or the request expires on its deadline.
        //
        // A PRE-SEND failure is never ambiguous: nothing left this process, so it
        // must stay retryable. The shared classifier cannot tell the difference (it
        // defaults an unrecognised error to ambiguous, which is the right default
        // for an opaque operator hook), so defaultBroadcast tags the steps it
        // knows ran before the send. Without this a transient "no UTXOs available"
        // would suppress the request permanently.
        if(!e._relayPreSend && isAmbiguousSendError(e)){
            // COMMIT, not release: this branch already treats the tx as possibly on
            // the wire, marks the leg published and never retries it, so the fee may
            // have been paid. Keeping the reservation charges the window for it,
            // which fails closed; releasing would hand budget back for a spend
            // nothing will re-attempt.
            this.spendGuard.commit(send.spendToken);
            state.published.mark(rid);
            this.appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'sent', txid: null, ambiguous: true });
            logger.error(nodeUtil.format('AttestationRelay: AMBIGUOUS ' + version + ' broadcast failure for ' + rid.substring(0, 16) +
                          '... (the tx may have reached the ' + send.entry.coin + ' node); not retrying: ', e));
        } else {
            // A pre-send or clean failure left nothing on the wire and the leg stays
            // retryable, so the reserved budget goes back.
            this.spendGuard.release(send.spendToken);
            this.appendWal({ ts: Date.now(), rid: rid, leg: phase, phase: 'failed' });
            logger.error(nodeUtil.format('AttestationRelay: ' + version + ' broadcast failed for ' + rid.substring(0, 16) + '...: ', e));
        }
    },

    // Resolve the rail for the chain this leg lands on. The home rail keeps the
    // operator's shared hooks; an origin rail is only ever the explicitly configured
    // one (see chainRails), so a v4 can never be handed to a hook that would put it
    // on BTC.
    getBroadcaster(coin){
        if(String(coin) === HOME_CHAIN || coin == null){
            if(this.broadcastFn) return (payload) => this.broadcastFn(payload);
            if(this.encoder && this.walletSignFn && this.btcAddress && this.btcPubkeyHex)
                return (payload) => this.defaultBroadcast(payload, this.encoder, this.btcAddress, this.walletSignFn, HOME_CHAIN);
            return null;
        }
        let rail = this.chainRails[String(coin)];
        if(!rail) return null;
        if(rail.broadcastFn) return (payload) => rail.broadcastFn(payload);
        let signFn = rail.walletSignFn || this.walletSignFn;
        if(rail.encoder && signFn && rail.address)
            return (payload) => this.defaultBroadcast(payload, rail.encoder, rail.address, signFn, String(coin));
        return null;
    }

};
