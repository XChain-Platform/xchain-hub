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
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const {
    createUpstreamBudget, resolveProofRpm, upstreamRetryAfterMs
} = require('../../../../src/api/rest/capability_snapshot_proof/upstream_budget.js');

const BTC_INDEXER_LIMIT_RPM = 600;
// The per-client pacing an LTC or DOGE bootstrap used when hb75 measured it.
const CLIENT_INTERVAL_MS = 110;

// Drive one shared budget with several clients on a fake clock. Each client asks
// again CLIENT_INTERVAL_MS after its last answer, waits for a granted slot, and
// honors the Retry-After of a refusal. Returns every upstream start time.
function simulate(budgetOptions, clientCount, durationMs) {
    let clock = 0;
    const budget = createUpstreamBudget({ ...budgetOptions, now: () => clock });
    const nextAsk = Array.from({ length: clientCount }, () => 0);
    const starts = [];
    const refusals = Array.from({ length: clientCount }, () => 0);
    const grants = Array.from({ length: clientCount }, () => 0);
    for (;;) {
        let client = 0;
        for (let i = 1; i < clientCount; i++) if (nextAsk[i] < nextAsk[client]) client = i;
        if (nextAsk[client] >= durationMs) break;
        clock = nextAsk[client];
        const slot = budget.reserve();
        if (slot.ok) {
            starts.push(clock + slot.waitMs);
            grants[client]++;
            nextAsk[client] = clock + slot.waitMs + CLIENT_INTERVAL_MS;
        } else {
            refusals[client]++;
            nextAsk[client] = clock + slot.retryAfterS * 1000;
        }
    }
    starts.sort((a, b) => a - b);
    return { starts, grants, refusals };
}

function maxInAnyWindow(starts, windowMs) {
    let max = 0;
    let lo = 0;
    for (let hi = 0; hi < starts.length; hi++) {
        while (starts[hi] - starts[lo] >= windowMs) lo++;
        max = Math.max(max, hi - lo + 1);
    }
    return max;
}

describe('capability proof upstream budget', function () {
    it('keeps two concurrent bootstraps through one hub under the BTC indexer per-IP limit', function () {
        const rpm = resolveProofRpm({});
        const { starts, grants } = simulate({ rpm }, 2, 10 * 60000);

        // Unbudgeted, two clients at this pacing send about 1090 a minute.
        expect(Math.floor(2 * 60000 / CLIENT_INTERVAL_MS)).to.be.above(BTC_INDEXER_LIMIT_RPM);
        const peak = maxInAnyWindow(starts, 60000);
        expect(peak).to.be.at.most(rpm + 4);
        expect(peak).to.be.below(BTC_INDEXER_LIMIT_RPM);
        // The budget is spent, not idled: about rpm a minute over ten minutes.
        expect(starts.length).to.be.at.least(10 * rpm);
        // Neither client is starved by the other.
        expect(Math.min(...grants)).to.be.at.least(Math.floor(0.4 * starts.length));
    });

    it('bounds the combined rate for more clients than the budget was sized for', function () {
        const { starts } = simulate({ rpm: 300 }, 5, 5 * 60000);
        expect(maxInAnyWindow(starts, 60000)).to.be.at.most(304);
    });

    it('refuses with a Retry-After once the next slot is past the wait bound', function () {
        let clock = 1000000;
        const budget = createUpstreamBudget({ rpm: 60, burst: 2, maxWaitMs: 1500, now: () => clock });
        expect(budget.reserve()).to.deep.equal({ ok: true, waitMs: 0 });
        expect(budget.reserve()).to.deep.equal({ ok: true, waitMs: 0 });
        expect(budget.reserve()).to.deep.equal({ ok: true, waitMs: 1000 });
        expect(budget.reserve()).to.deep.equal({ ok: false, retryAfterS: 2 });
        clock += 2000;
        expect(budget.reserve()).to.deep.equal({ ok: true, waitMs: 0 });
    });

    it('stops granting slots for the Retry-After an upstream 429 gave', function () {
        let clock = 0;
        const budget = createUpstreamBudget({ rpm: 600, maxWaitMs: 1000, now: () => clock });
        budget.pauseFor(7000);
        expect(budget.reserve()).to.deep.equal({ ok: false, retryAfterS: 7 });
        clock = 6500;
        expect(budget.reserve()).to.deep.equal({ ok: true, waitMs: 500 });
    });

    it('reads its budget from config, half the BTC indexer limit by default and never above it', function () {
        expect(resolveProofRpm({})).to.equal(300);
        expect(resolveProofRpm({ BTC_INDEXER_RATE_LIMIT_RPM: '1200' })).to.equal(600);
        expect(resolveProofRpm({ HUB_CAPABILITY_PROOF_RPM: '450' })).to.equal(450);
        expect(resolveProofRpm({ HUB_CAPABILITY_PROOF_RPM: '900' })).to.equal(600);
        expect(resolveProofRpm({ HUB_CAPABILITY_PROOF_RPM: 'junk' })).to.equal(300);
    });

    it('reads the wait from an upstream 429 and ignores every other failure', function () {
        const now = () => Date.parse('2026-10-22T00:00:00Z');
        const refused = headers => ({ response: { status: 429, headers } });
        expect(upstreamRetryAfterMs(refused({ 'retry-after': '12' }), now)).to.equal(12000);
        expect(upstreamRetryAfterMs(refused({ 'retry-after': 'Thu, 22 Oct 2026 00:00:05 GMT' }), now))
            .to.equal(5000);
        expect(upstreamRetryAfterMs(refused({}), now)).to.equal(10000);
        expect(upstreamRetryAfterMs({ response: { status: 503, headers: {} } }, now)).to.equal(null);
        expect(upstreamRetryAfterMs(new Error('offline'), now)).to.equal(null);
    });
});
