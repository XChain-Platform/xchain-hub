/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');
const logger = getLogger();

function clearTimers(state) {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.timeoutTimer = null;
    state.retryTimer = null;
}

function retryLabel(state) {
    const evt = state.evt;
    return evt.table + ' ' + evt.source_chain + '>=' + evt.from_action_index +
        ' (snapshot ' + evt.snapshot_block + ')';
}

function clearFinalizeRetry(self, id) {
    const state = self.pending.get(id);
    if (!state || state.finalizeRetry !== true) return;
    clearTimers(state);
    self.pending.delete(id);
}

function exhaust(self, state) {
    clearTimers(state);
    if (self.pending.get(state.id) === state) self.pending.delete(state.id);
    self._finalizeRetriesExhausted = (self._finalizeRetriesExhausted || 0) + 1;
    logger.error('RetractionConsensus: signed retraction finalize retry exhausted after ' +
        state.attempts + ' attempts for ' + retryLabel(state) + '; last failure: ' + state.lastReason);
}

function arm(self, state) {
    if (state.retryTimer || self.pending.get(state.id) !== state) return;
    if (state.attempts >= self.finalizeRetryMaxAttempts) return exhaust(self, state);
    const base = self.retrySignReqMs;
    const ceiling = Math.max(base, self.roundTimeoutMs);
    const delay = Math.min(ceiling, base * Math.pow(2, Math.min(state.attempts, 16)));
    state.retryTimer = setTimeout(async () => {
        state.retryTimer = null;
        if (self.pending.get(state.id) !== state) return;
        if (self.finalized.has(state.id)) return arm(self, state);
        state.attempts++;
        try {
            await self.finalize(state.evt, state.canonical, state.id, state.sigs, state.isInitiator);
        } catch (error) {
            self.forgetFinalized(state.id);
            scheduleFinalizeRetry(self, state, error && error.message);
        }
    }, delay);
    if (state.retryTimer.unref) state.retryTimer.unref();
}

function scheduleFinalizeRetry(self, ctx, reason) {
    let state = self.pending.get(ctx.id);
    if (!state || state.finalizeRetry !== true) {
        if (state) clearTimers(state);
        state = {
            id: ctx.id, finalizeRetry: true, done: true,
            evt: ctx.evt, canonical: ctx.canonical, sigs: ctx.sigs,
            isInitiator: ctx.isInitiator, attempts: 0,
            validators: [], signatures: new Map(), timeoutTimer: null, retryTimer: null
        };
        self.pending.set(state.id, state);
    }
    state.lastReason = reason || 'snapshot persist failed';
    self._finalizeDeferrals = (self._finalizeDeferrals || 0) + 1;
    arm(self, state);
}

module.exports = { clearFinalizeRetry, scheduleFinalizeRetry };
