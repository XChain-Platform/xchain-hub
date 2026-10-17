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

// An operator pause lived only in memory, so any restart (crash, Restart=, deploy,
// OOM kill) rebuilt every guard unpaused and spending resumed with no log line.

const { expect } = require('chai');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const SpendGuard = require('../../../../src/lib/spend_guard.js');
const SpendAudit = require('../../../../src/providers/llm/spend.js');
const { buildAnchorRpc } = require('../../../../src/api/rpc/anchor.js');

const PFX = 'SGPAUSE';
const cfg = { [PFX + '_MAX_SPEND_USD_CENTS_PER_WINDOW']: '500', [PFX + '_EST_SPEND_USD_CENTS']: '100' };
let dir, statePath;

function fresh(){ return new SpendGuard(PFX, cfg); }
function readState(){ return JSON.parse(fs.readFileSync(statePath, 'utf8')); }

// A temp store per test, and the registry entry dropped after it.
function useTempStore(){
    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-pause-'));
        statePath = path.join(dir, 'state.json');
    });
    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
        SpendGuard.unregister(PFX);
    });
}

describe('SpendGuard operator pause across a restart', function () {
    useTempStore();

    describe('the pause is saved with the spend window', function () {
        it('a restarted guard comes back paused with the same reason, and every gate refuses', function () {
            fresh().persistTo(statePath).pause('bad fee oracle');
            const after = fresh().persistTo(statePath);
            expect(after.isPaused()).to.equal(true);
            expect(after.pauseReason).to.equal('bad fee oracle');
            expect(after.check().ok).to.equal(false);
            expect(after.allow()).to.equal(false);
            expect(after.reserve()).to.equal(null);
        });

        it('a resume before the restart leaves the restarted guard spending', function () {
            const before = fresh().persistTo(statePath);
            before.pause('drill');
            before.resume();
            const after = fresh().persistTo(statePath);
            expect(after.isPaused()).to.equal(false);
            expect(after.check().ok).to.equal(true);
        });

        it('a pause on an unarmed guard touches no disk and still refuses', function () {
            const g = fresh();
            expect(g.pause('incident')).to.equal(true);
            expect(fs.existsSync(statePath)).to.equal(false);
            expect(g.check().ok).to.equal(false);
        });
    });
});

describe('SpendGuard operator pause across a restart', function () {
    useTempStore();

    describe('the restore rules', function () {
        it('a file written before pauses were saved restores unpaused, spends intact', function () {
            fs.writeFileSync(statePath, JSON.stringify({ label: PFX, windowMs: 3600000, savedAt: Date.now(),
                spends: [{ t: Date.now() - 1000, cost: 100 }] }));
            const g = fresh().persistTo(statePath);
            expect(g.isPaused()).to.equal(false);
            expect(g.spentInWindow()).to.equal(100);
        });

        it('a restore never clears a pause raised before persistTo(), and writes it down', function () {
            fs.writeFileSync(statePath, JSON.stringify({ label: PFX, windowMs: 3600000, savedAt: Date.now(),
                spends: [], paused: false, pauseReason: null }));
            const g = fresh();
            g.pause('early incident');
            g.persistTo(statePath);
            expect(g.isPaused()).to.equal(true);
            expect(readState().paused).to.equal(true);
            expect(readState().pauseReason).to.equal('early incident');
        });

        it('a corrupt file restores unpaused with the window seeded consumed', function () {
            fs.writeFileSync(statePath, '{"label":"SGPAUSE","spends":[{"t":');
            const g = fresh().persistTo(statePath);
            expect(g.isPaused()).to.equal(false);
            expect(g.check().ok, 'the consumed window still refuses').to.equal(false);
        });
    });
});

describe('SpendGuard operator pause across a restart', function () {
    describe('a pause the store cannot record', function () {
        it('still holds in memory and reports the write failed', function () {
            const blocker = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-pause-ro-'));
            const g = fresh().persistTo(path.join(blocker, 'state.json'));
            // A regular file where the store's directory should be: the write fails with ENOTDIR.
            fs.writeFileSync(path.join(blocker, 'not-a-dir'), '');
            g._statePath = path.join(blocker, 'not-a-dir', 'state.json');
            expect(g.pause('incident')).to.equal(false);
            expect(g.isPaused()).to.equal(true);
            expect(g.check().ok).to.equal(false);
            fs.rmSync(blocker, { recursive: true, force: true });
            SpendGuard.unregister(PFX);
        });
    });
});

describe('SpendGuard operator pause across a restart', function () {
    describe('the LLM guard rebuild', function () {
        const audit = () => new SpendAudit({ SpendGuard, hubConfig: null, logger: console });
        afterEach(function () { SpendGuard.unregister('llm'); });

        it('armSpendGuard() keeps a pause raised on the guard it replaces', function () {
            const a = audit();
            a.spendGuard().pause('vendor incident');
            const g = a.armSpendGuard({}, false);
            expect(g.isPaused()).to.equal(true);
            expect(g.pauseReason).to.equal('vendor incident');
        });

        it('a persisted LLM pause survives the rebuild and the restart', function () {
            const llmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-pause-llm-'));
            const cfgPath = { LLM_SPEND_STATE_PATH: path.join(llmDir, 'llm.json') };
            const a = audit();
            a.armSpendGuard(cfgPath, true).pause('vendor incident');
            const restarted = audit().armSpendGuard(cfgPath, true);
            expect(restarted.isPaused()).to.equal(true);
            fs.rmSync(llmDir, { recursive: true, force: true });
        });
    });
});

describe('SpendGuard operator pause across a restart', function () {
    describe('the pause RPC', function () {
        afterEach(function () { SpendGuard.unregister(PFX); });

        it('says whether the pause will survive a restart', async function () {
            const pauseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-pause-rpc-'));
            const rpc = buildAnchorRpc({ hub: {} });
            fresh();
            expect(await rpc.pauseeffectorspend({ label: PFX })).to.deep.equal({ status: 'paused', label: PFX, durable: false });
            fresh().persistTo(path.join(pauseDir, 'state.json'));
            expect(await rpc.pauseeffectorspend({ label: PFX })).to.deep.equal({ status: 'paused', label: PFX, durable: true });
            expect(await rpc.resumeeffectorspend({ label: PFX })).to.deep.equal({ status: 'resumed', label: PFX, durable: true });
            expect(await rpc.pauseeffectorspend({ label: 'NO-SUCH' })).to.have.property('error');
            fs.rmSync(pauseDir, { recursive: true, force: true });
        });
    });
});
