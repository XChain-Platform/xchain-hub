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
 * XChain Hub - one-at-a-time runner for the deferred-announcement drains.
 *
 * The BUNDLE_DONE, FINALIZED and reward-attestation drains each walk a copy of their
 * queue and await indexer lookups per entry, and they run from two places: their own
 * announceRetryMs timer and the head of every flush. Two overlapping passes hold the
 * same queued entry and verify and apply it twice. serialPass keeps passes of one drain
 * from overlapping without making any caller miss an entry it could see.
 *
 ********************************************************************/

'use strict';

function ignore(){}

// Start one pass and clear the slot's running mark once it settles, whatever the outcome.
function startPass(slot, run){
    let pass = (async () => run())();
    slot.running = pass;
    pass.then(ignore, ignore).then(() => { if(slot.running === pass) slot.running = null; });
    return pass;
}

// Run `run` so passes stored under owner[key] never overlap. A caller arriving mid-pass
// waits, then gets a FRESH pass, never the running one, whose queue copy predates it:
// flush drains first so a peer's anchor is stamped before its failover-rank check could
// re-anchor (a real DOGE spend). Callers arriving during one pass share one fresh pass.
function serialPass(owner, key, run){
    let slot = owner[key] || (owner[key] = { running: null, next: null });
    if(slot.next) return slot.next;
    if(!slot.running) return startPass(slot, run);
    slot.next = slot.running.then(ignore, ignore).then(() => {
        slot.next = null;
        return startPass(slot, run);
    });
    return slot.next;
}

module.exports = { serialPass };
