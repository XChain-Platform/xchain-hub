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
 * XChain Hub - SpendGuard restart persistence
 *
 * The durable half of the spend window: where it is stored, how it is read back
 * after a restart, and the fail-closed refusal while the store cannot record a
 * spend. src/lib/spend_guard.js installs every method below on SpendGuard.prototype,
 * so every effector keeps writing guard.<method>().
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Both windows lived only in memory, so a restart emptied them and handed the
    // effector its FULL per-window allowance again - which breaks the invariant at
    // the top of spend_guard.js, since a crash-loop then spends a whole window's budget
    // per restart. The durable half is the same JSONL/`./data` idiom the hub already
    // uses for its spend audits (AttestationRelay's WAL, FullNodeChallengeRound's
    // spend log), kept SYNCHRONOUS so check()/allow()/record() stay the pure,
    // non-async predicates their five call sites depend on.
    //
    // Call from the effector's start(), never the constructor: a guard is
    // constructed in tests and by non-spending code paths, and none of those should
    // touch the disk or inherit a live hub's consumed budget.
    //
    // The path comes from `this.statePath` (env `<PREFIX>_SPEND_STATE_PATH`, then
    // cfg, then ./data/spend-state/<label>.json) so a caller or test overrides it the
    // way it overrides walPath/queuePath. It is resolved ONCE, here, against the cwd
    // the hub booted in: a relative default plus a later process.chdir() would split
    // one effector's window across two files, which reads as a restarting allowance -
    // the exact defect this method exists to close.
    persistTo(statePath){
        this._statePath = path.resolve(statePath || this.statePath);
        this.loadState();
        return this;
    },

    // Fold the saved window back in. Rules, all fail-closed:
    //   absent, store writable   -> first run; start empty.
    //   absent, store unwritable -> the file could never have been written, so an
    //                               empty read is not evidence of a first run.
    //   unreadable/corrupt       -> assume the window may already be spent (seed
    //                               CONSUMED), because a broken store must never
    //                               read as a green light.
    //   valid                    -> prune to the live window and rebuild BOTH ceilings.
    // A persisted RESERVATION is loaded as a plain spend: the process that could have
    // released it is gone, and over-counting blocks rather than overspends.
    loadState(){
        let text;
        try { text = fs.readFileSync(this._statePath, 'utf8'); }
        catch(e){
            if (e && e.code === 'ENOENT'){
                // A first run and a store that was never writable raise the same
                // ENOENT, and only the first has earned a fresh allowance. On a
                // read-only disk persist() lands no byte, so without this the
                // window resets on every restart and the ceiling is unbounded
                // across them, which is the one shape spend_guard.js exists to stop.
                if (this.storeIsWritable()) return;
                this.seedConsumed('absent, and its directory does not accept writes');
                return;
            }
            this.seedConsumed('unreadable (' + (e && e.code ? e.code : 'error') + ')');
            return;
        }
        let saved;
        try { saved = JSON.parse(text); }
        catch(e){ this.seedConsumed('corrupt JSON'); return; }
        if (!saved || !Array.isArray(saved.spends)){ this.seedConsumed('unrecognized shape'); return; }

        let now = Date.now();
        let cutoff = now - this.windowMs;
        for (let e of saved.spends){
            let t = Number(e && e.t), c = Number(e && e.cost);
            if (!Number.isFinite(t) || t <= cutoff) continue;   // outside the live window
            if (t > now) t = now;                               // clock moved back; never park a spend in the future
            this._spends.push({ t: t, cost: Number.isFinite(c) && c > 0 ? c : this.estSpendUsdCents });
            this.ceiling.record(t);                             // the count ceiling shares every entry
        }
        this._spends.sort((a, b) => a.t - b.t);                 // prune() assumes ascending
        if (this._spends.length)
            logger.info(this.label + ': restored ' + this._spends.length + ' spend(s) totalling $' +
                        (this.spentInWindow(now) / 100).toFixed(2) + ' from ' + this._statePath +
                        '; the per-window ceiling survives this restart');
    },

    // Could persist() land a byte here? Permission probe only: it creates nothing
    // and writes nothing, so the write path keeps its single call site and this
    // stays safe to run during construction.
    //
    // Walks to the nearest existing ancestor because persist() mkdirs the tree it
    // needs, so an absent directory under a writable parent is still a store this
    // hub can write. Anything else (no permission, no reachable parent) is not.
    storeIsWritable(){
        let dir = path.dirname(this._statePath);
        for (let hops = 0; hops < 64; hops++){
            try {
                fs.accessSync(dir, fs.constants.W_OK);
                return true;
            } catch(e){
                if (!e || e.code !== 'ENOENT') return false;   // present but refused
                let parent = path.dirname(dir);
                if (parent === dir) return false;              // reached the root
                dir = parent;
            }
        }
        return false;
    },

    // Assume the window is spent. Costs at most one window of liveness on a broken
    // store, versus handing a restart a full fresh allowance.
    seedConsumed(why){
        let now = Date.now();
        this._spends.push({ t: now, cost: this.maxSpendUsdCents });
        this.ceiling.seedConsumed(now);
        logger.warn(this.label + ': spend state at ' + this._statePath + ' is ' + why +
                     '; assuming the window is already spent (fail-closed) until it rolls over');
    },

    // Write-through after every mutation. Never throws on the broadcast path, but it
    // REPORTS: true when the state is durable (or persistence was never armed), false
    // when the write failed. Swallowing the failure silently was the defect - the
    // caller went on to authorise a broadcast the store had no record of, so the next
    // restart read an empty window and handed the effector its full allowance back,
    // once per restart, exactly the unbounded-across-restarts shape persistTo() exists
    // to close. Operator ruling 2026-09-09/2026-09-11: fail closed.
    persist(){
        if (!this._statePath) return true;
        try {
            fs.mkdirSync(path.dirname(this._statePath), { recursive: true });
            fs.writeFileSync(this._statePath, JSON.stringify({
                label: this.label, windowMs: this.windowMs, savedAt: Date.now(), spends: this._spends
            }));
            if (this._persistBroken){
                // The disk came back (remount, freed space, fixed permissions). Clear
                // the refusal in the same place that raised it, and re-arm the warning
                // so a LATER failure is announced again instead of staying silent
                // behind a stale warned-once flag.
                this._persistBroken    = false;
                this._lastPersistError = null;
                this._warnedWrite      = false;
                logger.info(this.label + ': spend state at ' + this._statePath +
                            ' accepts writes again; spends resume');
            }
            return true;
        } catch(e){
            this._persistBroken    = true;
            this._lastPersistError = (e && e.message) ? e.message : String(e);
            if (!this._warnedWrite){
                this._warnedWrite = true;
                logger.warn(this.label + ': could not persist spend state to ' + this._statePath +
                             ' (' + this._lastPersistError + '); REFUSING to authorise further spends ' +
                             'until the store accepts writes (fail-closed)');
            }
            return false;
        }
    },

    // Pre-send guard on the store itself. A store that has already refused a write
    // cannot record the spend the caller is about to make, so while it is broken
    // every gate refuses. Re-probes by writing the CURRENT state (idempotent, and the
    // same bytes persist() would have written), so a hub whose disk comes back
    // resumes on its own rather than needing a restart to notice.
    storeUsable(){
        if (!this._statePath || !this._persistBroken) return true;
        return this.persist();
    },

    // Why the store gate refused, in the same shape as every other gate's reason.
    persistBlockedReason(){
        return this.label + ': spend state at ' + this._statePath + ' is unwritable (' +
               (this._lastPersistError || 'write failed') + '); refusing to authorise a spend ' +
               'this hub cannot record (fail-closed)';
    }
};
