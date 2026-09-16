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
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const SpendGuard = require('../../../../src/lib/spend_guard.js');

const PFX = 'SGTEST';
let dir, statePath;

// $2 window, $1 per broadcast => exactly two fit; count ceiling 2 as well.
const cfg = { [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '200',
              [PFX + '_EST_SPEND_USD_CENTS']: '100',
              [PFX + '_MAX_PUBLISHES_PER_WINDOW']: '2' };

function clearEnv(){
    for (let k of Object.keys(process.env)){
        if (k.indexOf(PFX + '_') === 0) delete process.env[k];
    }
}

describe('SpendGuard', function () {
    afterEach(function () {
        clearEnv();
        SpendGuard.unregister(PFX);
        SpendGuard.unregister('SGTEST-LABEL');
    });

    registerSpendPersistenceSuite();
    registerSpendStatsTests();
});

function registerSpendPersistenceSuite() {
    // both windows were memory-only, so restarting a hub handed every
    // effector its full per-window allowance back - a gate a crash-loop can make
    // spend MORE, which is what this file's first invariant forbids. persistTo() is
    // opt-in BY CALL (from an effector's start()), so a bare constructor stays IO-free.
    describe('#4244 the window survives a restart', function () {
        beforeEach(function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-persist-'));
            statePath = path.join(dir, 'nested', 'state.json');
        });
        afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

        registerSpendPersistenceLoadTests();
        registerSpendPersistenceFailureTests();
        registerSpendPersistencePathTests();
    });
}

function registerSpendPersistenceLoadTests() {
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
}

function registerSpendPersistenceFailureTests() {
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
}

function registerSpendPersistencePathTests() {
        it('defaults the path under ./data when persistTo() is given none', function () {
            const g = new SpendGuard(PFX, cfg, 'SGTEST-LABEL');
            g.loadState = function () {};                            // do not read a real hub file
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
}

function registerSpendStatsTests() {
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
}
