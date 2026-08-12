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

    describe('reserve()/commit()/release() ()', function () {

        it('consumes budget at reserve time, before any send can be awaited', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MAX_PUBLISHES_PER_WINDOW']: '1' });
            const t = g.reserve();
            expect(t).to.be.an('object');
            // The window is already spent for a second caller, though no send has
            // completed and record() was never called: this is the whole point.
            expect(g.allow()).to.equal(false);
            expect(g.reserve()).to.equal(null);
            g.commit(t);
            expect(g.stats().count.inWindow).to.equal(1);
        });

        it('release() hands the budget back so a failed send costs nothing', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MAX_PUBLISHES_PER_WINDOW']: '1' });
            const t = g.reserve();
            expect(g.allow()).to.equal(false);
            g.release(t);
            expect(g.allow()).to.equal(true);
            expect(g.stats().count.inWindow).to.equal(0);
            expect(g.spentInWindow()).to.equal(0);
        });

        it('release() is idempotent and never frees a committed spend', function () {
            const g = new SpendGuard(PFX, { [PFX + '_MAX_PUBLISHES_PER_WINDOW']: '2' });
            const a = g.reserve(), b = g.reserve();
            g.commit(a);
            g.release(b); g.release(b);          // double release frees exactly one slot
            expect(g.stats().count.inWindow).to.equal(1);
            g.release(a);                         // committed: must not be given back
            expect(g.stats().count.inWindow).to.equal(1);
        });

        it('reserves against the USD budget too, and refuses when it would overshoot', function () {
            const g = new SpendGuard(PFX, {
                [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '200',
                [PFX + '_EST_SPEND_USD_CENTS']: '100'
            });
            const a = g.reserve(), b = g.reserve();
            expect(a).to.not.equal(null);
            expect(b).to.not.equal(null);
            expect(g.spentInWindow()).to.equal(200);
            expect(g.reserve()).to.equal(null);   // third would exceed the $2 window budget
            expect(g.stats().blocked.spend).to.be.greaterThan(0);
        });

        it('refuses to reserve while the capability is paused', function () {
            const g = new SpendGuard(PFX, {});
            g.pause('incident');
            expect(g.reserve()).to.equal(null);
            g.resume();
            expect(g.reserve()).to.be.an('object');
        });
    });

    // : both windows were memory-only, so restarting a hub handed every
    // effector its full per-window allowance back - a gate a crash-loop can make
    // spend MORE, which is what this file's first invariant forbids. persistTo() is
    // opt-in BY CALL (from an effector's start()), so a bare constructor stays IO-free.
    describe('#4244 the window survives a restart', function () {
        const fs   = require('fs');
        const os   = require('os');
        const path = require('path');
        let dir, statePath;
        beforeEach(function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-persist-'));
            statePath = path.join(dir, 'nested', 'state.json');
        });
        afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

        // $2 window, $1 per broadcast => exactly two fit; count ceiling 2 as well.
        const cfg = { [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '200',
                      [PFX + '_EST_SPEND_USD_CENTS']: '100',
                      [PFX + '_MAX_PUBLISHES_PER_WINDOW']: '2' };

        it('constructing a guard touches no disk until persistTo() is called', function () {
            const g = new SpendGuard(PFX, cfg);
            g.record();
            expect(fs.existsSync(statePath)).to.equal(false);
            expect(g._statePath).to.equal(null);
        });

        it('a restart inherits the spent budget instead of a fresh allowance', function () {
            const before = new SpendGuard(PFX, cfg).persistTo(statePath);
            before.record(); before.record();
            expect(before.check().ok, 'window is spent before the restart').to.equal(false);

            const after = new SpendGuard(PFX, cfg).persistTo(statePath);   // the "restart"
            expect(after.spentInWindow()).to.equal(200);
            expect(after.check().ok, 'a restart must NOT restore the allowance').to.equal(false);
            expect(after.stats().count.inWindow, 'the count ceiling too').to.equal(2);
        });

        it('a slot handed back is not inherited as a spend', function () {
            const before = new SpendGuard(PFX, cfg).persistTo(statePath);
            const t = before.reserve();
            before.release(t);                                             // the send never went out
            const after = new SpendGuard(PFX, cfg).persistTo(statePath);
            expect(after.spentInWindow()).to.equal(0);
            expect(after.check().ok).to.equal(true);
        });

        it('a reservation the process died holding is inherited as a real spend', function () {
            const before = new SpendGuard(PFX, cfg).persistTo(statePath);
            before.reserve();                                              // crash before commit/release
            const after = new SpendGuard(PFX, cfg).persistTo(statePath);
            expect(after.spentInWindow(), 'the send may well have gone out').to.equal(100);
        });

        it('entries older than the window are dropped on load', function () {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({
                spends: [{ t: Date.now() - (2 * 60 * 60 * 1000), cost: 200 },   // 2h old; window is 1h
                         { t: Date.now(), cost: 100 }]
            }));
            const g = new SpendGuard(PFX, cfg).persistTo(statePath);
            expect(g.spentInWindow()).to.equal(100);
        });

        it('an absent state file is a first run, not a fault', function () {
            const g = new SpendGuard(PFX, cfg).persistTo(statePath);
            expect(g.spentInWindow()).to.equal(0);
            expect(g.check().ok).to.equal(true);
        });

        it('a corrupt state file fails CLOSED: assume the window is spent', function () {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, '{"spends":[{"t":1,');
            const g = new SpendGuard(PFX, cfg).persistTo(statePath);
            expect(g.check().ok, 'a broken store must never read as a green light').to.equal(false);
            expect(g.allow()).to.equal(false);
        });

        it('an unwritable state path never throws on the broadcast path', function () {
            fs.writeFileSync(path.join(dir, 'blocker'), 'x');
            const g = new SpendGuard(PFX, cfg);
            g._statePath = path.join(dir, 'blocker', 'state.json');   // parent is a file, not a dir
            expect(() => g.record()).to.not.throw();
            expect(g.spentInWindow(), 'the in-memory gate still binds').to.equal(100);
        });

        it('defaults the path under ./data when persistTo() is given none', function () {
            const g = new SpendGuard(PFX, cfg, 'SGTEST-LABEL');
            g._loadState = function () {};                            // do not read a real hub file
            g.persistTo();
            // Resolved once, at arm time: a relative default plus a later chdir would
            // split one effector's window across two files, which reads as the very
            // restarting allowance this persistence exists to remove.
            expect(g._statePath).to.equal(path.resolve('./data/spend-state/SGTEST-LABEL.json'));
        });

        // The default has to be overridable the way walPath/queuePath are, and by the
        // same env-then-cfg precedence. Choosing it inside persistTo() left no handle,
        // so every test that reached a real start() wrote a durable window into the
        // checkout and the next run inherited it.
        it('the state path is an overridable property, env over cfg over default', function () {
            const plain = new SpendGuard(PFX, cfg, 'SGTEST-LABEL');
            expect(plain.statePath).to.equal(path.join('./data', 'spend-state', 'SGTEST-LABEL.json'));

            const fromCfg = new SpendGuard(PFX, Object.assign({ [PFX + '_SPEND_STATE_PATH']: statePath }, cfg));
            expect(fromCfg.statePath).to.equal(statePath);

            process.env[PFX + '_SPEND_STATE_PATH'] = path.join(dir, 'from-env.json');
            try {
                const fromEnv = new SpendGuard(PFX, Object.assign({ [PFX + '_SPEND_STATE_PATH']: statePath }, cfg));
                expect(fromEnv.statePath).to.equal(path.join(dir, 'from-env.json'));
            } finally { delete process.env[PFX + '_SPEND_STATE_PATH']; }
        });

        it('persistTo() with no argument writes where the property points, not under ./data', function () {
            const g = new SpendGuard(PFX, cfg);
            g.statePath = statePath;
            g.persistTo();
            g.record();
            expect(fs.existsSync(statePath), 'the override is what got written').to.equal(true);
            const after = new SpendGuard(PFX, cfg);
            after.statePath = statePath;
            after.persistTo();
            expect(after.spentInWindow()).to.equal(100);
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
