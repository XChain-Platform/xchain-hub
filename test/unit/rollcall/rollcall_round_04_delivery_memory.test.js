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
 * XChain Hub - RollcallRound: what a restart, a refusing pipeline and a reorg
 * do to the roll-call publish.
 *
 * A fifty-signature epoch publishes as two chunks. The broadcaster is a scripted
 * stand-in that records every payload it is asked to pay for, and the DOGE read
 * answers from a set of landed pubkeys the test controls. A restart is a second
 * engine over the same spend log, with a freshly rebuilt round, which is what a
 * hub process gets after it comes back inside the accept window.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { EPOCH, MY_PK, LEDGER_HASH, makeBroadcaster, makeEngine, makeState, tick, spendLog,
        paidTwice } = require('../../helpers/rollcall_publish_venue.js');

// One scratch directory per case, shared by the registered groups below.
const ctx = { dir: null };

describe('RollcallRound delivery memory', function () {
    beforeEach(function () { ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-delivery-')); });
    afterEach(function () { fs.rmSync(ctx.dir, { recursive: true, force: true }); });
    registerRestartTests();
    registerFailureTests();
    registerReorgTests();
});

function registerRestartTests() {
    it('does not self-publish after a restart when its own signature rode the sweep', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(2);

        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(2);
        expect(paidTwice(b.calls)).to.deep.equal([]);
    });

    it('publishes only the unsent tail after a restart that follows a refused chunk', async function () {
        let b = makeBroadcaster(['ok', 'refuse']);
        let landed = new Set();
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        let firstChunk = b.calls[0];
        for (let pk of firstChunk) landed.add(pk);

        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        let tail = b.calls[b.calls.length - 1];
        expect(b.calls.length).to.equal(3);
        expect(tail.length).to.equal(50 - firstChunk.length);
        expect(tail.filter(pk => firstChunk.includes(pk))).to.deep.equal([]);
    });

    it('resumes the chunks a crash never reached, and never the one in flight', async function () {
        // A crash during chunk 1 leaves only the intent line with its chunk plan.
        let probe = makeBroadcaster([]);
        let plan = [];
        {
            let scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-plan-'));
            await tick(makeEngine(scratch, probe.fn, new Set()), makeState());
            plan = spendLog(scratch).find(r => r.phase === 'intent' && r.kind === 'sweep').plan;
            fs.rmSync(scratch, { recursive: true, force: true });
        }
        expect(plan).to.have.length(2);
        fs.writeFileSync(path.join(ctx.dir, 'spend.jsonl'), JSON.stringify({
            ts: 1, effector: 'ROLLCALL_PUBLISH', pubkey: MY_PK, phase: 'intent', epoch: EPOCH, kind: 'sweep',
            pairs: 50, chunks: 2, ledger_hash: LEDGER_HASH, plan
        }) + '\n');

        let b = makeBroadcaster([]);
        await tick(makeEngine(ctx.dir, b.fn, new Set()), makeState());
        expect(b.calls).to.deep.equal([plan[1]]);
    });
}

function registerFailureTests() {

    it('records the funding and reveal of a send that failed after money moved, and does not pay again', async function () {
        let b = makeBroadcaster(['fundsCommitted']);
        await tick(makeEngine(ctx.dir, b.fn, new Set()), makeState());

        let ambiguous = spendLog(ctx.dir).find(r => r.phase === 'ambiguous');
        expect(ambiguous).to.include({ phase1Txid: 'aa'.repeat(32), revealTxid: 'bb'.repeat(32),
                                       revealTxHex: '0200deadbeef', txid: 'bb'.repeat(32) });
        // The own signature rode the failed chunk, so the self-publish does not pay for it twice.
        expect(b.calls.length).to.equal(1);
    });

    it('backs a refusing pipeline off instead of retrying both roles every tick', async function () {
        let b = makeBroadcaster(['429', '429', '429', '429', '429', '429']);
        let eng = makeEngine(ctx.dir, b.fn, new Set());
        let state = makeState();
        for (let i = 0; i < 6; i++) await tick(eng, state);
        // Failures on ticks 1, 2 and 4; the self-publish waits out the same clock.
        expect(b.calls.length).to.equal(3);
    });

    it('stops sweeping an epoch after its attempt bound and says so on disk', async function () {
        let b = makeBroadcaster(new Array(200).fill('429'));
        let eng = makeEngine(ctx.dir, b.fn, new Set());
        let state = makeState();
        for (let i = 0; i < 100; i++) await tick(eng, state);
        let sweeps = b.calls.filter(pks => pks.length > 1).length;
        expect(sweeps).to.equal(8);
        expect(spendLog(ctx.dir).filter(r => r.phase === 'abandoned')).to.have.length(1);
    });
}

function registerReorgTests() {

    it('republishes signatures a reorg removed once they stay off chain for the DOGE wait', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 199;
        let eng = makeEngine(ctx.dir, b.fn, landed);
        let state = makeState();
        await tick(eng, state);
        for (let pk of state.sigs.keys()) landed.add(pk);
        await tick(eng, state);           // the read shows the publish landed
        expect(b.calls.length).to.equal(2);

        landed.clear();                   // a reorg takes it back off chain
        landed.tip = 200;
        await tick(eng, state);           // first missed read: the wait starts
        landed.tip = 202;
        await tick(eng, state);           // two blocks on: still inside the regtest wait
        expect(b.calls.length).to.equal(2);
        landed.tip = 203;
        await tick(eng, state);           // three blocks absent: republished
        expect(b.calls.length).to.be.greaterThan(2);
        let again = new Set([].concat(...b.calls.slice(2)));
        expect(again.size).to.equal(50);
        let phases = spendLog(ctx.dir).map(r => r.phase);
        expect(phases).to.include('landed');
        expect(phases).to.include('reorged');
    });

    it('does not republish a publish the chain has not shown yet', async function () {
        let b = makeBroadcaster([]);
        let eng = makeEngine(ctx.dir, b.fn, new Set());
        let state = makeState();
        for (let i = 0; i < 4; i++) await tick(eng, state);
        expect(b.calls.length).to.equal(2);
    });
}
