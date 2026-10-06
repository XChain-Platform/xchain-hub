'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');

function publisher(consulted, db){
    const pub = new StateAnchorPublisher({
        db,
        network: 'regtest',
        p2pConfig: {},
        getIdentity: () => null,
        getPeerManager: () => null
    });
    pub.resolveCapabilitySet = async (capability, block) => {
        consulted.push(capability + '|' + block);
        return [{ pubkey: 'aa', amount: '1', source: 's' }];
    };
    return pub;
}

describe('archive coverage selector scope', function () {
    it('consults only blocks the quorum inputs reference even when the hub mirror holds more', async function () {
        const consulted = [];
        const mirrorReads = [];
        const mirrorRow = { snapshot_block: 999, reference_block: 999, block_index: 999, transfer_id: 'mirror-only', snapshot_id: 'mirror-only' };
        const db = new Proxy({}, { get: (_, name) => async () => { mirrorReads.push(String(name)); return [mirrorRow]; } });
        const pub = publisher(consulted, db);
        const quorumRows = {
            bridges: [{ snapshot_block: 100, transfer_id: 'in-quorum' }],
            policies: [], checkpoints: [], prices: [], tombstones: [], lists: []
        };

        await pub.buildArchive('regtest', 1, [], 50, [], [], quorumRows);

        expect(consulted).to.have.members(['cross_chain|100', 'oracle_publish|50']);
        expect(mirrorReads).to.deep.equal([]);
    });

    it('control: a quorum row at the mirror block is consulted, proving the stub observes blocks', async function () {
        const consulted = [];
        const pub = publisher(consulted, {});
        const quorumRows = {
            bridges: [{ snapshot_block: 999, transfer_id: 'now-in-quorum' }],
            policies: [], checkpoints: [], prices: [], tombstones: [], lists: []
        };

        await pub.buildArchive('regtest', 1, [], 50, [], [], quorumRows);

        expect(consulted).to.include('cross_chain|999');
    });
});
