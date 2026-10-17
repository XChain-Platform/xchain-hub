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
 * XChain Hub - RollcallRound: the DOGE-block wait before paying again, and a spend
 * log that a crash or a restored copy has damaged.
 *
 * A reorg returns this hub's publish to the mempool, where it is normally re-mined
 * within a block or two, so nothing is paid again until the signatures have stayed
 * off a trusted read for the network's wait (regtest: 3 DOGE blocks, counted on the
 * read's tip_block_index). The own signature is rescued once by the self-publish by
 * the same rule, whatever the delivery memory says. A duplicated or torn spend-log
 * line cannot make a restart pay for a chunk twice or skip one.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { EPOCH, MY_PK, LEDGER_HASH, makeBroadcaster, makeEngine, makeState, tick, spendLog,
        paidTwice } = require('../../helpers/rollcall_publish_venue.js');

const ctx = { dir: null };

describe('RollcallRound DOGE-block reorg wait and damaged spend log', function () {
    beforeEach(function () { ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-reorg-wait-')); });
    afterEach(function () { fs.rmSync(ctx.dir, { recursive: true, force: true }); });
    registerWaitTests();
    registerTipFloorTests();
    registerRescueTests();
    registerRescueRetryTests();
    registerDamagedLogTests();
});

// A publish the chain showed landed, on an engine whose read then reports `landed`.
async function landedPublish(b, landed) {
    let eng = makeEngine(ctx.dir, b.fn, landed);
    let state = makeState();
    await tick(eng, state);
    for (let pk of state.sigs.keys()) landed.add(pk);
    await tick(eng, state);
    return { eng, state };
}

function registerWaitTests() {
    it('pays nothing again when the reorged original is re-mined inside the wait', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 100;
        let { eng, state } = await landedPublish(b, landed);
        let all = Array.from(landed);
        landed.clear();
        landed.tip = 101;
        await tick(eng, state);               // missed: the wait starts
        for (let pk of all) landed.add(pk);   // the original is re-mined
        landed.tip = 102;
        await tick(eng, state);
        landed.tip = 130;
        await tick(eng, state);
        expect(b.calls.length).to.equal(2);
        expect(spendLog(ctx.dir).map(r => r.phase)).to.not.include('reorged');
    });

    it('pays nothing again when the read carries no DOGE tip to count the wait on', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();               // no `tip`: every answer reports null
        let { eng, state } = await landedPublish(b, landed);
        landed.clear();
        for (let i = 0; i < 5; i++) await tick(eng, state);
        expect(b.calls.length).to.equal(2);
        expect(spendLog(ctx.dir).map(r => r.phase)).to.include('landed');
    });
}

// A publish the chain showed landed at DOGE tip 500, then an indexer that reports tips
// from 100 upward (a resync, a restored database, a lagging replica) and cannot see it.
async function regressedIndexer(b, landed, eng, state) {
    let all = Array.from(landed);
    landed.clear();
    for (let tip = 100; tip <= 110; tip++) { landed.tip = tip; await tick(eng, state); }
    for (let pk of all) landed.add(pk);
    landed.tip = 500;
    await tick(eng, state);
}

function registerTipFloorTests() {
    it('pays nothing again while the indexer reports a tip below where the signatures landed', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 500;
        let { eng, state } = await landedPublish(b, landed);
        await regressedIndexer(b, landed, eng, state);
        expect(b.calls.length).to.equal(2);
        expect(spendLog(ctx.dir).map(r => r.phase)).to.not.include.members(['reorged', 'rescue']);
    });

    it('keeps the landed tip across a restart, so a regressed indexer after it pays nothing', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 500;
        await landedPublish(b, landed);
        expect(spendLog(ctx.dir).find(r => r.phase === 'landed').tip).to.equal(500);
        await regressedIndexer(b, landed, makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(2);
    });

    it('republishes a reorged publish once, own signature included, with no separate rescue', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 100;
        let { eng, state } = await landedPublish(b, landed);
        landed.clear();                       // orphaned for good
        landed.perRead = 1;                   // every read sees one more block
        for (let i = 0; i < 10 && b.calls.length < 4; i++) await tick(eng, state);
        expect(b.calls.length).to.equal(4);   // the sweep's two chunks, and nothing beside them
        expect(paidTwice(b.calls.slice(2))).to.deep.equal([]);
        expect(new Set([].concat(...b.calls.slice(2))).size).to.equal(50);
        expect(spendLog(ctx.dir).map(r => r.phase)).to.not.include('rescue');
    });

    it('still republishes after the wait when the tip never goes below the landed tip', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 500;
        let { eng, state } = await landedPublish(b, landed);
        for (let tip of [501, 502]) { landed.tip = tip; await tick(eng, state); }   // steady, still landed
        expect(b.calls.length).to.equal(2);
        landed.clear();                                                       // orphaned for good
        for (let tip of [503, 504, 505]) { landed.tip = tip; await tick(eng, state); }
        expect(b.calls.length).to.equal(2);
        landed.tip = 506;
        await tick(eng, state);
        expect(b.calls.length).to.equal(4);
    });
}

function registerRescueTests() {
    it('counts the own-signature wait from the first missing read, before the self-publish deadline', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 50;
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        let eng = makeEngine(ctx.dir, b.fn, landed);
        let state = makeState();
        for (let tip of [100, 101, 102, 103]) {           // early ticks: only the sweep role runs
            landed.tip = tip;
            await eng.maybePublish(state, MY_PK, eng.publishDelayBlocks);
        }
        expect(b.calls.length).to.equal(2);
        await eng.maybeSelfPublish(state, MY_PK, eng.selfPublishBlocks);   // the deadline: rescued at once
        expect(b.calls.slice(2)).to.deep.equal([[MY_PK]]);
    });

    it('restarts the own-signature wait when a reorg republish carries it again', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 100;
        let { eng, state } = await landedPublish(b, landed);
        landed.clear();                       // reorged out for good
        for (let tip of [101, 102, 103, 104]) { landed.tip = tip; await tick(eng, state); }
        expect(b.calls.length).to.equal(4);   // the sweep republished both chunks, own signature included
        for (let tip of [105, 106]) { landed.tip = tip; await tick(eng, state); }
        expect(b.calls.length).to.equal(4);
        expect(paidTwice(b.calls.slice(2))).to.deep.equal([]);
    });

    it('rescues an own signature its sweep carried once it has stayed off chain, once', async function () {
        let b = makeBroadcaster([]);
        let landed = new Set();
        landed.tip = 50;
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(2);

        let eng = makeEngine(ctx.dir, b.fn, landed);   // a restart; the publish never landed
        let state = makeState();
        landed.tip = 100;
        await tick(eng, state);
        landed.tip = 102;
        await tick(eng, state);
        expect(b.calls.length).to.equal(2);
        landed.tip = 103;
        await tick(eng, state);
        expect(b.calls.slice(2)).to.deep.equal([[MY_PK]]);
        landed.tip = 120;
        await tick(eng, state);
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(3);
        expect(spendLog(ctx.dir).filter(r => r.phase === 'rescue')).to.have.length(1);
    });
}

// A rescue whose one send the pipeline refuses falls back to the ordinary self-publish,
// which retries it under the publish backoff, in-process and across a restart.
function registerRescueRetryTests() {
    // W06: the node refuses the rescue's send three times. Each refusal is definitive,
    // so the ordinary self-publish retries it under the backoff (1, 2, then 4 ticks)
    // until one is accepted, and a restart after that pays for nothing again.
    it('retries a rescue the node refuses until one send is accepted, then holds across a restart', async function () {
        let b = makeBroadcaster(['ok', 'ok', 'refuse', 'refuse', 'refuse']);
        let landed = new Set();
        let { eng, state } = await rescueFired(b, landed);
        for (let i = 0; i < 20; i++) await tick(eng, state);
        expect(b.calls.slice(2)).to.deep.equal([[MY_PK], [MY_PK], [MY_PK], [MY_PK]]);
        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(6);
        let phases = spendLog(ctx.dir).map(r => r.phase + '/' + r.kind);
        expect(phases.filter(p => p === 'rescue/self')).to.have.length(1);
        expect(phases.filter(p => p === 'sent/self')).to.have.length(1);
    });

    // W07: one transient 429 on the rescue's send, then a restart before the retry. The
    // restart reads the rescue line as taking the own signature off the wire, so the
    // self-publish sends it once more, the finished sweep stays committed and sends
    // nothing, and a second restart after the accepted send pays for nothing.
    it('self-publishes once after a restart when the rescue was refused by one 429', async function () {
        let b = makeBroadcaster(['ok', 'ok', '429']);
        let landed = new Set();
        await rescueFired(b, landed);
        expect(b.calls.length).to.equal(3);

        let eng = makeEngine(ctx.dir, b.fn, landed);   // a restart after the refused rescue
        expect(eng._committed.has(String(EPOCH))).to.equal(true);
        let delivered = eng._delivered.get(EPOCH + ':' + LEDGER_HASH);
        expect(delivered.size).to.equal(49);
        expect(delivered.has(MY_PK)).to.equal(false);
        let state = makeState();
        for (let i = 0; i < 3; i++) await tick(eng, state);
        expect(b.calls.slice(2)).to.deep.equal([[MY_PK], [MY_PK]]);

        await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
        expect(b.calls.length).to.equal(4);
        let phases = spendLog(ctx.dir).map(r => r.phase + '/' + r.kind);
        expect(phases.filter(p => p === 'rescue/self')).to.have.length(1);
        expect(phases.filter(p => p === 'sent/self')).to.have.length(1);
    });
}

// A sweep that never landed, then a restart whose reads at DOGE tips 100, 102 and 103
// fire the own-signature rescue on the third tick. Returns that engine and round.
async function rescueFired(b, landed) {
    landed.tip = 50;
    await tick(makeEngine(ctx.dir, b.fn, landed), makeState());
    expect(b.calls.length).to.equal(2);
    let eng = makeEngine(ctx.dir, b.fn, landed);
    let state = makeState();
    for (let tip of [100, 102, 103]) { landed.tip = tip; await tick(eng, state); }
    expect(b.calls.slice(2)).to.deep.equal([[MY_PK]]);
    return { eng, state };
}

// The chunk plan a 100-signature epoch publishes as (41, 41 and 18 pairs).
async function threeChunkPlan() {
    let scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-plan3-'));
    await tick(makeEngine(scratch, makeBroadcaster([]).fn, new Set()), makeState(100));
    let plan = spendLog(scratch).find(r => r.phase === 'intent' && r.kind === 'sweep').plan;
    fs.rmSync(scratch, { recursive: true, force: true });
    return plan;
}

function line(rec) {
    return JSON.stringify(Object.assign({ ts: 1, effector: 'ROLLCALL_PUBLISH', pubkey: MY_PK, epoch: EPOCH,
                                          kind: 'sweep', ledger_hash: LEDGER_HASH }, rec));
}

function registerDamagedLogTests() {
    it('reads a duplicated sent line as one chunk, and resumes only after the chunk in flight', async function () {
        let plan = await threeChunkPlan();
        let sent1 = line({ phase: 'sent', txid: 'aa'.repeat(32), pairs: plan[0].length, pubkeys: plan[0] });
        fs.writeFileSync(path.join(ctx.dir, 'spend.jsonl'),
            [line({ phase: 'intent', pairs: 100, chunks: 3, plan }), sent1, sent1].join('\n') + '\n');
        let b = makeBroadcaster([]);
        await tick(makeEngine(ctx.dir, b.fn, new Set()), makeState(100));
        expect(b.calls).to.deep.equal([plan[2]]);
    });

    it('keeps a record written after a torn line, so a later restart pays for nothing twice', async function () {
        let plan = await threeChunkPlan();
        let sent1 = line({ phase: 'sent', txid: 'aa'.repeat(32), pairs: plan[0].length, pubkeys: plan[0] });
        let torn = line({ phase: 'sent', txid: 'bb'.repeat(32), pairs: plan[1].length, pubkeys: plan[1] });
        fs.writeFileSync(path.join(ctx.dir, 'spend.jsonl'),
            [line({ phase: 'intent', pairs: 100, chunks: 3, plan }), sent1].join('\n') + '\n' +
            torn.slice(0, Math.floor(torn.length / 2)));
        let b = makeBroadcaster([]);
        await tick(makeEngine(ctx.dir, b.fn, new Set()), makeState(100));
        expect(b.calls).to.deep.equal([plan[2]]);
        expect(spendLog.bind(null, ctx.dir)).to.throw();   // the torn fragment stays one bad line
        let lines = fs.readFileSync(path.join(ctx.dir, 'spend.jsonl'), 'utf8').split('\n');
        expect(lines.filter(l => { try { return JSON.parse(l).phase === 'intent'; } catch (_) { return false; } }))
            .to.have.length(2);

        await tick(makeEngine(ctx.dir, b.fn, new Set()), makeState(100));
        expect(b.calls.length).to.equal(1);
        expect(paidTwice(b.calls)).to.deep.equal([]);
    });
}
