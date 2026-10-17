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

// Two BTC blocks inside one poll window, with the due block's slot holder one block
// behind everyone else: the hub that leads 106 still sees 106, the hub that leads 107
// already sees 107, and both lead in the same window. A hub that latched its own block
// before finalizing would decline the other as off cadence, so three equal-stake hubs
// would finalize neither and stall for good, while four and six would finalize both
// (two checkpoints inside one interval). One signature per interval per hub, released when
// the round finalizes or times out, leaves at most one of the two able to reach quorum
// and lets the next leader retry if neither does.

const { expect } = require('chai');
const { buildMesh, walk, cadenceViolations } = require('./support/checkpoint_mesh.js');
const { waitUntil } = require('../../../../helpers/waitUntil.js');

// The race is asserted with no retry tick after it, so its rounds get more slack than
// the mesh default: a loaded venue must not time a healthy round out here.
const RACE_TIMEOUT_MS = 80;

let meshes = [];
function mesh(opts) { const b = buildMesh(opts); meshes.push(b); return b; }

// Both slot holders lead at once; returns the snapshots finalized by the race itself,
// once every hub holds the lower slot's checkpoint and the higher round is closed.
async function race(bus, lagging, current) {
    for (const nd of bus.nodes) nd.btcTip = 107;
    lagging.btcTip = 106;
    await Promise.all([lagging.engine.tick(), current.engine.tick()]);
    await waitUntil(() => bus.nodes.every(nd => bus.snapshots(nd).includes(106)) && current.engine.pending.size === 0,
                    { label: 'the lower slot finalized on every hub and the higher round closed' });
    return bus.snapshots(bus.nodes[0]).filter(b => b > 100);
}

describe('checkpoint cadence: a one-block tip skew between slot holders', function () {
    this.timeout(20000);
    afterEach(async function () { for (const b of meshes) await b.stopAll(); meshes = []; });

    for (const n of [3, 4, 6]) {
        it('n=' + n + ': gives the interval one checkpoint and the cadence holds', async function () {
            const bus = mesh({ n, timeoutMs: RACE_TIMEOUT_MS });
            await bus.startAll();
            bus.setTip(100); await bus.tickAll();
            const raced = await race(bus, bus.leaderAt(106), bus.leaderAt(107));
            // The higher slot holder yields to the lower one, so the race settles at once.
            expect(raced, 'the race finalizes exactly the lower slot').to.deep.equal([106]);

            await walk(bus, 108, 121);
            const snaps = bus.snapshots(bus.nodes[0]).slice().sort((a, b) => a - b);
            expect(cadenceViolations(snaps, 6), JSON.stringify(snaps)).to.deep.equal([]);
            expect(snaps.length, 'the cadence keeps going: ' + JSON.stringify(snaps)).to.be.at.least(4);
            for (const nd of bus.nodes)
                expect(bus.snapshots(nd).slice().sort((a, b) => a - b), 'hub ' + nd.i).to.deep.equal(snaps);
        });
    }
});
