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

// A leader that restarts mid-round after its indexer moved re-proposes a different
// block at the same sequence, and every peer refuses it (one payload per sequence).
// That round can never finalize. If the leader kept it open and retried it, its own
// signature on it would keep it from co-signing the next block's leader (first
// through the latch it wrote, then through its signature on the open round). Its tip
// moving past the round it led now drops that round, so the next leader finalizes.

const { expect } = require('chai');
const { buildMesh, walk, settle, sleep } = require('./support/checkpoint_mesh.js');

let meshes = [];
function mesh(opts) { const b = buildMesh(opts); meshes.push(b); return b; }

describe('checkpoint cadence: a refused re-proposal after a leader restart', function () {
    this.timeout(20000);
    afterEach(async function () { for (const b of meshes) await b.stopAll(); meshes = []; });

    it('does not hold up the next block\'s leader', async function () {
        const bus = mesh({ n: 3 });
        await bus.startAll();
        bus.setTip(100); await bus.tickAll();
        bus.setTip(106);
        const L = bus.leaderAt(106);
        // The peers co-sign L's round but their signatures never reach L, which restarts.
        bus.drop = (env, from, to) => to === L && env.type === 'XCHK_SIGN';
        await L.engine.tick(); await settle();
        await bus.restart(L);
        bus.drop = null;
        bus.chainTip = 501;                     // the indexer moved: L re-proposes a second payload at seq 106
        for (let k = 0; k < 4; k++) { await L.engine.tick(); await sleep(bus.roundWaitMs); }
        for (const nd of bus.nodes.filter(x => x !== L))
            expect(nd.engine._seqDoubleSignRefusals, 'hub ' + nd.i + ' refused the second payload').to.be.at.least(1);
        for (const nd of bus.nodes) expect(bus.snapshots(nd), 'hub ' + nd.i + ' holds nothing at 106').to.deep.equal([100]);

        await walk(bus, 107, 107);
        for (const nd of bus.nodes) expect(bus.snapshots(nd), 'hub ' + nd.i).to.deep.equal([100, 107]);
    });
});
