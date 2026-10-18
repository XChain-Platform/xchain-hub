'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const { leadsSnapshotSlot } = require('../../../../src/anchor/snapshot_checkpoint/leader.js');
const { snapshotCheckpointCanonical } = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const { buildSnapshotMesh } = require('./support/snapshot_mesh.js');

const hex = digit => String(digit).repeat(64);

describe('snapshot checkpoint federation mesh', function () {
    it('builds deterministic engine-free hubs with the production leader rule', function () {
        const bus = buildSnapshotMesh({ n: 3, timeoutMs: 27 });
        const pubkeys = bus.nodes.map(node => node.pubkey);

        expect(bus.network).to.equal('regtest');
        expect(bus.nodes).to.have.length(3);
        expect(new Set(pubkeys).size).to.equal(3);
        expect(pubkeys.every(pubkey => /^[0-9a-f]{64}$/.test(pubkey))).to.equal(true);
        for (const node of bus.nodes) {
            expect(node.engine).to.equal(null);
            expect(node.db).to.equal(node.hub.db);
            expect(node.hub.getIdentity()).to.equal(node.identity);
            expect(node.stateCheckpoints.identity).to.equal(node.identity);
            expect(node.stateCheckpoints.peerManager).to.equal(node.hub.getPeerManager());
            expect(node.stateCheckpoints.hub).to.equal(node.hub);
            expect(node.stateCheckpoints.network).to.equal('regtest');
            expect(node.stateCheckpoints.roundTimeoutMs).to.equal(27);
            expect(node.hub.p2pConfig).to.deep.equal({
                CHECKPOINT_CHAINS: 'BTC',
                CHECKPOINT_CONFIRMATIONS: '0',
                CHECKPOINT_ROUND_TIMEOUT_MS: '27'
            });
        }
        for (let block = 0; block < 9; block++) {
            const leader = bus.nodes.find(node =>
                leadsSnapshotSlot(block, bus.validators, node.pubkey));
            expect(bus.leaderAt(block)).to.equal(leader);
        }
    });

    it('routes deep-copied broadcasts and supports drops and listener removal', function () {
        const bus = buildSnapshotMesh({ n: 3, timeoutMs: 30 });
        const received = bus.nodes.map(() => []);
        bus.nodes.forEach((node, index) => node.hub.getPeerManager()
            .on('message', envelope => received[index].push(envelope)));
        const data = { nested: { value: 1 } };

        bus.nodes[0].hub.getPeerManager().broadcast('XSNP_SIGN_REQ', data);
        data.nested.value = 2;
        expect(received[0]).to.deep.equal([]);
        expect(received[1][0]).to.deep.equal({
            type: 'XSNP_SIGN_REQ', sender: bus.nodes[0].pubkey, data: { nested: { value: 1 } }
        });
        received[1][0].data.nested.value = 9;
        expect(received[2][0].data.nested.value).to.equal(1);
        expect(bus.sent).to.deep.equal([
            { type: 'XSNP_SIGN_REQ', sender: bus.nodes[0].pubkey }
        ]);

        bus.drop = (envelope, from, to) => to === bus.nodes[2];
        bus.nodes[0].hub.getPeerManager().broadcast('XSNP_SIGN', {});
        expect(received.map(rows => rows.length)).to.deep.equal([0, 2, 1]);
        expect(bus.sent).to.have.length(2);
        bus.drop = null;

        bus.nodes[1].hub.getPeerManager().removeListener('message');
        bus.nodes[0].hub.getPeerManager().broadcast('XSNP_FINALIZED', {});
        expect(received.map(rows => rows.length)).to.deep.equal([0, 2, 2]);
    });

    it('uses the real snapshot DB methods over isolated in-memory tables', async function () {
        const bus = buildSnapshotMesh({ n: 3, timeoutMs: 30 });
        const db = bus.nodes[0].db;
        const checkpoint = {
            chain: 'BTC', network: 'regtest', block_index: 100,
            block_hash: hex('a'), state_root: hex('b'), state_root_version: 1,
            validator_signatures: '[]'
        };

        expect(await db.insertSnapshotCheckpoint(checkpoint)).to.equal(true);
        expect(await db.insertSnapshotCheckpoint({ ...checkpoint, block_hash: hex('c') })).to.equal(false);
        expect(await db.getSnapshotCheckpoint('BTC', 'regtest', 100)).to.deep.equal(checkpoint);
        expect(await bus.nodes[1].db.getSnapshotCheckpoint('BTC', 'regtest', 100)).to.equal(null);
        expect(db.queries.some(sql => /^INSERT IGNORE INTO snapshot_checkpoints/.test(sql))).to.equal(true);

        for (const node of bus.nodes) node.db.seedSnapshots([118, 106, 112, 106]);
        const due = async (target, from, limit) => (await target
            .listUncheckpointedSnapshotBlocks('regtest', from, 6, limit))
            .map(row => Number(row.snapshot_block));
        expect(await due(bus.nodes[1].db, 0, 10)).to.deep.equal([106, 112, 118]);
        expect(await due(bus.nodes[1].db, 112, 10)).to.deep.equal([112, 118]);
        expect(await due(bus.nodes[1].db, 0, 1)).to.deep.equal([106]);
        expect(await due(db, 0, 10)).to.deep.equal([112, 118]);
    });

    it('provides shared rooted indexer rows with hub-local fault controls', async function () {
        const bus = buildSnapshotMesh({ n: 3, timeoutMs: 30 });
        const call = (node, blockIndex) => node.stateCheckpoints
            .indexerCall('BTC', 'getblockhashes', { block_index: blockIndex });
        const honest = await call(bus.nodes[0], 100);

        expect(honest).to.include({ block_index: 100, network: 'regtest', state_root_version: 1 });
        expect(honest.block_hash).to.match(/^[0-9a-f]{64}$/);
        expect(honest.state_root).to.match(/^[0-9a-f]{64}$/);
        expect(await call(bus.nodes[1], 100)).to.deep.equal(honest);
        expect(await call(bus.nodes[0], bus.chainTip + 1)).to.equal(null);

        bus.nodes[2].tamper(100, { state_root: hex('e') });
        expect(await call(bus.nodes[2], 100)).to.deep.equal({ ...honest, state_root: hex('e') });
        expect((await call(bus.nodes[1], 100)).state_root).to.equal(honest.state_root);
        expect((await call(bus.nodes[2], 101)).state_root)
            .to.equal((await call(bus.nodes[0], 101)).state_root);

        bus.nodes[1].indexerDown = true;
        let rejected = false;
        try {
            await call(bus.nodes[1], 100);
        } catch (error) {
            rejected = /indexer unavailable/.test(error.message);
        }
        expect(rejected).to.equal(true);
    });

    it('exposes validator snapshots, independent tips, and signing identities', async function () {
        const bus = buildSnapshotMesh({ n: 3, timeoutMs: 30 });
        const validators = await bus.nodes[0].stateCheckpoints
            .resolveCapabilityValidators('oracle_publish', 106);

        expect(validators).to.deep.equal(bus.validators);
        expect(validators.every(validator => validator.source.startsWith('src'))).to.equal(true);
        expect(validators.every(validator => validator.weight === validator.amount
            && Number(validator.weight) > 0)).to.equal(true);
        expect(new Set(validators.map(validator => validator.source)).size).to.equal(3);
        validators[0].weight = '0';
        expect(bus.validators[0].weight).to.equal('100');
        expect((await bus.nodes[0].hub.capabilitySnapshot
            .getSnapshot('oracle_publish', 106)).validators).to.deep.equal(bus.validators);
        expect((await bus.nodes[0].hub.capabilitySnapshot
            .getWeightSnapshot('oracle_publish', 106)).validators).to.deep.equal(bus.validators);

        bus.setTip(140);
        expect(await bus.nodes[2].hub.resolveBtcLatestBlock()).to.equal(140);
        bus.nodes[2].btcTip = 120;
        expect(await bus.nodes[1].hub.resolveBtcLatestBlock()).to.equal(140);
        expect(await bus.nodes[2].hub.resolveBtcLatestBlock()).to.equal(120);

        const checkpoint = {
            chain: 'BTC', network: 'regtest', block_index: 100,
            block_hash: hex('a'), state_root: hex('b'), state_root_version: 1
        };
        const canonical = snapshotCheckpointCanonical(checkpoint);
        expect(ValidatorIdentity.verify(canonical, bus.nodes[0].identity.sign(canonical),
            bus.nodes[0].pubkey)).to.equal(true);
    });
});
