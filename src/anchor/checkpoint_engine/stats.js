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
 * State checkpoint engine - operator stats
 *
 * What getcheckpointstats reports: the last finalized height per chain and every
 * meter the engine keeps.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Return operator-visible checkpoint health: last finalized height per chain
    // and a process-lifetime count of rounds that timed out below quorum.
    // Mirrors getcrosschaincallstats / getattestationstats.
    async getStats(){
        let rows = [];
        try {
            rows = await this.db.findStateCheckpointsByNetwork(this.network);
        } catch(e){
            logger.warn('StateCheckpointEngine: getStats query failed: ' + (e && e.message));
        }
        let last_finalized_by_chain = {};
        for(let r of rows){
            last_finalized_by_chain[r.chain] = {
                block_index:    Number(r.last_finalized_block),
                checkpoint_seq: Number(r.last_seq)
            };
        }
        return {
            last_finalized_by_chain: last_finalized_by_chain,
            round_timeouts:          this._roundTimeouts,
            malformed_finalized:     this._malformedFinalized,
            sub_quorum_finalized:    this._subQuorumFinalized,
            // Non-zero means two quorum-signed payloads arrived at one checkpoint_seq.
            // Never a tuning knob: it is an equivocation report and the fleet may hold
            // divergent checkpoints at that sequence.
            seq_conflicts:           this._seqConflicts,
            // Non-zero means a proposer asked this hub to sign a second, different
            // payload at a sequence it had already signed. The signature was refused, so
            // this is the fence holding rather than damage; it still reports a proposer
            // that put two payloads on the wire at one sequence.
            seq_double_sign_refusals: this._seqDoubleSignRefusals,
            // Non-zero with a reason means the engine is alive but structurally
            // unable to checkpoint (unqualified capability, missing identity, not in the
            // validator set), the failure mode that produced 18 silent days on mainnet.
            // True means the cadence is deliberately idle rather than broken: this hub
            // is outside the signer set, so it opens no round at all (see observerHold).
            observer_idle:           this._observerIdle,
            cadence_stalls:          this._cadenceStalls,
            cadence_stall_reason:    this._cadenceStallReason,
            cadence_stall_block:     this._cadenceStallBlock,
            // Frozen-tip livelock meter: how many consecutive due-but-not-
            // my-slot ticks have seen the same BTC snapshot block, and the K at which
            // that becomes a metered stall. Non-zero and climbing with a moving tip is
            // impossible; climbing past K means the BTC tip is not advancing.
            frozen_tip_ticks:        this._notMySlotTicks,
            frozen_tip_block:        this._notMySlotBlock,
            frozen_tip_stall_ticks:  this._frozenTipTicks
        };
    }

};
