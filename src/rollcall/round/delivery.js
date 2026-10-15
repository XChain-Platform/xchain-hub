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
 * XChain Hub - ROLLCALL round: delivery memory and publish retry
 *
 * What this hub has already put on the wire for an epoch, what the chain has
 * shown landing, and when a reorg takes a landed publish back off it; plus the
 * backoff and attempt bound on a publish the pipeline keeps refusing. The spend
 * log is the durable half (records.js loadSpendLog rebuilds it), so a restart
 * inside the accept window neither pays again for signatures already sent nor
 * forgets the tail it never sent.
 *
 * src/rollcall/round.js installs every method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');
const logger = getLogger();

// Policy, not consensus: no chain rule reads these. Counted in ticks (one per
// ROLLCALL_POLL_MS): after its nth definitive publish failure an epoch waits 2^(n-1)
// ticks, at most RETRY_CAP_TICKS, so the first retry is the next tick as before and a
// pipeline that keeps refusing is asked less and less often. The sweep role gives up
// after MAX_SWEEP_ATTEMPTS failures. The self-publish role has no attempt bound,
// because it is the censorship escape hatch and giving it up trades a refused call
// for an eviction; the accept window bounds it instead.
const RETRY_CAP_TICKS    = 20;
const MAX_SWEEP_ATTEMPTS = 8;

// How many DOGE blocks a signature this hub published must stay absent from a trusted
// chain read before it is paid for again, measured on getrollcallsigners'
// tip_block_index from the first read that missed it. A reorg returns its transactions
// to the mempool, and the original is normally re-mined within a block or two; paying
// before then lands both. Mainnet and testnet DOGE run one-minute blocks and reorg one
// or two deep, so 10 blocks (about 10 minutes) is several times the deepest common
// reorg plus indexer lag, and small beside the 144-BTC-block accept window and the
// E+100 self-publish deadline. The regtest miner closes a block every 5 to 30 s and
// rail reorgs are one or two deep, while the window leaves the self-publish only the
// 3 BTC blocks between E+9 and E+12, so regtest waits 3 blocks (15 to 90 s). With no
// tip in the answer nothing is paid again, because the wait cannot be measured.
//
// The tip is only trusted upward. A signature seen landed at tip T, or sent while the
// indexer stood at T, is in a block at or below T, so an indexer that reports a lower
// tip (a resync, a restored database, a lagging replica) cannot see it yet: such a
// read neither starts nor advances the wait, and nothing is paid until the reported
// tip reaches that floor plus the wait. The floors are kept on the spend log
// ('landed', 'missing' and 'sent' lines carry the tip) so a restart keeps them.
const ABSENT_DOGE_BLOCKS = Object.freeze({ mainnet: 10, testnet: 10, regtest: 3 });

module.exports = {

    // The delivery memory a fresh engine starts with, per <epoch>:<ledger_hash>: the
    // pubkeys on the wire and seen landed, the tip floors, each role's first missed
    // read, the epochs whose own rescue is spent; and per epoch the publish retries.
    initDeliveryMemory(){
        this._delivered    = new Map();
        this._seenOnChain  = new Map();
        this._seenTip      = new Map();
        this._sentTip      = new Map();
        this._missingNoted = new Set();
        this._absentSince  = new Map();
        this._rescued      = new Set();
        this._publishRetry = new Map();
        this._publishTick  = 0;
    },

    // Hand the rebuilt round what the spend log says this hub already sent for it, so
    // the sweep excludes those signatures and the self-publish knows whether its own
    // signature already rode one of this hub's broadcasts.
    restoreDelivered(state, myPubkey){
        let delivered = this._delivered.get(state.epoch + ':' + (state.ledgerHash || ''));
        if(!delivered) return;
        for(let pk of delivered) state.sent.add(pk);
        if(myPubkey && delivered.has(myPubkey)) state.ownSigOnWire = true;
    },

    // Signatures that went out (or may have) in one chunk, in the durable memory. A
    // send restarts the absence clock of the role it was made for, and of the own
    // signature when it carried that: the new transaction gets its own full wait
    // before anything pays for them again.
    rememberDelivered(state, pubkeys, kind){
        let set = this.memoryFor(this._delivered, state.epoch, state.ledgerHash);
        for(let pk of pubkeys) set.add(pk);
        let base = state.epoch + ':' + (state.ledgerHash || '') + ':';
        if(kind !== 'self') this._absentSince.delete(base + 'sweep');
        if(pubkeys.includes(this.ownPubkey())){
            this._absentSince.delete(base + 'own');
            this.raiseTipFloor(this._sentTip, state, state.dogeTip);
        }
    },

    // Keep the highest tip seen for this epoch's signatures in `map`; false when the
    // tip is not a number or not higher than what is kept.
    raiseTipFloor(map, state, tip){
        let key = state.epoch + ':' + (state.ledgerHash || '');
        if(!Number.isFinite(tip)) return false;
        if(map.has(key) && map.get(key) >= tip) return false;
        map.set(key, tip);
        return true;
    },

    tipFloor(state, role){
        let key = state.epoch + ':' + (state.ledgerHash || '');
        let seen = this._seenTip.get(key);
        let floors = [seen];
        if(role === 'own') floors.push(this._sentTip.get(key));
        floors = floors.filter(Number.isFinite);
        return floors.length ? Math.max(...floors) : null;
    },

    // A reorg that takes this hub's landed publish off chain leaves nothing to
    // republish it: the sweep slot is spent, the epoch is committed, and the chain read
    // that drives the sweep excludes what this hub already sent. A signature this hub
    // sent that a trusted read once showed on chain and no longer shows, for the wait
    // above the floor, has been reorged out, so it is forgotten as sent, the slot and
    // the commitment are released, and the next publish carries it again. Never seen on
    // chain is not evidence: a publish still in a mempool reads the same way, and paying
    // for it twice is what the commitment exists to stop. The same read starts the own
    // signature's absence clock, so a late self-publish rescue has its wait behind it.
    // Returns the chain read it made (a Set, or null when untrusted) for the caller to
    // reuse, or undefined when it made none.
    async checkReorgedPublish(state, myPubkey){
        if(state.sent.size === 0) return undefined;
        let onChain = await this.onChainSigners(state);
        if(onChain === null) return null;
        let gone = this.noteLandedSignatures(state, onChain);
        this.observeAbsence(state, 'sweep', gone.length > 0);
        if(myPubkey && (state.ownSigOnWire || state.sent.has(myPubkey)))
            this.observeAbsence(state, 'own', !onChain.has(myPubkey));
        if(!this.absenceElapsed(state, 'sweep')) return onChain;
        this.releaseReorged(state, myPubkey, gone);
        return onChain;
    },

    // Record what the read shows landed and the highest tip it was seen at; returns the
    // signatures seen landed before that this read no longer shows.
    noteLandedSignatures(state, onChain){
        let seen = this.memoryFor(this._seenOnChain, state.epoch, state.ledgerHash);
        let present = Array.from(state.sent).filter(pk => onChain.has(pk));
        let fresh = present.filter(pk => !seen.has(pk));
        let raised = present.length > 0 && this.raiseTipFloor(this._seenTip, state, state.dogeTip);
        if(fresh.length > 0){
            for(let pk of fresh) seen.add(pk);
            this.recordSpend({ phase: 'landed', epoch: state.epoch, kind: 'sweep', tip: state.dogeTip,
                               ledger_hash: state.ledgerHash, pubkeys: fresh });
        }
        let gone = Array.from(seen).filter(pk => !onChain.has(pk));
        let key = state.epoch + ':' + (state.ledgerHash || '');
        // The highest tip they were seen at is written once, as they go missing, so a
        // restart keeps the floor without a line per tick while they stay landed.
        if(gone.length > 0 && (raised || !this._missingNoted.has(key))){
            this._missingNoted.add(key);
            this.recordSpend({ phase: 'missing', epoch: state.epoch, kind: 'sweep',
                               tip: this._seenTip.get(key), ledger_hash: state.ledgerHash });
        } else if(gone.length === 0) this._missingNoted.delete(key);
        return gone;
    },

    // Forget the reorged signatures as sent and release the sweep (and, when the own
    // signature was among them, the self-publish) so the next tick publishes them.
    releaseReorged(state, myPubkey, gone){
        let seen = this.memoryFor(this._seenOnChain, state.epoch, state.ledgerHash);
        let delivered = this.memoryFor(this._delivered, state.epoch, state.ledgerHash);
        for(let pk of gone){ seen.delete(pk); state.sent.delete(pk); delivered.delete(pk); }
        state.published = false;
        this._committed.delete(String(state.epoch));
        this.recordSpend({ phase: 'reorged', epoch: state.epoch, kind: 'sweep',
                           ledger_hash: state.ledgerHash, pubkeys: gone });
        if(myPubkey && gone.includes(myPubkey)){
            state.ownSigOnWire = false;
            state.selfPublished = false;
            this._committed.delete(state.epoch + ':self');
            this.recordSpend({ phase: 'reorged', epoch: state.epoch, kind: 'self',
                               ledger_hash: state.ledgerHash, pubkeys: [myPubkey] });
        }
        logger.warn('RollcallRound: ' + gone.length + ' signature(s) this hub published for epoch ' +
                     state.epoch + ' were on chain and a reorg removed them; publishing them again');
    },

    // Start the absence clock for a role at the first read that misses its signature,
    // or stop it when the signature is back. A read whose tip is below the role's floor
    // (an indexer behind where the signature was seen or sent) starts nothing.
    observeAbsence(state, role, missing){
        let key = state.epoch + ':' + (state.ledgerHash || '') + ':' + role;
        if(!missing){ this._absentSince.delete(key); return; }
        let tip = state.dogeTip;
        if(!Number.isFinite(tip)) return;
        let floor = this.tipFloor(state, role);
        if(floor !== null && tip < floor) return;
        if(!this._absentSince.has(key)) this._absentSince.set(key, tip);
    },

    // Whether a role's signature has been missing for this network's
    // ABSENT_DOGE_BLOCKS: counted from where its clock started, and with the reported
    // tip at least that far above the role's floor, so a lower tip never counts.
    absenceElapsed(state, role){
        let key = state.epoch + ':' + (state.ledgerHash || '') + ':' + role;
        let tip = state.dogeTip;
        if(!this._absentSince.has(key) || !Number.isFinite(tip)) return false;
        let need = ABSENT_DOGE_BLOCKS[this.network];
        if(!Number.isFinite(need)) need = ABSENT_DOGE_BLOCKS.mainnet;
        let floor = this.tipFloor(state, role);
        if(floor !== null && tip < floor + need) return false;
        if(tip - this._absentSince.get(key) < need) return false;
        this._absentSince.delete(key);
        return true;
    },

    // The self-publish's rescue, late in the window, of an own signature that the
    // delivery memory says already went out: whatever the memory says, a signature a
    // trusted read has missed for ABSENT_DOGE_BLOCKS above its floor is published by
    // this hub once more (once per epoch, recorded as 'rescue' so a restart does not
    // hold it). An own signature the chain once showed landed is the sweep's reorg
    // republish to make (checkReorgedPublish), which carries it with the rest; rescuing
    // it here as well would pay for it twice.
    //
    // Firing the rescue takes the own signature off the wire the way releaseReorged
    // does: out of the delivery memory and the round's sent set, and the 'rescue' line
    // does the same on a restart (records.js loadSpendLog). The rescue is not a send of
    // its own, only the release of the self-publish: a send the pipeline refuses leaves
    // the signature off the wire, so the ordinary self-publish retries it under the
    // publish backoff until one is accepted, and the accepted send puts it back.
    async ownSignatureLost(state, myPubkey){
        let key = state.epoch + ':' + (state.ledgerHash || '');
        if(this._rescued.has(key)) return false;
        if(this.memoryFor(this._seenOnChain, state.epoch, state.ledgerHash).has(myPubkey)) return false;
        let onChain = await this.onChainSigners(state);
        if(onChain === null) return false;
        this.observeAbsence(state, 'own', !onChain.has(myPubkey));
        if(!this.absenceElapsed(state, 'own')) return false;
        this._rescued.add(key);
        this.memoryFor(this._delivered, state.epoch, state.ledgerHash).delete(myPubkey);
        state.sent.delete(myPubkey);
        state.ownSigOnWire = false;
        state.selfPublished = false;
        this._committed.delete(state.epoch + ':self');
        this.recordSpend({ phase: 'rescue', epoch: state.epoch, kind: 'self',
                           ledger_hash: state.ledgerHash, pubkeys: [myPubkey] });
        logger.warn('RollcallRound: this hub\'s own signature for epoch ' + state.epoch + ' has been off ' +
                     'chain for ' + ABSENT_DOGE_BLOCKS[this.network] + ' DOGE blocks although one of its ' +
                     'publishes carried it; self-publishing it once more');
        return true;
    },

    // Whether a publish for this epoch may run now: null to proceed, 'wait' while a
    // backoff runs, 'abandon' once the sweep role has used its attempts.
    publishRetryGate(state, kind){
        let r = this._publishRetry.get(state.epoch);
        if(!r) return null;
        if(kind !== 'self' && r.failures >= MAX_SWEEP_ATTEMPTS){
            if(!r.abandoned){
                r.abandoned = true;
                this.recordSpend({ phase: 'abandoned', epoch: state.epoch, kind, failures: r.failures });
                logger.error('RollcallRound: the sweep publish for epoch ' + state.epoch + ' was refused ' +
                              r.failures + ' times before anything was sent; this hub stops sweeping the ' +
                              'epoch (its own self-publish still runs). Nothing was spent.');
            }
            return 'abandon';
        }
        return this._publishTick < r.notBeforeTick ? 'wait' : null;
    },

    // A definitive failure (nothing left this process) pushes the epoch's next attempt
    // back. One clock per epoch: the sweep and the self-publish share the pipeline
    // that refused, so the role that did not fail would only be refused in turn.
    notePublishFailure(state){
        let r = this._publishRetry.get(state.epoch) || { failures: 0, notBeforeTick: 0, abandoned: false };
        r.failures++;
        r.notBeforeTick = this._publishTick + Math.min(Math.pow(2, r.failures - 1), RETRY_CAP_TICKS);
        this._publishRetry.set(state.epoch, r);
    }
};
