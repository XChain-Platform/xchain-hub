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
 * XChain Hub - SpendGuard reservations
 *
 * The await-safe gate: reserve before the send, commit when it went out, release
 * if it never did. src/lib/spend_guard.js installs every method below on
 * SpendGuard.prototype, so every effector keeps writing guard.<method>().
 *
 ********************************************************************/

'use strict';

module.exports = {

    // check()/allow() are pure predicates and record() runs after the
    // awaited broadcast, so every caller that awaits between the two leaves a window
    // in which concurrent callers all read the same pre-send budget and all spend.
    // reserve() runs the same gates and CONSUMES the budget in the same synchronous
    // turn, which closes that window by construction on Node's single thread.
    //
    // Returns an opaque token, or null when a gate blocked (call noteBlocked() for
    // the reason, exactly as after a false allow()). The reservation IS the record:
    // never call record() for a reserved send, or the spend is counted twice.
    reserve(cost){
        if (this.paused){ this.blocked.pause++; return null; }
        let now = Date.now();
        if (!this.ceiling.allow(now)){ this.blocked.spend++; return null; }
        let c = this.computeCost(cost);
        if (this.spentInWindow(now) + c > this.maxSpendUsdCents){ this.blocked.spend++; return null; }

        this._reserveSeq = (this._reserveSeq || 0) + 1;
        let token = { id: this._reserveSeq, ceilingHandle: this.ceiling.reserve(now), settled: false };
        this._spends.push({ t: now, cost: c, reservation: token.id });
        // Persist the RESERVATION too: a crash between reserving and sending must not
        // hand the restart its budget back, since the send may well have gone out.
        //
        // And if that write does not land, the reservation does not authorise anything.
        // Roll it back in this same synchronous turn and refuse: an unrecorded spend is
        // indistinguishable, after a restart, from a spend that never happened, so
        // authorising one turns a read-only disk into an unbounded allowance. The hub
        // goes visibly silent instead (operator ruling: fail closed).
        if (!this.persist()){
            let i = this._spends.findIndex(e => e.reservation === token.id);
            if (i >= 0) this._spends.splice(i, 1);
            this.ceiling.release(token.ceilingHandle);
            token.settled = true;                    // a stray release() must stay a no-op
            this.blocked.persist++;
            return null;
        }
        return token;
    },

    // The send went out: keep the reserved budget as the recorded spend and make the
    // token inert, so a later stray release() cannot hand back a real spend.
    //
    // `actualCost` (USD cents) re-prices the reservation for a caller that only learns
    // the REAL cost after the send: the llm provider reserves at an estimate and its
    // claude_spawn transport reports total_cost_usd on return, so settling at the
    // invoice keeps the window tracking money actually spent instead of a guess.
    // Omitted or unusable keeps the reserved estimate, which is what every on-chain
    // effector wants - a broadcast fee is known before it is sent.
    commit(token, actualCost){
        if (!token) return;
        token.settled = true;
        let c = Number(actualCost);
        if (!Number.isFinite(c) || c <= 0) return;
        let i = this._spends.findIndex(e => e.reservation === token.id);
        if (i < 0) return;
        this._spends[i].cost = c;
        this.persist();
    },

    // The send never went out (blocked, threw, or was abandoned): give the budget
    // back. Idempotent, and a no-op on a committed token; a missed release only
    // over-counts, which fails closed and ages out within one window.
    release(token){
        if (!token || token.settled) return;
        token.settled = true;
        let i = this._spends.findIndex(e => e.reservation === token.id);
        if (i >= 0) this._spends.splice(i, 1);
        this.ceiling.release(token.ceilingHandle);
        this.persist();
    }
};
