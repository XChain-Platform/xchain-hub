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

const { expect }   = require('chai');
const SpendCeiling = require('../../src/lib/spend_ceiling.js');

describe('SpendCeiling (item 2676)', function () {

    afterEach(function () {
        delete process.env.TESTPFX_MAX_PUBLISHES_PER_WINDOW;
        delete process.env.TESTPFX_SPEND_WINDOW_MS;
    });

    it('is disabled by default (no cap configured) and always allows', function () {
        const sc = new SpendCeiling('TESTPFX', {});
        expect(sc.disabled).to.equal(true);
        for (let i = 0; i < 100; i++) { expect(sc.allow()).to.equal(true); sc.record(); }
    });

    it('reads maxPerWindow / windowMs from env', function () {
        process.env.TESTPFX_MAX_PUBLISHES_PER_WINDOW = '3';
        process.env.TESTPFX_SPEND_WINDOW_MS = '5000';
        const sc = new SpendCeiling('TESTPFX', {});
        expect(sc.disabled).to.equal(false);
        expect(sc.maxPerWindow).to.equal(3);
        expect(sc.windowMs).to.equal(5000);
    });

    it('reads config fallback when env is unset', function () {
        const sc = new SpendCeiling('TESTPFX', { TESTPFX_MAX_PUBLISHES_PER_WINDOW: '2' });
        expect(sc.maxPerWindow).to.equal(2);
    });

    it('allows up to the cap then blocks within the window', function () {
        const sc = new SpendCeiling('TESTPFX', { TESTPFX_MAX_PUBLISHES_PER_WINDOW: '2', TESTPFX_SPEND_WINDOW_MS: '100000' });
        const t = 1000000;
        expect(sc.allow(t)).to.equal(true);      sc.record(t);
        expect(sc.allow(t)).to.equal(true);      sc.record(t);
        expect(sc.allow(t)).to.equal(false);     // cap reached
        expect(sc.countInWindow(t)).to.equal(2);
    });

    it('frees budget once older spends fall outside the window', function () {
        const sc = new SpendCeiling('TESTPFX', { TESTPFX_MAX_PUBLISHES_PER_WINDOW: '1', TESTPFX_SPEND_WINDOW_MS: '1000' });
        const t0 = 5000;
        sc.record(t0);
        expect(sc.allow(t0)).to.equal(false);          // within window, at cap
        expect(sc.allow(t0 + 1001)).to.equal(true);    // t0 spend aged out
    });

    it('record() is a no-op when disabled, so a disabled ceiling never blocks', function () {
        const sc = new SpendCeiling('TESTPFX', {});
        sc.record(); sc.record();
        expect(sc.allow()).to.equal(true);
        expect(sc.countInWindow()).to.equal(0);
    });

    it('noteBlocked increments blockedCount and returns an actionable message', function () {
        const sc = new SpendCeiling('TESTPFX', { TESTPFX_MAX_PUBLISHES_PER_WINDOW: '1' });
        sc.record();
        const msg = sc.noteBlocked();
        expect(sc.blockedCount).to.equal(1);
        expect(msg).to.match(/spend ceiling reached/);
    });

    it('rejects a negative / non-numeric cap as disabled', function () {
        expect(new SpendCeiling('TESTPFX', { TESTPFX_MAX_PUBLISHES_PER_WINDOW: '-5' }).disabled).to.equal(true);
        expect(new SpendCeiling('TESTPFX', { TESTPFX_MAX_PUBLISHES_PER_WINDOW: 'abc' }).disabled).to.equal(true);
    });
});
