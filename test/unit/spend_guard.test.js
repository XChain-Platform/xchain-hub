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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const SpendGuard = require('../../src/lib/spend_guard.js');

const PFX = 'SGTEST';

function clearEnv(){
    for (let k of Object.keys(process.env)){
        if (k.indexOf(PFX + '_') === 0) delete process.env[k];
    }
}

describe('SpendGuard ', function () {

    afterEach(function () {
        clearEnv();
        SpendGuard.unregister(PFX);
        SpendGuard.unregister('SGTEST-LABEL');
    });

    describe('rolling fee-window cap clamped at $2000', function () {

        it('defaults ON at the $2000 hard clamp (config-default-enabled)', function () {
            const g = new SpendGuard(PFX, {});
            expect(g.maxSpendUsdCents).to.equal(200000);
            expect(g.maxSpendUsdCents).to.equal(SpendGuard.HARD_CAP_USD_CENTS);
        });

        it('lets an operator LOWER the cap', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '5000' });
            expect(g.maxSpendUsdCents).to.equal(5000);
        });

        it('CLAMPS any attempt to raise the cap above $2000', function () {
            process.env[PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW'] = '999999999';
            const g = new SpendGuard(PFX, {});
            expect(g.maxSpendUsdCents).to.equal(200000);
        });

        it('blocks the broadcast that would exceed the window budget', function () {
            // cap $2 (200c), est cost $1 (100c) => 2 broadcasts fit, 3rd blocked
            const g = new SpendGuard(PFX, {
                [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '200',
                [PFX + '_EST_SPEND_USD_CENTS']: '100'
            });
            expect(g.check().ok).to.equal(true); g.record();
            expect(g.check().ok).to.equal(true); g.record();
            let r = g.check();
            expect(r.ok).to.equal(false);
            expect(r.reason).to.match(/spend ceiling/i);
        });

        it('tracks ACTUAL per-broadcast cost when the caller supplies it', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '500' });
            g.record(300);
            expect(g.spentInWindow()).to.equal(300);
            // 300 + 250 = 550 > 500 => blocked
            expect(g.check({ cost: 250 }).ok).to.equal(false);
            // 300 + 150 = 450 <= 500 => allowed
            expect(g.check({ cost: 150 }).ok).to.equal(true);
        });

        it('record() only counts sends that actually went out; check() is side-effect free', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '300' });
            g.check(); g.check(); g.check();     // pre-send probes, no spend
            expect(g.spentInWindow()).to.equal(0);
        });
    });

    describe('balance floor', function () {

        it('blocks a null (unreadable) balance fail-closed', function () {
            const g = new SpendGuard(PFX, {});
            let r = g.check({ balance: null });
            expect(r.ok).to.equal(false);
            expect(r.reason).to.match(/unreadable/i);
        });

        it('blocks a balance below the configured floor', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MIN_BALANCE']: '10' });
            expect(g.check({ balance: 9.99 }).ok).to.equal(false);
            expect(g.check({ balance: 10 }).ok).to.equal(true);
        });

        it('skips the floor entirely when no balance is provided (undefined)', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MIN_BALANCE']: '10' });
            expect(g.check().ok).to.equal(true);          // no balance source => not gated on balance
        });
    });

    describe('per-capability runtime pause', function () {

        it('blocks every spend while paused, and resumes cleanly', function () {
            const g = new SpendGuard(PFX, {});
            expect(g.check().ok).to.equal(true);
            g.pause('incident');
            expect(g.isPaused()).to.equal(true);
            let r = g.check();
            expect(r.ok).to.equal(false);
            expect(r.reason).to.match(/PAUSED/);
            g.resume();
            expect(g.check().ok).to.equal(true);
        });

        it('folds the pause into the legacy allow() so the primary path is gated', function () {
            const g = new SpendGuard(PFX, {});
            expect(g.allow()).to.equal(true);
            g.pause();
            expect(g.allow()).to.equal(false);   // fe3aedbf fix: pause reaches allow()-gated primary path
        });

        it('pauses/resumes a specific capability by label via the registry', function () {
            const g = new SpendGuard(PFX, {}, 'SGTEST-LABEL');
            expect(SpendGuard.get('SGTEST-LABEL')).to.equal(g);
            expect(SpendGuard.pauseCapability('SGTEST-LABEL', 'ops')).to.equal(true);
            expect(g.isPaused()).to.equal(true);
            expect(SpendGuard.resumeCapability('SGTEST-LABEL')).to.equal(true);
            expect(g.isPaused()).to.equal(false);
            expect(SpendGuard.pauseCapability('no-such-label')).to.equal(false);
        });
    });

    describe('legacy SpendCeiling drop-in compatibility', function () {

        it('honors the count ceiling via allow()/record()/noteBlocked()', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MAX_PUBLISHES_PER_WINDOW']: '2' });
            expect(g.allow()).to.equal(true); g.record();
            expect(g.allow()).to.equal(true); g.record();
            expect(g.allow()).to.equal(false);
            expect(g.noteBlocked()).to.match(/ceiling/i);
        });
    });

    describe('stats()', function () {
        it('surfaces every gate for operator diagnostics', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MIN_BALANCE']: '5' });
            g.pause('x');
            g.check({ balance: 1 });   // blocked-by-pause increments (pause checked first)
            let s = g.stats();
            expect(s).to.have.property('paused', true);
            expect(s).to.have.property('minBalance', 5);
            expect(s).to.have.property('maxSpendUsdCents', 200000);
            expect(s).to.have.property('hardCapUsdCents', 200000);
            expect(s.blocked).to.have.property('pause');
            expect(s.count).to.be.an('object');
        });
    });
});
