'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pins the v0 bundle failover ladder on content age: when the elected rank 0 has
// no signer, its flush skips, and the rank 1 backup anchors the pending bundle with
// both the old and the newer checkpoint sections, ages counted from the oldest
// pending content rather than the newest row.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const assert = require('node:assert/strict');
const { CP_ROW, buildMesh, v0Order, startAll, parseV7Sections, registerMeshHooks } =
    require('../../../../../helpers/anchor_mesh.js');

describe('v0 bundle failover with a signerless rank 0', function () {
    registerMeshHooks();

    it('a backup anchors a mixed-height v0 bundle when rank 0 is signerless', async function () {
        const bus = buildMesh(4, { btcBlock: 137, network: 'mainnet', checkpointCommitment: true });
        for(const node of bus.nodes){
            node.db.checkpoints.push(Object.assign({}, CP_ROW, {
                chain: 'LTC', network: 'mainnet', snapshot_block: 136,
                checkpoint_seq: 7, block_index: 990, anchor_txid: null
            }));
        }
        const order = v0Order(bus, { network: 'mainnet', snapshot_block: 136 });
        const leader = order[0];
        const backup = order[1];
        leader.pub.setBroadcastHook(null);
        await startAll(bus);
        assert.equal((await leader.pub.flush()).skipped, 'no_pipeline');
        await backup.pub.flush();
        const bundles = backup.published.filter(payload => payload.split('|')[1] === '0');
        assert.equal(bundles.length, 1);
        assert.deepEqual(parseV7Sections(bundles[0]).map(section => section.snapshot_block), [100, 136]);
        assert.equal(backup.pub.getAnchorStats().anchorsAsBackup, 1);
    });

});
