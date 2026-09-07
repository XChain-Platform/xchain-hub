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
 * XChain Hub - Shared SpendGuard (flag-day Pkg 9 effector spend policy)
 *
 * One pre-send choke point for every hub effector that spends real coin on-chain
 * (OraclePublisher, AttestationPublisher, StateAnchorPublisher,
 * FullNodeChallengeRound). It composes the three fail-safe, fail-closed gates
 * those four sites previously grew ad hoc and inconsistently:
 *
 *   1. Balance floor        - never spend down past a configured wallet floor,
 *                             and never spend when the balance is unreadable
 *                             (null => blocked; a broken balance source must not
 *                             become a green light on a money path).
 *   2. Rolling fee-window   - a per-window ceiling on spend, tracked two ways
 *      cap, CLAMPED at $2000   that both trip: a broadcast COUNT (the legacy
 *                             SpendCeiling) and a cost-weighted USD-cents budget.
 *                             The USD budget is HARD-CLAMPED at $2000 (the
 *                             platform AML admission ceiling, operator-decided
 *                             2026-07-17): an operator can lower it but can never
 *                             configure a hub to spend more than $2000 per window.
 *   3. Per-capability        - an in-memory runtime pause, togglable per effector
 *      runtime pause          by capability label without a restart. Gating lives
 *                             at the broadcast choke point (check()/allow()), so a
 *                             pause halts the PRIMARY (leader/live) spend path, not
 *                             only the queue-sweep path (the fe3aedbf kill-switch
 *                             was inert on the primary path; this is the fix).
 *
 * Fail-safe invariants (mirrors SpendCeiling):
 *   - Every gate can only ever REDUCE spend. A misconfiguration cannot make an
 *     effector spend MORE, or spend twice.
 *   - check()/allow() are pure pre-send predicates. record() is called only AFTER
 *     a broadcast actually went out, so deferred/failed sends consume no budget.
 *   - A caller that AWAITS its send uses reserve()/commit()/release() instead: the
 *     pure-predicate pair leaves a window in which concurrent callers all pass the
 *     same check before any of them records, and all spend past the cap.
 *     release() on every non-send exit keeps "failed sends consume no budget" true.
 *   - The window SURVIVES a restart for any effector that calls persistTo() at
 *     start(). Without it both windows are memory-only, so a restart
 *     restores the full allowance and a crash-loop spends one window's budget per
 *     restart - a gate that a misconfiguration (or a bad deploy) can make spend
 *     MORE, which is exactly what the first invariant forbids.
 *   - The USD cap is default-ON (config-default-enabled): unset config
 *     yields the $2000 clamp, not "disabled". Per-broadcast cost defaults to a
 *     conservative estimate; a caller that knows the real fee passes it to
 *     record()/check() and the budget tracks actual spend.
 *
 * Config keys (env first, then hub p2pConfig, matching the publishers' convention):
 *   <PREFIX>_MAX_PUBLISHES_PER_WINDOW      integer count cap (SpendCeiling; <=0 => off)
 *   <PREFIX>_SPEND_WINDOW_MS               window length in ms (default 1h)
 *   <PREFIX>_MAX_SPEND_USD_CENTS_PER_WINDOW USD-cents budget; clamped to <= 200000
 *   <PREFIX>_EST_SPEND_USD_CENTS           per-broadcast cost estimate (default 100)
 *   <PREFIX>_MIN_BALANCE                   wallet floor (native coin; default 0)
 *
 * A module-level registry keyed by capability label backs the runtime-pause
 * control surface (an operator RPC can pause/resume an effector by name).
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const SpendCeiling = require('./spend_ceiling.js');

// $2000 AML admission ceiling, in USD cents. The hard clamp on the per-window
// spend budget: no operator config can raise the effective cap above this.
const HARD_CAP_USD_CENTS = 200000;

// Conservative default per-broadcast cost when the caller does not supply a real
// fee. $1/broadcast => the default $2000 window budget bounds a runaway loop at
// ~2000 broadcasts/window while staying far above any sane steady-state rate.
const DEFAULT_EST_SPEND_USD_CENTS = 100;

// label -> SpendGuard, for the per-capability runtime-pause control surface.
const registry = new Map();

function readInt(env, cfg, key, dflt){
    let v = parseInt((env[key] != null ? env[key] : cfg[key] != null ? cfg[key] : String(dflt)), 10);
    return Number.isFinite(v) ? v : dflt;
}

class SpendGuard {

    // prefix: env/config key prefix, e.g. 'ORACLE_PUBLISH', 'ATTEST', 'ANCHOR'.
    // cfg:    hub p2pConfig (optional), consulted after process.env.
    // label:  capability label used in log lines and the pause registry key.
    constructor(prefix, cfg, label){
        cfg = cfg || {};
        let env = process.env;
        this.prefix = prefix;
        this.label  = label || prefix;

        // Gate 2a: legacy per-window broadcast COUNT ceiling (unchanged behavior).
        this.ceiling = new SpendCeiling(prefix, cfg, this.label);
        // Share the same rolling window length for the cost budget.
        this.windowMs = this.ceiling.windowMs;

        // Gate 2b: per-window USD-cents spend budget, hard-clamped at $2000.
        // Default-ON: unset => the $2000 clamp itself (not disabled).
        let cfgCap = readInt(env, cfg, prefix + '_MAX_SPEND_USD_CENTS_PER_WINDOW', HARD_CAP_USD_CENTS);
        if (cfgCap <= 0) cfgCap = HARD_CAP_USD_CENTS;
        this.maxSpendUsdCents = Math.min(cfgCap, HARD_CAP_USD_CENTS);

        this.estSpendUsdCents = readInt(env, cfg, prefix + '_EST_SPEND_USD_CENTS', DEFAULT_EST_SPEND_USD_CENTS);
        if (this.estSpendUsdCents <= 0) this.estSpendUsdCents = DEFAULT_EST_SPEND_USD_CENTS;

        // Cost-weighted broadcast timestamps within the live window: [{t, cost}].
        this._spends = [];

        // Gate 1: wallet balance floor (native coin). Default 0 => only a null
        // (unreadable) or negative balance is blocked unless the site raises it.
        let floor = parseFloat(env[prefix + '_MIN_BALANCE'] != null ? env[prefix + '_MIN_BALANCE']
                    : (cfg[prefix + '_MIN_BALANCE'] != null ? cfg[prefix + '_MIN_BALANCE'] : '0'));
        this.minBalance = (Number.isFinite(floor) && floor >= 0) ? floor : 0;

        // Gate 3: runtime pause. Default not paused (config-default-enabled).
        this.paused      = false;
        this.pauseReason = null;

        // Diagnostics: why spends were skipped, per gate.
        this.blocked = { pause: 0, spend: 0, balance: 0 };

        // Restart persistence: OFF until an effector's start() calls persistTo().
        // Opt-in by CALL rather than by config so constructing a guard
        // is still pure and IO-free - the pure-construction contract every existing
        // call site and test relies on - while a real hub turns it on at boot.
        //
        // WHERE it writes is decided here, as a plain overridable string, in the same
        // env-or-cfg-with-a-./data-default shape as AttestationRelay.walPath and
        // AttestationPublisher.queuePath. Choosing the path inside persistTo() instead
        // left no handle to override, so every unit test that reached a real start()
        // wrote a durable window into the checkout and inherited it on the next run;
        // at ~$870 an hour of ordinary test runs that is a suite that goes red on a
        // schedule.
        this.statePath = env[prefix + '_SPEND_STATE_PATH'] || cfg[prefix + '_SPEND_STATE_PATH'] ||
                         path.join('./data', 'spend-state', String(this.label).replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
        this._statePath   = null;
        this._warnedWrite = false;

        registry.set(this.label, this);
    }

    // ---- Gate 3: per-capability runtime pause ----
    pause(reason){ this.paused = true; this.pauseReason = reason || 'operator pause'; }
    resume(){ this.paused = false; this.pauseReason = null; }
    isPaused(){ return this.paused; }

    // ---- Gate 2b: cost window helpers ----
    _prune(now){
        let cutoff = now - this.windowMs;
        while (this._spends.length && this._spends[0].t <= cutoff) this._spends.shift();
    }
    spentInWindow(now){
        now = now || Date.now();
        this._prune(now);
        let sum = 0;
        for (let e of this._spends) sum += e.cost;
        return sum;
    }
    // Normalize a per-broadcast cost to a positive USD-cents integer, defaulting
    // to the configured estimate when the caller supplies nothing usable.
    _cost(cost){
        let c = Number(cost);
        if (!Number.isFinite(c) || c <= 0) return this.estSpendUsdCents;
        return c;
    }

    // ---- Unified pre-send gate (all three gates) ----
    // opts: { balance?: number|null, cost?: usdCents }
    //   balance omitted (undefined)  => caller has no balance source; floor skipped
    //   balance === null             => balance unreadable => BLOCKED (fail-closed)
    // Returns { ok: boolean, reason: string|null }.
    check(opts){
        opts = opts || {};
        let now = Date.now();

        if (this.paused){
            this.blocked.pause++;
            return { ok: false, reason: this.label + ': effector spend PAUSED (' + (this.pauseReason || '') + '); skipping broadcast' };
        }

        // A configured floor that never receives a balance is silently inert:
        // the caller wired no balance source, so <PREFIX>_MIN_BALANCE looks
        // protective while doing nothing. Warn once so the dead knob is visible
        // (e.g. FullNodeChallengeRound calls check() with no balance argument).
        if (opts.balance === undefined && this.minBalance > 0 && !this._warnedFloorInert){
            this._warnedFloorInert = true;
            console.warn(this.label + ': ' + this.prefix +
                '_MIN_BALANCE=' + this.minBalance + ' is configured but check() is called with no balance; ' +
                'the wallet floor is INERT for this effector (no balance source wired).');
        }
        if (opts.balance !== undefined){
            if (opts.balance === null){
                this.blocked.balance++;
                return { ok: false, reason: this.label + ': wallet balance unreadable; skipping broadcast (fail-closed)' };
            }
            if (Number(opts.balance) < this.minBalance){
                this.blocked.balance++;
                return { ok: false, reason: this.label + ': wallet balance ' + opts.balance + ' below floor ' + this.minBalance + '; skipping broadcast (fail-closed)' };
            }
        }

        if (!this.ceiling.allow(now)){
            this.blocked.spend++;
            return { ok: false, reason: this.ceiling.noteBlocked(now) };
        }

        let cost = this._cost(opts.cost);
        if (this.spentInWindow(now) + cost > this.maxSpendUsdCents){
            this.blocked.spend++;
            return { ok: false, reason: this.label + ': rolling per-window spend ceiling reached ($' +
                     (this.maxSpendUsdCents / 100).toFixed(2) + '); skipping broadcast, budget frees within the window' };
        }

        return { ok: true, reason: null };
    }

    // Record a broadcast that actually went out (advances BOTH ceilings). No-op
    // for the count ceiling when it is disabled; always tracks USD-cents spend.
    record(cost){
        let now = Date.now();
        this.ceiling.record(now);
        this._prune(now);
        this._spends.push({ t: now, cost: this._cost(cost) });
        this._persist();
    }

    // ---- Await-safe gate: reserve before the send, release if it never went out ----
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
        let c = this._cost(cost);
        if (this.spentInWindow(now) + c > this.maxSpendUsdCents){ this.blocked.spend++; return null; }

        this._reserveSeq = (this._reserveSeq || 0) + 1;
        let token = { id: this._reserveSeq, ceilingHandle: this.ceiling.reserve(now), settled: false };
        this._spends.push({ t: now, cost: c, reservation: token.id });
        // Persist the RESERVATION too: a crash between reserving and sending must not
        // hand the restart its budget back, since the send may well have gone out.
        this._persist();
        return token;
    }

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
        this._persist();
    }

    // The send never went out (blocked, threw, or was abandoned): give the budget
    // back. Idempotent, and a no-op on a committed token; a missed release only
    // over-counts, which fails closed and ages out within one window.
    release(token){
        if (!token || token.settled) return;
        token.settled = true;
        let i = this._spends.findIndex(e => e.reservation === token.id);
        if (i >= 0) this._spends.splice(i, 1);
        this.ceiling.release(token.ceilingHandle);
        this._persist();
    }

    // ---- Restart persistence ----
    // Both windows lived only in memory, so a restart emptied them and handed the
    // effector its FULL per-window allowance again - which breaks the invariant at
    // the top of this file, since a crash-loop then spends a whole window's budget
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
        this._loadState();
        return this;
    }

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
    _loadState(){
        let text;
        try { text = fs.readFileSync(this._statePath, 'utf8'); }
        catch(e){
            if (e && e.code === 'ENOENT'){
                // A first run and a store that was never writable raise the same
                // ENOENT, and only the first has earned a fresh allowance. On a
                // read-only disk _persist() lands no byte, so without this the
                // window resets on every restart and the ceiling is unbounded
                // across them, which is the one shape this file exists to stop.
                if (this._storeIsWritable()) return;
                this._seedConsumed('absent, and its directory does not accept writes');
                return;
            }
            this._seedConsumed('unreadable (' + (e && e.code ? e.code : 'error') + ')');
            return;
        }
        let saved;
        try { saved = JSON.parse(text); }
        catch(e){ this._seedConsumed('corrupt JSON'); return; }
        if (!saved || !Array.isArray(saved.spends)){ this._seedConsumed('unrecognized shape'); return; }

        let now = Date.now();
        let cutoff = now - this.windowMs;
        for (let e of saved.spends){
            let t = Number(e && e.t), c = Number(e && e.cost);
            if (!Number.isFinite(t) || t <= cutoff) continue;   // outside the live window
            if (t > now) t = now;                               // clock moved back; never park a spend in the future
            this._spends.push({ t: t, cost: Number.isFinite(c) && c > 0 ? c : this.estSpendUsdCents });
            this.ceiling.record(t);                             // the count ceiling shares every entry
        }
        this._spends.sort((a, b) => a.t - b.t);                 // _prune() assumes ascending
        if (this._spends.length)
            console.log(this.label + ': restored ' + this._spends.length + ' spend(s) totalling $' +
                        (this.spentInWindow(now) / 100).toFixed(2) + ' from ' + this._statePath +
                        '; the per-window ceiling survives this restart');
    }

    // Could _persist() land a byte here? Permission probe only: it creates nothing
    // and writes nothing, so the write path keeps its single call site and this
    // stays safe to run during construction.
    //
    // Walks to the nearest existing ancestor because _persist() mkdirs the tree it
    // needs, so an absent directory under a writable parent is still a store this
    // hub can write. Anything else (no permission, no reachable parent) is not.
    _storeIsWritable(){
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
    }

    // Assume the window is spent. Costs at most one window of liveness on a broken
    // store, versus handing a restart a full fresh allowance.
    _seedConsumed(why){
        let now = Date.now();
        this._spends.push({ t: now, cost: this.maxSpendUsdCents });
        this.ceiling.seedConsumed(now);
        console.warn(this.label + ': spend state at ' + this._statePath + ' is ' + why +
                     '; assuming the window is already spent (fail-closed) until it rolls over');
    }

    // Write-through after every mutation. Best-effort: a failed write leaves this
    // process correctly gated and only weakens the NEXT restart, so it must not
    // throw on the broadcast path - but it is warned once so it is not silent.
    _persist(){
        if (!this._statePath) return;
        try {
            fs.mkdirSync(path.dirname(this._statePath), { recursive: true });
            fs.writeFileSync(this._statePath, JSON.stringify({
                label: this.label, windowMs: this.windowMs, savedAt: Date.now(), spends: this._spends
            }));
        } catch(e){
            if (this._warnedWrite) return;
            this._warnedWrite = true;
            console.warn(this.label + ': could not persist spend state to ' + this._statePath +
                         ' (' + (e && e.message ? e.message : e) + '); the ceiling still binds this process ' +
                         'but will reset on restart');
        }
    }

    // ---- Legacy drop-in shims for former SpendCeiling call sites ----
    // A pure pre-send predicate covering pause + count + cost (no balance; sites
    // that have a balance source gate it separately, or via check()). Folding the
    // pause in here is what makes a runtime pause reach the primary broadcast path.
    allow(cost){
        if (this.paused) return false;
        let now = Date.now();
        if (!this.ceiling.allow(now)) return false;
        return this.spentInWindow(now) + this._cost(cost) <= this.maxSpendUsdCents;
    }
    // Actionable skip message matching whichever gate tripped.
    noteBlocked(now){
        now = now || Date.now();
        if (this.paused) return this.label + ': effector spend PAUSED (' + (this.pauseReason || '') + ')';
        if (!this.ceiling.allow(now)) return this.ceiling.noteBlocked(now);
        return this.label + ': rolling per-window spend ceiling reached ($' +
               (this.maxSpendUsdCents / 100).toFixed(2) + ')';
    }

    stats(now){
        return {
            paused:                this.paused,
            pauseReason:           this.pauseReason,
            minBalance:            this.minBalance,
            maxSpendUsdCents:      this.maxSpendUsdCents,
            estSpendUsdCents:      this.estSpendUsdCents,
            spentInWindowUsdCents: this.spentInWindow(now),
            hardCapUsdCents:       HARD_CAP_USD_CENTS,
            count:                 this.ceiling.stats(now),
            blocked:               Object.assign({}, this.blocked)
        };
    }
}

// ---- Per-capability runtime-pause control surface ----
SpendGuard.registry          = registry;
SpendGuard.HARD_CAP_USD_CENTS = HARD_CAP_USD_CENTS;
SpendGuard.get               = (label) => registry.get(label) || null;
SpendGuard.pauseCapability   = (label, reason) => { let g = registry.get(label); if (g){ g.pause(reason); return true; } return false; };
SpendGuard.resumeCapability  = (label) => { let g = registry.get(label); if (g){ g.resume(); return true; } return false; };
SpendGuard.list              = (now) => Array.from(registry.entries()).map(([label, g]) => Object.assign({ label }, g.stats(now)));
// Test/GC helper: drop an instance from the registry (a fresh guard with the same
// label overwrites its entry anyway; this is only for explicit teardown).
SpendGuard.unregister        = (label) => registry.delete(label);

module.exports = SpendGuard;
