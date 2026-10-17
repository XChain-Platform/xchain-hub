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

// A cadence leader whose own round throws (an indexer blip) must cost one block, not
// the cadence: the engine header promises the next cadence retries under a rotated
// leader. If tick wrote the failed leader's block into the same latch the co-sign
// gate reads as the last FINALIZED checkpoint, that hub would refuse every rotated
// leader for an interval. Where the quorum has no slack for one decliner (two or three
// equal-stake hubs under the stake-weighted rule, or six with one offline) the next
// leader's round would fail too and latch its own block in turn, and the staggered
// latches would stop checkpoints fleet-wide until every hub restarted.

const { expect } = require('chai');
const { buildMesh, walk, settle, cadenceViolations } = require('./support/checkpoint_mesh.js');
const { waitUntil } = require('../../../../helpers/waitUntil.js');

let meshes = [];
function mesh(opts) { const b = buildMesh(opts); meshes.push(b); return b; }

const SHAPES = [{ n: 2 }, { n: 3 }, { n: 4 }, { n: 6 }, { n: 6, silent: 1 }];

// One member offline: not the failed leader, nor the leaders of the next two blocks.
function silence(bus, L) {
    const off = bus.nodes.find(nd => nd !== L && nd !== bus.leaderAt(107) && nd !== bus.leaderAt(108));
    bus.drop = (env, from, to) => from === off || to === off;
    return off;
}

describe('checkpoint cadence: a failed leader round is retried by the next leader', function () {
    this.timeout(20000);
    afterEach(async function () { for (const b of meshes) await b.stopAll(); meshes = []; });

    for (const shape of SHAPES) {
        const name = 'n=' + shape.n + (shape.silent ? ' with one hub offline' : '');
        it(name + ': the leader at the next block checkpoints the missed interval and the cadence holds', async function () {
            const bus = mesh({ n: shape.n });
            await bus.startAll();
            bus.setTip(100); await bus.tickAll();
            bus.setTip(106);
            const L = bus.leaderAt(106);
            const off = shape.silent ? silence(bus, L) : null;
            L.indexerDown = true;
            await bus.tickAll();
            L.indexerDown = false;

            await walk(bus, 107, 120);
            const live = bus.nodes.filter(nd => nd !== off);
            const snaps = bus.snapshots(live[0]);
            expect(snaps.slice(0, 2), 'the next block\'s leader retries the interval').to.deep.equal([100, 107]);
            expect(cadenceViolations(snaps, 6), JSON.stringify(snaps)).to.deep.equal([]);
            expect(snaps.length, 'the cadence keeps going after the retry: ' + JSON.stringify(snaps)).to.be.at.least(3);
            for (const nd of live) {
                expect(bus.snapshots(nd), 'hub ' + nd.i).to.deep.equal(snaps);
                expect(nd.engine._lastCheckpointBtcBlock, 'hub ' + nd.i + ' latch').to.equal(snaps[snaps.length - 1]);
                expect(nd.engine._cosignDeclines.off_cadence, 'hub ' + nd.i + ' refused no rotated leader').to.equal(0);
            }
        });
    }

    it('a round that threw is re-led at the same block while the BTC tip has not moved', async function () {
        const bus = mesh({ n: 3 });
        await bus.startAll();
        bus.setTip(100); await bus.tickAll();
        bus.setTip(106);
        const L = bus.leaderAt(106);
        L.indexerDown = true;
        await L.engine.tick(); await settle();
        expect(bus.snapshots(L), 'nothing finalized while the indexer was down').to.deep.equal([100]);
        expect(L.engine._lastCheckpointBtcBlock, 'a failed round leaves the finalized latch alone').to.equal(100);

        L.indexerDown = false;
        await L.engine.tick();
        await waitUntil(() => bus.nodes.every(nd => bus.snapshots(nd).length === 2), { label: 'the re-led round on every hub' });
        for (const nd of bus.nodes) expect(bus.snapshots(nd), 'hub ' + nd.i).to.deep.equal([100, 106]);
    });
});
