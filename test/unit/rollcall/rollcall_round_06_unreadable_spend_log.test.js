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
 * XChain Hub - RollcallRound: a spend log that cannot be read at boot.
 *
 * Only a missing file is an empty log. A read that fails with anything else leaves
 * the committed set empty, so the engine must refuse every publish until a later
 * read succeeds, or a restart pays a second fee for an epoch the log already holds.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { EPOCH, makeBroadcaster, makeEngine, makeState, tick } = require('../../helpers/rollcall_publish_venue.js');

const ctx = { dir: null, read: null };

// Fails every read of this case's spend log with the given code; other reads pass through.
function failSpendLogReads(code) {
    const real = fs.readFileSync;
    const target = path.join(ctx.dir, 'spend.jsonl');
    ctx.read = sinon.stub(fs, 'readFileSync').callsFake(function (p, ...rest) {
        if (p === target) throw Object.assign(new Error(code + ' on read'), { code });
        return real.call(fs, p, ...rest);
    });
}

describe('RollcallRound unreadable spend log', function () {
    beforeEach(function () { ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-unread-')); });
    afterEach(function () { sinon.restore(); fs.rmSync(ctx.dir, { recursive: true, force: true }); });
    registerReadFaultTests();
    registerRecoveryTests();
});

function registerReadFaultTests() {
    it('a missing spend log is an empty log and publishes', async function () {
        let b = makeBroadcaster([]);
        let eng = makeEngine(ctx.dir, b.fn, new Set());
        expect(eng._spendLogUnread).to.equal(false);
        await tick(eng, makeState());
        expect(b.calls.length).to.equal(2);
    });

    it('a read fault other than ENOENT blocks every publish for an epoch the log already holds', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(2);

        failSpendLogReads('EIO');
        let second = makeEngine(ctx.dir, b.fn, landed);
        expect(second._spendLogUnread).to.equal(true);
        await tick(second, makeState());
        expect(b.calls.length).to.equal(2, 'an unread log must never pass for an empty one');
    });

}

function registerRecoveryTests() {
    it('advance skips the publish pass while the log is unread, then honours the log once it reads', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(2);

        failSpendLogReads('EMFILE');
        let second = makeEngine(ctx.dir, b.fn, landed);
        let tipBlock = EPOCH + Math.max(second.publishDelayBlocks, second.selfPublishBlocks);
        await second.advance(makeState(), tipBlock);
        expect(second._spendLogUnread).to.equal(true);
        expect(b.calls.length).to.equal(2);

        ctx.read.restore();
        await second.advance(makeState(), tipBlock);
        expect(second._spendLogUnread).to.equal(false);
        expect(second._committed.size).to.be.greaterThan(0, 'the late read restored the committed set');
        expect(b.calls.length).to.equal(2, 'the committed epoch is not paid for again');
    });

    it('the refusal releases the slot, so the publish runs once the log reads and nothing is committed', async function () {
        let b = makeBroadcaster([]);
        failSpendLogReads('EIO');
        let eng = makeEngine(ctx.dir, b.fn, new Set());
        let state = makeState();
        await tick(eng, state);
        expect(b.calls.length).to.equal(0);
        expect(state.published).to.equal(false);
        expect(eng._committed.has(String(EPOCH))).to.equal(false);

        ctx.read.restore();
        expect(eng.spendLogReady()).to.equal(true);
        await tick(eng, state);
        expect(b.calls.length).to.equal(2);
    });
}
