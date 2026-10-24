'use strict';

// GENERATED
// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The wrapper checkpoint capability seam is shared by archive construction and follower verification.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const capabilityWants = require('../../../../../src/anchor/publisher/archive/capability_wants.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const vectors = require('../../../../fixtures/anchor_archive_vectors.json');

const WRAPPER_BLOCK = 1010;
const SENTINEL_CAPABILITY = 'wrapper_sentinel';
const SET = [{ pubkey: 'aa'.repeat(32), amount: '1', source: '' }];
const ORIGINAL_ARCHIVE_WRAPPER_CAPABILITY = capabilityWants.archiveWrapperCapability;

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

function buildPub(){
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS }, network: 'regtest',
        getIdentity: () => new ValidatorIdentity('11'.repeat(32)),
        getPeerManager: () => ({ broadcast() {} }), p2pConfig: {}
    });
    pub.resolveCapabilitySet = async () => SET;
    return pub;
}

function everyKindArchive(network){
    return {
        network,
        matches: [{ snapshot_block: 1001 }],
        calls: [{ snapshot_block: 1002 }],
        bridge_transfers: [{ snapshot_block: 1003 }],
        policy_snapshots: [{ snapshot_block: 1004 }],
        list_snapshots: [{ snapshot_block: 1005 }],
        state_checkpoints: [{ snapshot_block: 1006 }],
        price_snapshots: [
            { reference_block: 1007, signature_proofed: true },
            { reference_block: 1008, signature_proofed: false }
        ],
        rewards: [{ block_index: 1009 }]
    };
}

function kindsForBuild(){
    const reward = copy(vectors.B.inputs.rewards[0]);
    reward.row.block_index = 1009;
    const checkpoint = copy(vectors.C.inputs.checkpoints[0]);
    checkpoint.snapshot_block = 1006;
    return { reward, checkpoint };
}

function restoreArchiveWrapperCapability(){
    capabilityWants.archiveWrapperCapability = ORIGINAL_ARCHIVE_WRAPPER_CAPABILITY;
}

function defaultsToOraclePublish(){
    for(const network of ['regtest', 'testnet', 'mainnet'])
        expect(capabilityWants.archiveWrapperCapability({ network }, WRAPPER_BLOCK)).to.equal('oracle_publish');

    expect(capabilityWants.archiveCapabilityWants(
        everyKindArchive('mainnet'), WRAPPER_BLOCK, row => row.signature_proofed
    )).to.deep.equal([
        { block: 1001, capability: 'cross_chain' },
        { block: 1002, capability: 'cross_chain' },
        { block: 1003, capability: 'cross_chain' },
        { block: 1004, capability: 'cross_chain' },
        { block: 1005, capability: 'cross_chain' },
        { block: 1006, capability: 'oracle_publish' },
        { block: 1007, capability: 'price' },
        { block: 1009, capability: 'oracle_publish' },
        { block: WRAPPER_BLOCK, capability: 'oracle_publish' }
    ]);
}

async function routesOnlyWrapperGroup(){
    const seen = [];
    capabilityWants.archiveWrapperCapability = (archive, wrapperSnapshotBlock) => {
        seen.push([archive.network, wrapperSnapshotBlock]);
        return SENTINEL_CAPABILITY;
    };
    const pub = buildPub();
    const { reward, checkpoint } = kindsForBuild();
    const result = await pub.buildArchive('mainnet', 7, [], WRAPPER_BLOCK, [], [reward], {
        checkpoints: [checkpoint]
    });
    const archive = JSON.parse(result.json);
    const built = archive.capability_snapshots.map(row => row.snapshot_block + '|' + row.capability);

    expect(built).to.deep.equal([
        '1006|oracle_publish',
        '1009|oracle_publish',
        WRAPPER_BLOCK + '|' + SENTINEL_CAPABILITY
    ]);
    const seeded = new Map();
    expect(pub.seedRequiredSnapshotGroups(seeded, archive, WRAPPER_BLOCK)).to.equal(true);
    expect([...seeded.keys()]).to.deep.equal([
        '1006|oracle_publish',
        '1009|oracle_publish',
        WRAPPER_BLOCK + '|' + SENTINEL_CAPABILITY
    ]);
    expect(seen).to.deep.equal([
        ['mainnet', WRAPPER_BLOCK],
        ['mainnet', WRAPPER_BLOCK]
    ]);
}

function skipsSeamWithoutWrapperBlock(){
    let calls = 0;
    capabilityWants.archiveWrapperCapability = () => {
        calls += 1;
        return SENTINEL_CAPABILITY;
    };

    expect(capabilityWants.archiveCapabilityWants(
        everyKindArchive('regtest'), null, row => row.signature_proofed
    )).to.deep.equal([
        { block: 1001, capability: 'cross_chain' },
        { block: 1002, capability: 'cross_chain' },
        { block: 1003, capability: 'cross_chain' },
        { block: 1004, capability: 'cross_chain' },
        { block: 1005, capability: 'cross_chain' },
        { block: 1006, capability: 'oracle_publish' },
        { block: 1007, capability: 'price' },
        { block: 1009, capability: 'oracle_publish' }
    ]);
    expect(calls).to.equal(0);
}

describe('archive wrapper capability seam', function () {
    afterEach(restoreArchiveWrapperCapability);
    it('defaults every network and every archive kind to oracle_publish with the wrapper last', defaultsToOraclePublish);
    it('routes only the wrapper group through the replaceable capability seam', routesOnlyWrapperGroup);
    it('does not consult the wrapper seam when there is no wrapper block', skipsSeamWithoutWrapperBlock);
});
