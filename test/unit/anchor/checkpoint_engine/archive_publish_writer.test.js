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

const { expect }            = require('chai');
const sinon                 = require('sinon');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine.js');
const minStakeMethods       = require('../../../../src/validators/capability_snapshot/min_stake.js');

function checkpoint(network, snapshotBlock){
    return {
        chain: 'BTC', network, block_index: snapshotBlock - 6,
        block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
        actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: snapshotBlock, snapshot_block: snapshotBlock,
        state_root: 'd4'.repeat(32), state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1,
    };
}

function engineFor(network){
    const db = { createStateCheckpoint: sinon.stub().resolves({ affectedRows: 1 }) };
    const engine = new StateCheckpointEngine({
        db, network,
        p2pConfig: { CHECKPOINT_ENABLED: 'false' },
        getPeerManager: () => null,
        getIdentity: () => null,
    });
    sinon.stub(engine, 'seatedCheckpointAtSeq').resolves(null);
    sinon.stub(engine, 'broadcastRowOrResync').resolves();
    return { db, engine };
}

describe('StateCheckpointEngine archive_publish snapshot writer', function () {
    afterEach(function () { sinon.restore(); });

    it('makes every hub persist archive_publish beside oracle_publish above the gate', async function () {
        const nodes = [engineFor('regtest'), engineFor('regtest'), engineFor('regtest')];
        for(const [index, node] of nodes.entries()){
            const writes = [];
            sinon.stub(node.engine, 'persistCapabilitySnapshot').callsFake(async (capability, block) => {
                writes.push([capability, block]);
            });
            await node.engine.acceptFinalized(checkpoint('regtest', 480), [], 1, index === 0);
            expect(writes).to.deep.equal([
                ['oracle_publish', 480],
                ['archive_publish', 480],
            ]);
            expect(node.db.createStateCheckpoint.calledOnce).to.equal(true);
        }
    });

    it('does not persist archive_publish below the gate', async function () {
        const node = engineFor('mainnet');
        const writes = [];
        sinon.stub(node.engine, 'persistCapabilitySnapshot').callsFake(async (capability, block) => {
            writes.push([capability, block]);
        });

        await node.engine.acceptFinalized(checkpoint('mainnet', 961000), [], 1, false);

        expect(writes).to.deep.equal([['oracle_publish', 961000]]);
        expect(node.db.createStateCheckpoint.calledOnce).to.equal(true);
    });

    it('does not let an archive_publish resolve failure block the checkpoint insert', async function () {
        const node = engineFor('regtest');
        sinon.stub(node.engine, 'persistCapabilitySnapshot').callsFake(async (capability) => {
            if(capability === 'archive_publish') throw new Error('archive set unavailable');
        });

        await node.engine.acceptFinalized(checkpoint('regtest', 480), [], 1, false);

        expect(node.engine.persistCapabilitySnapshot.firstCall.args[0]).to.equal('oracle_publish');
        expect(node.engine.persistCapabilitySnapshot.secondCall.args[0]).to.equal('archive_publish');
        expect(node.db.createStateCheckpoint.calledOnce).to.equal(true);
    });

    it('reads the archive_publish MIN_STAKE from oracle_publish', function () {
        const registry = { getMinStake: sinon.stub().callsFake((capability) =>
            capability === 'oracle_publish' ? '25000.00000000' : '1') };
        const reader = Object.assign({ hub: { capabilityRegistry: registry } }, minStakeMethods);

        expect(reader.resolveMinStake('archive_publish', 480)).to.equal('25000.00000000');
        expect(registry.getMinStake.calledOnceWithExactly('oracle_publish', 480)).to.equal(true);
    });
});
