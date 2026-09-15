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
    // Compare NUMERICALLY: _resolveBtcLatestBlock serves the height from two
    // sources (the pushed chain_tips row, then a getlatestblock RPC), so the same
    // frozen height can arrive as 14671 on one tick and '14671' on the next. A
    // strict === there would restart the counter every tick and leave the meter
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
    async _tick(){
        if(this._ticking) return;
        // Before any indexer round trip: an observer's round cannot be signed.
        if(this.observerHold()) return;
        this._ticking = true;
        try {
            let btcBlock = await this.resolveSnapshotBlock();
            if(btcBlock == null){ this.noteCadenceStall(null, 'no BTC snapshot block (indexer unreachable or no tip)'); return; }
            if(this._lastCheckpointBtcBlock != null && btcBlock < this._lastCheckpointBtcBlock + this.intervalBlocks){
                // On schedule: the cadence simply has not come round yet.
                this.clearCadenceStall();
                this.clearNotMySlot();
                return;
            }

            let validators = await this.resolveCapabilityValidators('oracle_publish', btcBlock);
            if(!this.leadsCadenceSlot(btcBlock, validators)) return;

            // We are the cadence leader (or a single-node set): one round per chain.
            // Mirror the capability snapshot BEFORE the latch moves. This call sits
            // outside the per-chain guard below, so a throw here aborts every chain's
            // round; with the latch already advanced the whole interval was dropped
            // and getcheckpointstats still read clean, which is the silent-cadence
            // shape that cost 18 days on mainnet. Meter it and leave the round retryable.
            try {
                await this._persistCapabilitySnapshot('oracle_publish', btcBlock);
            } catch(e){
                this.noteCadenceStall(btcBlock, 'capability snapshot mirror failed: ' + (e && e.message));
                return;
            }
            // The latch advances even on per-chain failure; the next cadence retries.
            this.clearCadenceStall();
            this._lastCheckpointBtcBlock = btcBlock;
            for(let chain of this.chains){
                if(!this.indexers[chain].url) continue;
                try { await this.runRound(chain, btcBlock, validators); }
                catch(e){ logger.warn('StateCheckpointEngine: ' + chain + ' round failed: ' + (e && e.message)); }
            }
        } finally {
            this._ticking = false;
        }
    },

    // Whether this hub leads the cadence round at btcBlock over `validators`. Every way it
    // cannot is metered on the stall record (or, for a moving tip, the not-my-slot
    // counter) exactly as _tick did inline, and false tells _tick to stop there.
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
