/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * State checkpoint engine - the leader cadence
 *
 * The poll tick that decides whether this hub leads a checkpoint round, and the
 * stall meters that say why it did not.
 *
 ********************************************************************/

'use strict';

const { noteCheckpointStalled } = require('../../consensus/diagnostics');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // An observer hub (signing key outside the chain-effective signer set) can never
    // get a checkpoint co-signed, so it neither opens a round nor meters the cadence:
    // nothing here is fixable at this hub, and a stall record every two blocks buried
    // the records that are. PeerManager announces the state once per set change.
    // Reads the gate defensively: a peer manager that predates it, or none at all,
    // leaves the old behaviour in place.
    observerHold(){
        let pm = this.peerManager;
        let held = !!(pm && typeof pm.authoringHeld === 'function' && pm.authoringHeld());
        this._observerIdle = held;
        return held;
    },

    // Record a due-but-not-my-slot tick at `btcBlock`. Returns true when the same
    // block has now been seen for at least K consecutive such ticks (frozen tip).
    // resolveSnapshotBlock already hands tick an integer, so the Number() here guards a
    // direct caller rather than converting a live value: compared strictly, a string and
    // a number for one height would restart the counter every tick and leave the meter
    // permanently at 1, which is precisely the silent failure it exists to catch.
    noteNotMySlot(btcBlock){
        let block = Number(btcBlock);
        if(this._notMySlotBlock === block){
            this._notMySlotTicks++;
        } else {
            this._notMySlotBlock = block;
            this._notMySlotTicks = 1;
        }
        return this._notMySlotTicks >= this._frozenTipTicks;
    },

    clearNotMySlot(){
        this._notMySlotBlock = null;
        this._notMySlotTicks = 0;
    },

    // Record (and throttle-log) a cadence round this hub could not lead. `block` is
    // the BTC snapshot block the round would have used, or null when we could not
    // even resolve one.
    noteCadenceStall(block, reason){
        this._cadenceStalls++;
        this._cadenceStallReason = reason;
        this._cadenceStallBlock  = (block == null ? null : Number(block));

        // The structured record is NOT throttled with the prose line below it.
        // The throttle exists so a persistent stall does not flood an operator's
        // tail; a collector counting stalled ticks needs every one, and dropping
        // 59 of every 60 is how a worsening cadence reads as a steady one.
        // Name the round's chain LIST, not one chain: a cadence round spans every
        // chain in `this.chains`, so no single chain can own the stall.
        // Records emitted before this carry `chain=BTC seq=<block>` from a `this.coin`
        // this class never assigns; read those as an undetermined chain and a block.
        noteCheckpointStalled({ chains: this.chains, block: this._cadenceStallBlock, reason, stalls: this._cadenceStalls });

        let now = Date.now();
        if(now - this._cadenceStallLoggedAt < this._cadenceStallLogMs) return;
        this._cadenceStallLoggedAt = now;
        logger.warn('StateCheckpointEngine: checkpoint cadence STALLED at BTC block ' +
                     (block == null ? 'unknown' : block) + ': ' + reason +
                     ' (no checkpoint will be produced until this is fixed; ' +
                     this._cadenceStalls + ' stalled tick(s) so far)');
    },

    // A round we led (or a cadence that simply is not due yet) clears the stall, so
    // getcheckpointstats reports a live reason rather than a stale one.
    clearCadenceStall(){
        this._cadenceStallReason   = null;
        this._cadenceStallBlock    = null;
        this._cadenceStallLoggedAt = 0;
    },

    // Count a per-chain round this hub led that threw before proposing, and keep its reason
    // until that chain's next round returns. Runs at most once per chain per cadence or retry.
    noteRoundFailure(chain, btcBlock, err){
        let reason = String((err && err.message) || err).slice(0, 300);
        if(!this._roundFailuresByChain)    this._roundFailuresByChain    = {};
        if(!this._lastRoundFailureByChain) this._lastRoundFailureByChain = {};
        this._roundFailures = (this._roundFailures || 0) + 1;
        this._roundFailuresByChain[chain] = (this._roundFailuresByChain[chain] || 0) + 1;
        this._lastRoundFailureByChain[chain] = { reason: reason, block: (btcBlock == null ? null : Number(btcBlock)), at: Date.now() };
        logger.warn('StateCheckpointEngine: ' + chain + ' round failed: ' + reason +
                    ' (' + this._roundFailuresByChain[chain] + ' failed round(s) for this chain so far)');
    },

    // A round for this chain returned, so its last failure no longer describes it.
    clearRoundFailure(chain){
        if(this._lastRoundFailureByChain) delete this._lastRoundFailureByChain[chain];
    },

    // Seed the cadence latch from persisted checkpoints so a hub restart does
    // not fire an off-schedule (extra DOGE-anchored) checkpoint. The latch is a
    // single global "last snapshot block we checkpointed at" (one round spans
    // all chains), so MAX(snapshot_block) for THIS network is the right seed.
    // Scoped to this.network so a hub carrying rows from a prior network does
    // not seed the latch from the wrong (typically larger) block height, which
    // would silently suppress checkpointing on the active network indefinitely.
    // Best-effort: a read failure leaves the latch null (pre-fix behaviour) and
    // must not block engine startup.
    async loadLastCheckpointLatch(){
        try {
            let rows = await this.db.getStateCheckpointsMaxSnapshotBlock(this.network);
            let last = rows && rows[0] ? rows[0].last_block : null;
            if(last != null){
                this._lastCheckpointBtcBlock = Number(last);
                logger.info('StateCheckpointEngine: cadence latch restored at snapshot block ' + this._lastCheckpointBtcBlock);
            }
        } catch(e){
            logger.warn('StateCheckpointEngine: could not restore cadence latch (' + (e && e.message) + '), first tick may checkpoint early');
        }
    },

    // Cadence: leader-only initiation; followers only react to SIGN_REQs.
    //
    // Two latches, because they answer different questions. _lastCheckpointBtcBlock is
    // the snapshot block of the last FINALIZED checkpoint, the same on every hub that saw
    // it, and both the leader gate here and the co-sign gate read it. The attempt latch
    // records only that this hub opened a round at a block, so a tip that has not moved
    // re-leads through the bounded retry rather than as a fresh round. Writing the attempt
    // into the finalized latch, as this tick once did, made one failed round refuse every
    // rotated leader's retry for a whole interval, and the next failed round staggered the
    // latches further until no checkpoint finalized anywhere.
    async tick(){
        if(this._ticking) return;
        // Before any indexer round trip: an observer's round cannot be signed.
        if(this.observerHold()) return;
        this._ticking = true;
        try {
            await this.retryFailedSelfAccepts();
            let btcBlock = await this.resolveSnapshotBlock();
            if(btcBlock == null){ this.noteCadenceStall(null, 'no BTC snapshot block (indexer unreachable or no tip)'); return; }
            if(this.finalizedLatchHolds(btcBlock)){
                // On schedule: the cadence simply has not come round yet.
                this.clearCadenceStall();
                this.clearNotMySlot();
                await this.retryTimedOutRounds();
                return;
            }
            // Same block as this hub's own open attempt: the tip has not moved, so the
            // attempt's retry (bounded) runs instead of a fresh round.
            if(btcBlock === this._attemptedCheckpointBtcBlock){ await this.retryTimedOutRounds(); return; }
            this.supersedeOwnAttempt(btcBlock);
            // This hub's signature is on another round of this interval that may still
            // finalize; leading a second one could give the interval two checkpoints.
            if(this.signedRoundConflict(btcBlock) != null) return;
            // A new interval supersedes any timed-out round still waiting for a retry.
            if(this._roundRetries) this._roundRetries.clear();

            let validators = await this.resolveCapabilityValidators('oracle_publish', btcBlock);
            if(!this.leadsCadenceSlot(btcBlock, validators)) return;
            await this.leadCadenceRound(btcBlock, validators);
        } finally {
            this._ticking = false;
        }
    },

    // True while `btcBlock` is inside the interval after the last FINALIZED checkpoint.
    finalizedLatchHolds(btcBlock){
        let last = this._lastCheckpointBtcBlock;
        return last != null && btcBlock < Number(last) + this.intervalBlocks;
    },

    // We are the cadence leader (or a single-node set): one round per chain.
    async leadCadenceRound(btcBlock, validators){
        // Mirror the capability snapshot BEFORE the attempt is recorded. This call sits
        // outside the per-chain guard below, so a throw here aborts every chain's round;
        // recorded first, the whole interval was dropped and getcheckpointstats still
        // read clean, which is the silent-cadence shape that cost 18 days on mainnet.
        // Meter it and leave the round retryable.
        try {
            await this.persistCapabilitySnapshot('oracle_publish', btcBlock);
        } catch(e){
            this.noteCadenceStall(btcBlock, 'capability snapshot mirror failed: ' + (e && e.message));
            return;
        }
        this.clearCadenceStall();
        this._attemptedCheckpointBtcBlock = btcBlock;
        for(let chain of this.chains){
            if(!this.indexers[chain].url) continue;
            try { await this.runRound(chain, btcBlock, validators); this.clearRoundFailure(chain); }
            catch(e){
                // An indexer blip before the proposal: retryable here on a frozen tip, and
                // the next block's leader retries the interval since no latch moved. Each
                // failure is metered per chain so getcheckpointstats names the chain and reason.
                this.noteRoundFailure(chain, btcBlock, e);
                this.queueRoundRetry({ chain, snapshot_block: btcBlock, block_index: null }, 0);
            }
        }
    },

    // The interval rule every signature this hub gives obeys, as leader or co-signer. A
    // round at `snap` may not start inside the interval after the last FINALIZED
    // checkpoint (a snapshot EQUAL to it is the same round, one SIGN_REQ per chain, and
    // the first chain's FINALIZED may already have moved the latch there), nor inside the
    // interval of another snapshot this hub signed whose round may still finalize. Two
    // slot holders one block apart in tip both see the interval due; since any two
    // quorums share a signer, one signature per interval lets at most one of them
    // finalize. Returns why `snap` conflicts, or null.
    cadenceConflict(snap){
        let finalized = this.finalizedConflict(snap);
        if(finalized != null) return finalized;
        let held = this.signedRoundConflict(Number(snap));
        if(held != null) return 'this hub signed snapshot ' + held + ' in the same interval and that round is still open';
        return null;
    },

    // The finalized-latch half of cadenceConflict alone.
    finalizedConflict(snap){
        let s = Number(snap), last = this._lastCheckpointBtcBlock;
        if(last != null && s !== Number(last) && s < Number(last) + this.intervalBlocks)
            return 'last checkpoint ' + Number(last) + ', interval ' + this.intervalBlocks;
        return null;
    },

    // A snapshot this hub signed whose round may still finalize and that sits within one
    // interval of `snap`, or null. A signature stops counting once its round finalizes or
    // is superseded (the latch reaches it) or once a round timeout has passed, after
    // which an honest leader can no longer finalize it.
    signedRoundConflict(snap){
        let s = Number(snap), now = Date.now(), last = this._lastCheckpointBtcBlock;
        for(let [held, until] of this._roundSignatures){
            if(until <= now || (last != null && held <= Number(last))){ this._roundSignatures.delete(held); continue; }
            if(held !== s && Math.abs(s - held) < this.intervalBlocks) return held;
        }
        return null;
    },

    // A newer block on this hub's own tip supersedes the unfinalized round it led at an
    // older one. That block has its own slot holder, and while this hub's round stays
    // open (or queued for a retry) its own signature holds the interval against that
    // leader. Only the leader finalizes its round, so dropping the round makes releasing
    // the signature safe. A round already finalized on some chain (the latch reached the
    // attempt) is left alone: the rest of its chains are the same round.
    supersedeOwnAttempt(btcBlock){
        let attempt = this._attemptedCheckpointBtcBlock, last = this._lastCheckpointBtcBlock;
        if(attempt == null || !(btcBlock > attempt) || (last != null && Number(last) >= attempt)) return;
        this.dropOwnAttempt(attempt);
    },

    // Two slot holders one block apart in tip lead one interval, the lagging one at the
    // lower block. The higher one yields when the lower round asks for its co-signature:
    // it drops its own unfinalized round, as above, so it can sign the lower one. Peers
    // that already co-signed the higher round keep that signature until it expires, so
    // the race resolves at once only where they had not; otherwise the next block's
    // leader retries the interval. Called only once our own indexer has confirmed `cp`,
    // so a proposal this hub could not sign never costs it its own round.
    yieldToLowerRound(cp){
        let snap = Number(cp.snapshot_block), attempt = this._attemptedCheckpointBtcBlock, last = this._lastCheckpointBtcBlock;
        if(attempt == null || !(snap < attempt) || attempt - snap >= this.intervalBlocks) return;
        if(last != null && Number(last) >= attempt) return;
        if(this.finalizedConflict(snap) != null) return;
        this.dropOwnAttempt(attempt);
    },

    // Cancel this hub's own open or queued round at `attempt` and release its signature.
    dropOwnAttempt(attempt){
        for(let [id, p] of this.pending){
            if(Number(p.cp.snapshot_block) !== attempt) continue;
            if(p.timer){ clearTimeout(p.timer); p.timer = null; }
            p.done = true;
            this.pending.delete(id);
        }
        if(this._roundRetries)
            for(let [chain, r] of this._roundRetries) if(Number(r.snapshotBlock) === attempt) this._roundRetries.delete(chain);
        this._roundSignatures.delete(attempt);
        this._attemptedCheckpointBtcBlock = null;
    },

    // Record a signature this hub gave on a round at `snap`, as leader or co-signer.
    noteRoundSignature(snap){
        this._roundSignatures.set(Number(snap), Date.now() + this.roundTimeoutMs);
    },

    // The leader's half of the interval rule, checked where its signature would leave
    // and again at quorum: a FINALIZED checkpoint or a co-signature inside the interval
    // that landed while this round was being built means another round owns it.
    declinesOwnRound(cp){
        let conflict = this.cadenceConflict(cp.snapshot_block);
        if(conflict == null) return false;
        logger.info('StateCheckpointEngine: not finalizing ' + cp.chain + ' round at snapshot ' +
                    Number(cp.snapshot_block) + ': ' + conflict);
        return true;
    },

    // Re-lead each chain round that timed out unfinalized, at the snapshot block it first
    // used (so a frozen BTC tip still checkpoints). Entries are consumed as they run; a
    // retry that times out again re-queues itself up to the round's retry cap.
    async retryTimedOutRounds(){
        if(!this._roundRetries || this._roundRetries.size === 0) return;
        let retries = [...this._roundRetries];
        this._roundRetries.clear();
        for(let [chain, retry] of retries){
            if(!this.indexers[chain] || !this.indexers[chain].url) continue;
            try {
                let validators = await this.resolveCapabilityValidators('oracle_publish', retry.snapshotBlock);
                if(!this.leadsCadenceSlot(retry.snapshotBlock, validators)) continue;
                await this.runRound(chain, retry.snapshotBlock, validators, retry);
                this.clearRoundFailure(chain);
            } catch(e){
                this.noteRoundFailure(chain, retry.snapshotBlock, e);
            }
        }
    },

    // Whether this hub leads the cadence round at btcBlock over `validators`. Every way it
    // cannot is metered on the stall record (or, for a moving tip, the not-my-slot
    // counter) exactly as tick did inline, and false tells tick to stop there.
    leadsCadenceSlot(btcBlock, validators){
        // Dedupe to DISTINCT pubkeys before ranking (mirrors the finalizer's
        // Set at handleFinalized). At/above STAKE_WEIGHTED_QUORUM the weighted
        // snapshot is one row per (source, pubkey), so a key delegated by two sources
        // appears twice; ranking over the raw list inflates pubkeys.length and lets
        // `btcBlock % pubkeys.length` land on a duplicate's slot where no hub is
        // leader, silently dropping that cadence round. MUST stay in lockstep with the
        // follower site in followsCadenceLeader (deduping only one turns a dropped round
        // into split-brain). Inert below SWQ, where there are no duplicate pubkeys.
        let pubkeys    = [...new Set(validators.map(v => String(v.pubkey).toLowerCase()))].sort();
        // No oracle_publish set at all -> nothing to sign authoritatively. A
        // checkpoint signed by a non-validator identity could never verify
        // against any capability snapshot. (Single-operator regtest seeds a
        // local validator via XDEX_SEED_LOCAL_VALIDATOR, so it still runs.)
        if(pubkeys.length === 0){
            this.noteCadenceStall(btcBlock, 'no qualified oracle_publish validator set (capability self-test failing, ' +
                                             'not enabled, or no snapshot rows)');
            return false;
        }
        // Membership + cadence run for EVERY set size: a size-1 set once
        // skipped even the indexOf check, letting a hub whose identity is NOT
        // the sole oracle_publish validator sign an unverifiable checkpoint.
        // (Size-1 cadence is btcBlock % 1 === 0 === rank, so the sole
        // validator still checkpoints every cadence block.)
        if(!this.identity){ this.noteCadenceStall(btcBlock, 'no validator identity (cannot sign checkpoints)'); return false; }
        let me = this.identity.getPubkeyHex().toLowerCase();
        let myRank = pubkeys.indexOf(me);
        if(myRank < 0){                                     // not an oracle_publish validator
            this.noteCadenceStall(btcBlock, 'this hub is not in the oracle_publish validator set (' +
                                             pubkeys.length + ' member(s))');
            return false;
        }
        // Not our slot: normal rotation in an N>1 federation, NOT a stall, as long
        // as btcBlock is still moving. A single-member set is always its own leader
        // (btcBlock % 1 === 0 === rank), so this branch can never hide the
        // lone-validator case. It CAN hide a frozen BTC tip (slot pinned to a
        // constant that is not our rank, forever), so K consecutive not-my-slot
        // ticks at the same btcBlock are metered as a stall.
        if(myRank !== (btcBlock % pubkeys.length)){
            if(this.noteNotMySlot(btcBlock)){
                this.noteCadenceStall(btcBlock, 'BTC snapshot block frozen at ' + btcBlock + ' for ' +
                    this._notMySlotTicks + ' consecutive ticks while cadence slot ' + (btcBlock % pubkeys.length) +
                    ' is not this hub\'s rank ' + myRank + ' of ' + pubkeys.length +
                    ' (leader election cannot rotate until the BTC tip advances)');
            } else {
                // A moving tip that merely rotated past us clears any earlier
                // frozen-tip reason so getcheckpointstats stays live.
                if(this._notMySlotTicks === 1) this.clearCadenceStall();
            }
            return false;
        }
        this.clearNotMySlot();
        return true;
    }

};
