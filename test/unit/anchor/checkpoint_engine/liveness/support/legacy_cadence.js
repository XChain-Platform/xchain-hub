'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The cadence a hub ran before the finalized latch was split from its own attempt,
// applied to one engine so a fleet in the middle of a rolling deploy (some hubs old,
// some new) can be driven in one mesh. Old tick wrote the block it led into
// _lastCheckpointBtcBlock before the round finalized, old co-sign read that same
// field, and old hubs kept no per-interval signature record and queued no retry for
// a round that threw. The wire, the payload and the signing string are the same on
// both sides, so nothing else needs a double.

// Old tick, statement for statement, with its comments and its failed-round warning
// left out.
async function legacyTick() {
    if (this._ticking) return;
    if (this.observerHold()) return;
    this._ticking = true;
    try {
        let btcBlock = await this.resolveSnapshotBlock();
        if (btcBlock == null) { this.noteCadenceStall(null, 'no BTC snapshot block (indexer unreachable or no tip)'); return; }
        if (this._lastCheckpointBtcBlock != null && btcBlock < this._lastCheckpointBtcBlock + this.intervalBlocks) {
            this.clearCadenceStall();
            this.clearNotMySlot();
            await this.retryTimedOutRounds();
            return;
        }
        if (this._roundRetries) this._roundRetries.clear();
        let validators = await this.resolveCapabilityValidators('oracle_publish', btcBlock);
        if (!this.leadsCadenceSlot(btcBlock, validators)) return;
        try {
            await this.persistCapabilitySnapshot('oracle_publish', btcBlock);
        } catch (e) {
            this.noteCadenceStall(btcBlock, 'capability snapshot mirror failed: ' + (e && e.message));
            return;
        }
        this.clearCadenceStall();
        this._lastCheckpointBtcBlock = btcBlock;
        for (let chain of this.chains) {
            if (!this.indexers[chain].url) continue;
            try { await this.runRound(chain, btcBlock, validators); } catch (e) { /* old code: logged, not retried */ }
        }
    } finally {
        this._ticking = false;
    }
}

// Old co-sign gate: the one latch, whatever wrote it.
function legacyCadenceConflict(snap) {
    let latch = this._lastCheckpointBtcBlock;
    let s = Number(snap);
    if (latch == null || s === latch || s >= latch + this.intervalBlocks) return null;
    return 'last checkpoint ' + latch + ', interval ' + this.intervalBlocks;
}

function legacyCadence(engine) {
    engine.tick = legacyTick;
    engine.cadenceConflict = legacyCadenceConflict;
    engine.finalizedConflict = legacyCadenceConflict;
    engine.noteRoundSignature = function () {};
    engine.declinesOwnRound = function () { return false; };
    return engine;
}

module.exports = { legacyCadence };
