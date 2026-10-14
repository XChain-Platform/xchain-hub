'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A rolling deploy runs old and new cadence code side by side. Nothing on the wire
// changed, so the question is liveness: an old hub still latches the block it led
// before the round finalizes and co-signs against that, while a new hub reads only
// finalized checkpoints and holds one signature per interval. Mixed in one fleet they
// must keep one checkpoint per interval and must not stall.

const { expect } = require('chai');
const { buildMesh, walk, sleep, settle, cadenceViolations } = require('./support/checkpoint_mesh.js');
const { legacyCadence } = require('./support/legacy_cadence.js');

// Slack for the race cases, whose two rounds run with no retry tick right after them.
const RACE_TIMEOUT_MS = 80;

let meshes = [];
function mesh(opts, oldHubs) {
    const b = buildMesh(opts);
    for (const nd of oldHubs(b)) legacyCadence(nd.engine);
    meshes.push(b);
    return b;
}

function expectCadence(bus, opts) {
    const snaps = bus.snapshots(bus.nodes[0]).slice().sort((a, b) => a - b);
    expect(cadenceViolations(snaps, 6, opts.firstBy), JSON.stringify(snaps)).to.deep.equal([]);
    expect(snaps.length, 'the cadence keeps going: ' + JSON.stringify(snaps)).to.be.at.least(opts.atLeast);
    for (const nd of bus.nodes)
        expect(bus.snapshots(nd).slice().sort((a, b) => a - b), 'hub ' + nd.i).to.deep.equal(snaps);
    return snaps;
}

async function failLeaderAt(bus, block) {
    const L = bus.leaderAt(block);
    bus.setTip(block);
    L.indexerDown = true;
    await bus.tickAll();
    L.indexerDown = false;
}

describe('checkpoint cadence: old and new hubs mid-roll', function () {
    this.timeout(20000);
    afterEach(async function () { for (const b of meshes) await b.stopAll(); meshes = []; });

    it('two old and two new hubs on a healthy chain checkpoint once per interval', async function () {
        const bus = mesh({ n: 4 }, b => b.nodes.slice(0, 2));
        await bus.startAll();
        await walk(bus, 100, 125);
        expect(expectCadence(bus, { atLeast: 5 })).to.deep.equal([100, 106, 112, 118, 124]);
    });

    it('three hubs, one old: a failed round at a new leader is retried at the next block', async function () {
        const bus = mesh({ n: 3 }, b => [b.nodes.find(nd => nd !== b.leaderAt(106))]);
        await bus.startAll();
        bus.setTip(100); await bus.tickAll();
        await failLeaderAt(bus, 106);
        await walk(bus, 107, 125);
        expect(expectCadence(bus, { atLeast: 4 })[1]).to.equal(107);
    });

    // The old hub still refuses 107..111 after its own failed round (the old behaviour,
    // one interval lost), but with the rest new the latches no longer stagger: the old
    // hub's next slot, 112, finalizes and the cadence holds from there.
    it('three hubs, the failed leader old: the next interval checkpoints and the cadence holds', async function () {
        const bus = mesh({ n: 3 }, b => [b.leaderAt(106)]);
        await bus.startAll();
        bus.setTip(100); await bus.tickAll();
        await failLeaderAt(bus, 106);
        await walk(bus, 107, 130);
        expectCadence(bus, { atLeast: 4, firstBy: 112 });
    });

    for (const oldSide of ['lagging', 'current']) {
        it('four hubs, the ' + oldSide + ' slot holder of a tip-skew race old: one checkpoint per interval', async function () {
            const bus = mesh({ n: 4, timeoutMs: RACE_TIMEOUT_MS }, b => [oldSide === 'lagging' ? b.leaderAt(106) : b.leaderAt(107)]);
            await bus.startAll();
            bus.setTip(100); await bus.tickAll();
            for (const nd of bus.nodes) nd.btcTip = 107;
            bus.leaderAt(106).btcTip = 106;
            await Promise.all([bus.leaderAt(106).engine.tick(), bus.leaderAt(107).engine.tick()]);
            await settle(); await sleep(bus.roundWaitMs);
            await walk(bus, 108, 121);
            expectCadence(bus, { atLeast: 4 });
        });
    }
});
