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
 * XChain Hub - Attestation Spot-Check Injection
 *
 * The live spot-check queue and the scheduler that fills it. A registered
 * request_id is what makes a finalization judgeable at all (see judge.js), and
 * on an opted-in hub the scheduler is what puts entries there, by asking the
 * hub's injector to emit a corpus prompt as a real on-chain ATTEST v0 request.
 *
 ********************************************************************/

'use strict';
const { getLogger } = require('../../observability');
const logger = getLogger();

const MAX_QUEUE_SIZE              = 1024;

module.exports = {

    // Register a synthetic request as a spot-check. Called by the
    // (future) injection scheduler immediately after the synthetic
    // ATTEST v0 (request) is broadcast. `expectedPattern` is the rubric
    // passed to the provider's judge step (string for now).
    register(requestId, providerId, expectedPattern){
        let rid = String(requestId || '').toLowerCase();
        if (!rid || !providerId) return;
        if (this._queue.size >= MAX_QUEUE_SIZE) {
            // Drop oldest by insertion order (Map preserves insertion order)
            let firstKey = this._queue.keys().next().value;
            if (firstKey) this._queue.delete(firstKey);
        }
        this._queue.set(rid, {
            providerId:      String(providerId),
            expectedPattern: String(expectedPattern || ''),
            registeredAt:    Date.now()
        });
    },

    // Check whether a request_id is being spot-checked.
    isSpotCheck(requestId){
        return this._queue.has(String(requestId || '').toLowerCase());
    },

    // Start the injection scheduler when opted in and fully wired. Silent no-op
    // otherwise (the module still judges externally-registered spot-checks).
    startScheduler(){
        if (this._scheduler) return;
        if (!this.schedulerEnabled) return;
        if (!this._injector) {
            logger.info('AttestationSpotChecker: SPOT_CHECK_ENABLED but no injector wired; scheduler idle');
            return;
        }
        if (this.corpus.length === 0) {
            logger.info('AttestationSpotChecker: SPOT_CHECK_ENABLED but corpus empty; scheduler idle');
            return;
        }
        this._scheduler = setInterval(() => {
            this.schedulerTick().catch(err =>
                logger.warn('AttestationSpotChecker: scheduler tick error: ' + (err && err.message ? err.message : err)));
        }, this.intervalMs);
        if (this._scheduler.unref) this._scheduler.unref();  // never pin process liveness
        logger.info('AttestationSpotChecker scheduler started (interval=' + this.intervalMs +
                    'ms, corpus=' + this.corpus.length + ', maxPerTick=' + this.maxPerTick + ')');
    },

    // One scheduler pass: inject up to maxPerTick synthetic requests, round-
    // robin over the corpus. Each injection is independently guarded so a single
    // provider/encoder failure cannot abort the batch or throw out of the timer.
    async schedulerTick(){
        if (!this._injector || this.corpus.length === 0) return 0;
        // Scheduler self-overlap guard (house convention:
        // FullNodeChallengeRound.tick). The injector is an operator-supplied hook that
        // emits a real on-chain ATTEST v0 request, and nothing here bounds its round
        // trip, so a hung encoder/BTC send parks a tick until the socket dies and the
        // next interval fires on top of it. The backpressure test below cannot stop the
        // second tick: both read _queue before either registers anything, so injections
        // land past the headroom it reserves and evict LIVE entries (register() drops the
        // oldest, a real validator's pending spot-check, whose verdict then never scores),
        // and the fee-bearing batch runs at twice its configured rate. The finally is
        // load-bearing: only this timer ever clears the flag, so a throw out of the body
        // would wedge the scheduler for the process lifetime.
        if (this._tickInFlight) {
            logger.warn('AttestationSpotChecker: injection tick still in flight; skipping this scheduler pass');
            return 0;
        }
        // Backpressure: leave headroom so injections never evict live entries.
        if (this._queue.size >= Math.floor(MAX_QUEUE_SIZE * 0.9)) {
            logger.warn('AttestationSpotChecker: spot-check queue near capacity, skipping injection tick');
            return 0;
        }
        this._tickInFlight = true;
        try {
            let injected = 0;
            let n = Math.min(this.maxPerTick, this.corpus.length);
            for (let i = 0; i < n; i++) {
                let entry = this.corpus[this._corpusCursor % this.corpus.length];
                this._corpusCursor = (this._corpusCursor + 1) % this.corpus.length;
                try {
                    let res = await this._injector({
                        providerId:      entry.providerId,
                        prompt:          entry.prompt,
                        expectedPattern: entry.expectedPattern
                    });
                    let requestId = (res && (res.requestId || res.request_id))
                        || (typeof res === 'string' ? res : null);
                    if (!requestId) {
                        logger.warn('AttestationSpotChecker: injector returned no request_id for provider ' + entry.providerId);
                        continue;
                    }
                    this.register(requestId, entry.providerId, entry.expectedPattern);
                    this._injectedCount++;
                    injected++;
                } catch (e) {
                    logger.warn('AttestationSpotChecker: injection failed for provider ' + entry.providerId + ': ' +
                                 (e && e.message ? e.message : e));
                }
            }
            return injected;
        } finally {
            this._tickInFlight = false;
        }
    }

};
