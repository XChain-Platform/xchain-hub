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
//
// The ANCHOR v0 bundle selector's CHECKPOINT_COMMITMENT floor: a root-bearing row
// below the flag-day at its own snapshot_block never rides a bundle, because the
// hub signs it rootless while the indexer rebuilds every v0 section with the root
// suffix. Built on testnet, whose flag-day (146000) sits above genesis; regtest
// arms it at 0, where the below-gate case cannot exist.

const { expect }            = require('chai');
const StateAnchorPublisher  = require('../../../../src/anchor/publisher');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const { CP_ROW, buildMesh, stopMeshes } = require('../../../helpers/anchor_mesh.js');

const BELOW = 145500;
const AT    = 146000;

function testnetRow(chain, snapshotBlock, over) {
    return Object.assign({}, CP_ROW, { chain: chain, network: 'testnet', snapshot_block: snapshotBlock,
                                       checkpoint_seq: snapshotBlock, anchor_txid: null }, over || {});
}

function group(rows) {
    let pub = new StateAnchorPublisher({ db: {}, p2pConfig: {} });
    return pub.groupSectionsByNetwork(rows);
}

describe('StateAnchorPublisher bundle selector CHECKPOINT_COMMITMENT floor', function () {
    registerFloorCases();
    registerCanonicalParityCase();
    registerMeshOverrideScopeCase();
});

// The floor itself: below-gate dropped, at-gate kept, the rootless skip unchanged.
function registerFloorCases() {
    it('drops a root-bearing testnet row at 145500 and keeps the same row at 146000', function () {
        expect(group([testnetRow('BTC', BELOW)]).size, 'below the flag-day: no bundle').to.equal(0);
        let kept = group([testnetRow('BTC', AT)]);
        expect(kept.size).to.equal(1);
        expect(kept.get('testnet').map(r => r.snapshot_block)).to.deep.equal([AT]);
    });

    it('drops only the below-gate section when a bundle mixes both', function () {
        let out = group([testnetRow('BTC', AT), testnetRow('LTC', BELOW), testnetRow('DOGE', AT)]);
        expect(out.get('testnet').map(r => r.chain)).to.deep.equal(['BTC', 'DOGE']);
    });

    it('still drops a root-null row at/above the flag-day (the rootless skip is kept)', function () {
        expect(group([testnetRow('BTC', AT, { state_root: null })]).size).to.equal(0);
    });

    it('keeps regtest rows, whose flag-day is genesis', function () {
        let out = group([Object.assign({}, CP_ROW, { anchor_txid: null })]);
        expect(out.get('regtest').length).to.equal(1);
    });
}

// The floor sits exactly where the hub's signed canonical loses its root suffix.
function registerCanonicalParityCase() {
    it('drops a row exactly when the hub canonical omits the root suffix', function () {
        let rootTail = '|' + CP_ROW.state_root + '|1|' + CP_ROW.block_merkle_root + '|1';
        let below = testnetRow('BTC', BELOW), at = testnetRow('BTC', AT);
        expect(StateCheckpointEngine.canonicalCheckpoint(below).endsWith(rootTail), 'below: signed rootless').to.equal(false);
        expect(StateCheckpointEngine.canonicalCheckpoint(at).endsWith(rootTail), 'at: signed with roots').to.equal(true);
        expect(StateCheckpointEngine.isCheckpointCommitmentActive(below)).to.equal(false);
        expect(StateCheckpointEngine.isCheckpointCommitmentActive(at)).to.equal(true);
    });
}

// The mesh harness override is per-instance and gone once the mesh stops.
function registerMeshOverrideScopeCase() {
    afterEach(stopMeshes);

    it('arms the floor only on the mesh that asked, and stopMeshes restores the gate read', async function () {
        let armed = buildMesh(1, { network: 'mainnet', checkpointCommitment: true }).nodes[0].pub;
        let plain = buildMesh(1, { network: 'mainnet' }).nodes[0].pub;
        let row = Object.assign({}, CP_ROW, { network: 'mainnet', anchor_txid: null });
        expect(armed.groupSectionsByNetwork([row]).size, 'armed mesh keeps the block-100 row').to.equal(1);
        expect(plain.groupSectionsByNetwork([row]).size, 'an unarmed mesh applies the real gate').to.equal(0);
        await stopMeshes();
        expect(Object.prototype.hasOwnProperty.call(armed, 'sectionCommitmentActive')).to.equal(false);
        expect(armed.groupSectionsByNetwork([row]).size, 'after stop the real gate applies').to.equal(0);
    });
}
