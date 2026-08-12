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
 * XChain Hub - Spend ceiling (item 2676)
 *
 * A rolling-window ceiling on the NUMBER of fee-bearing broadcasts a publisher
 * may issue per window. Each broadcast spends roughly one on-chain fee, so a
 * per-window broadcast count is a deterministic, fail-safe proxy for spend that
 * needs no fee-estimation or fiat price feed (both of which are themselves fault
 * surfaces on a money path). It bounds the two drain shapes the balance floor
 * alone does not: a stuck-transaction retry loop, and a burst of pending work
 * that publishes faster than intended.
 *
 * Fail-safe semantics:
 *   - Disabled by default (maxPerWindow <= 0). Enabling it can only ever REDUCE
 *     spend, never increase it, so a misconfiguration cannot make a publisher
 *     spend more or twice.
 *   - allow() is a pure pre-send check (prunes expired timestamps, compares the
 *     live count to the cap). record() is called only AFTER a broadcast actually
 *     went out, so deferred/failed sends do not consume budget.
 *   - When the cap is reached, the caller skips the publish (fail-closed) rather
 *     than sending; the work stays queued for a later window.
 *   - reserve()/release() are the await-safe form of the same pair: a caller that
 *     awaits its send consumes the slot up front and hands it back on failure, so
 *     concurrent callers cannot all pass the same allow(). A slot that
 *     is never released over-counts, which blocks rather than overspends, and it
 *     ages out of the window on its own.
 *
 * Construction reads the two knobs from env (operator-local) falling back to the
 * hub p2pConfig, matching the publishers' existing config-read convention:
 *   <PREFIX>_MAX_PUBLISHES_PER_WINDOW  integer, <=0 or unset => disabled
 *   <PREFIX>_SPEND_WINDOW_MS           window length in ms (default 1h)
 *
 ********************************************************************/

'use strict';

const DEFAULT_WINDOW_MS = 3600000; // 1 hour

class SpendCeiling {

    // prefix: env/config key prefix, e.g. 'ORACLE_PUBLISH' or 'ATTEST'.
    // cfg:    hub p2pConfig (optional) consulted after process.env.
    // label:  human name used in the skip log line.
    constructor(prefix, cfg, label){
        cfg = cfg || {};
        let maxKey    = prefix + '_MAX_PUBLISHES_PER_WINDOW';
        let windowKey = prefix + '_SPEND_WINDOW_MS';
        this.maxPerWindow = parseInt(process.env[maxKey] || cfg[maxKey] || '0', 10);
        if (!Number.isFinite(this.maxPerWindow) || this.maxPerWindow < 0) this.maxPerWindow = 0;
        this.windowMs = parseInt(process.env[windowKey] || cfg[windowKey] || String(DEFAULT_WINDOW_MS), 10);
        if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) this.windowMs = DEFAULT_WINDOW_MS;
        this.label = label || prefix;
        this._spends = [];   // broadcast timestamps within the current window
        // Lifetime count of publishes skipped because the ceiling tripped, so an
        // operator can see the ceiling is actively gating rather than dormant.
        this.blockedCount = 0;
    }

    // True when the ceiling is off (no cap configured).
    get disabled(){ return this.maxPerWindow <= 0; }

    _prune(now){
        let cutoff = now - this.windowMs;
        while (this._spends.length && this._spends[0] <= cutoff) this._spends.shift();
    }

    // Number of broadcasts recorded in the live window.
    countInWindow(now){
        now = now || Date.now();
        this._prune(now);
        return this._spends.length;
    }

    // Pre-send gate. Returns true if another broadcast is within budget.
    // A disabled ceiling always allows (behavior unchanged for untuned operators).
    allow(now){
        if (this.disabled) return true;
        now = now || Date.now();
        this._prune(now);
        return this._spends.length < this.maxPerWindow;
    }

    // Record a broadcast that actually went out. No-op when disabled.
    record(now){
        if (this.disabled) return;
        now = now || Date.now();
        this._prune(now);
        this._spends.push(now);
    }

    // Consume a count slot SYNCHRONOUSLY, before the caller awaits its send.
    // allow() is a pure predicate, so two callers that both await between
    // allow() and record() each see the same pre-send count and both broadcast past
    // the cap. Returns the timestamp used as the release handle, or null when the
    // ceiling is disabled (nothing to give back).
    reserve(now){
        if (this.disabled) return null;
        now = now || Date.now();
        this._prune(now);
        this._spends.push(now);
        return now;
    }

    // Give back a provisional slot whose send never went out. Timestamps are
    // interchangeable, so removing the first equal entry is exact; an unknown handle
    // is ignored, which keeps a double release from freeing somebody else's slot.
    release(handle){
        if (this.disabled || handle == null) return;
        let i = this._spends.indexOf(handle);
        if (i >= 0) this._spends.splice(i, 1);
    }

    // Fill the count window so the next allow() is false until it rolls over. Used
    // only on SpendGuard's fail-closed path, when the persisted spend state cannot be
    // read: an unreadable store must never read as an empty window.
    seedConsumed(now){
        if (this.disabled) return;
        now = now || Date.now();
        this._prune(now);
        while (this._spends.length < this.maxPerWindow) this._spends.push(now);
    }

    // Count a tripped-ceiling skip and return an actionable message for the log.
    noteBlocked(now){
        this.blockedCount++;
        now = now || Date.now();
        let resetIn = this.windowMs - (now - (this._spends[0] || now));
        if (resetIn < 0) resetIn = 0;
        return this.label + ': per-window spend ceiling reached (' + this.maxPerWindow +
               ' publishes / ' + this.windowMs + 'ms); skipping publish, budget frees in ~' +
               Math.ceil(resetIn / 1000) + 's';
    }

    stats(now){
        return {
            maxPerWindow: this.maxPerWindow,
            windowMs:     this.windowMs,
            inWindow:     this.disabled ? 0 : this.countInWindow(now),
            blocked:      this.blockedCount
        };
    }
}

module.exports = SpendCeiling;
