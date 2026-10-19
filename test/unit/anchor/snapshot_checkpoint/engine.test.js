'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const SnapshotCheckpointEngine = require(
    '../../../../src/anchor/snapshot_checkpoint/engine.js');

const GATE = SnapshotCheckpointEngine.SNAPSHOT_CHECKPOINT_ACTIVATION;
const key = character => character.repeat(64);
const hash = character => character.repeat(64);

function block(blockIndex, overrides = {}) {
    return Object.assign({
        block_index: blockIndex,
        block_hash: hash('a'),
        state_root: hash('b'),
        state_root_version: 1,
    }, overrides);
}

function checkpoint(network, blockIndex, overrides = {}) {
    return Object.assign({
        chain: 'BTC',
        network,
        block_index: blockIndex,
        block_hash: hash('a'),
        state_root: hash('b'),
        state_root_version: 1,
        validator_signatures: '[]',
    }, overrides);
}

function harness(options = {}) {
    const network = options.network || 'regtest';
    const pubkey = options.pubkey || key('1');
    const due = (options.due || [106]).slice();
    const rows = new Map();
    const validators = options.validators || [{ pubkey }];
    let tip = options.tip === undefined ? 1000 : options.tip;
    let indexerBlock = options.block || null;

    for (const cp of options.stored || []) {
        rows.set([cp.chain, cp.network, cp.block_index].join('|'), cp);
    }
    const db = {
        listUncheckpointedSnapshotBlocks: sinon.spy(async () => due
            .filter(snapshotBlock => !rows.has(['BTC', network, snapshotBlock - 6].join('|')))
            .map(snapshotBlock => ({ snapshot_block: snapshotBlock }))),
        getSnapshotCheckpoint: sinon.spy(async (chain, cpNetwork, blockIndex) =>
            rows.get([chain, cpNetwork, blockIndex].join('|')) || null),
        insertSnapshotCheckpoint: sinon.spy(async cp => {
            const rowKey = [cp.chain, cp.network, cp.block_index].join('|');
            if (rows.has(rowKey)) return false;
            rows.set(rowKey, Object.assign({}, cp));
            return true;
        }),
        insertStateCheckpoint: sinon.spy(async () => true),
    };
    const peerManager = { broadcast: sinon.spy() };
    const identity = {
        getPubkeyHex: sinon.stub().returns(pubkey),
        sign: sinon.stub().returns('f'.repeat(128)),
    };
    const source = {
        db,
        peerManager,
        identity,
        network,
        confirmations: options.confirmations === undefined ? 6 : options.confirmations,
        pollMs: 60000,
        resolveSnapshotBlock: sinon.spy(async () => tip),
        resolveCapabilityValidators: sinon.spy(async () => validators),
        indexerCall: sinon.spy(async (chain, method, params) => {
            const answer = indexerBlock || block(params.block_index);
            expect(chain).to.equal('BTC');
            expect(method).to.equal('getblockhashes');
            expect(params).to.deep.equal({ block_index: answer.block_index });
            return Object.assign({}, answer);
        }),
    };
    const engine = new SnapshotCheckpointEngine(source);
    return {
        engine,
        source,
        db,
        rows,
        identity,
        peerManager,
        setTip(value) { tip = value; },
        setBlock(value) { indexerBlock = value; },
    };
}

function registerGateTests() {
    it('reads a BTC-height hub gate armed on regtest and on testnet at its v0.25.0 heights', function () {
        const row = gateRegistry.get(GATE);
        // The v0.25.0 cut arms BTC:testnet at 157073.
        expect(row).to.deep.equal({
            mainnet: gateRegistry.UNARMED,
            'BTC:testnet': 157073,
            'LTC:testnet': 4928460,
            'DOGE:testnet': 68009330,
            testnet: gateRegistry.UNARMED,
            regtest: 0,
        });
        expect(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 0, 0)).to.equal(true);
        expect(gateRegistry.activeAt(GATE, 'testnet', 'BTC', 157072, 0)).to.equal(false);
        expect(gateRegistry.activeAt(GATE, 'testnet', 'BTC', 157073, 0)).to.equal(true);
        expect(gateRegistry.activeAt(GATE, 'mainnet', 'BTC', 1000000, 0)).to.equal(false);
    });

    for (const network of ['testnet', 'mainnet']) {
        it('produces nothing while the gate is unarmed on ' + network, async function () {
            const h = harness({ network });
            await h.engine.tick();
            expect(h.db.insertSnapshotCheckpoint.called).to.equal(false);
            expect(h.source.indexerCall.called).to.equal(false);
            expect(h.identity.sign.called).to.equal(false);
        });
    }
}

// The v0.25.0 testnet arming names the BTC-anchored height under 'BTC:testnet' and keeps
// the bare testnet entry UNARMED. The scan floor must read the coin-scoped entry the way
// activeAt does, or no testnet snapshot is ever checkpointed and every TLTC and TDOGE
// mirror row waits on a proof that never comes.
function registerCoinScopedGateTests() {
    afterEach(function () { sinon.restore(); });

    function stubCoinScopedGate(table) {
        const realGet = gateRegistry.get;
        const realActiveAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'get').callsFake(gateKey =>
            gateKey === GATE ? table : realGet(gateKey));
        sinon.stub(gateRegistry, 'activeAt').callsFake((gateKey, network, coin, height, time) => {
            if (gateKey !== GATE) return realActiveAt(gateKey, network, coin, height, time);
            const scoped = coin + ':' + network;
            const threshold = Object.prototype.hasOwnProperty.call(table, scoped) ? table[scoped] : table[network];
            return Number.isSafeInteger(threshold) && height >= threshold;
        });
    }

    it('scans from the BTC:<network> height when only the coin-scoped entry is armed', async function () {
        stubCoinScopedGate({
            mainnet: gateRegistry.UNARMED,
            'BTC:testnet': 157073,
            'LTC:testnet': 4928460,
            'DOGE:testnet': 68009330,
            testnet: gateRegistry.UNARMED,
            regtest: 0,
        });
        const h = harness({ network: 'testnet', due: [157080], tip: 157120 });

        expect(h.engine.gateHeight()).to.equal(157073);
        await h.engine.tick();

        expect(h.db.listUncheckpointedSnapshotBlocks.firstCall.args)
            .to.deep.equal(['testnet', 157073, 6, 10]);
        expect([...h.rows.values()].map(row => row.block_index)).to.deep.equal([157074]);
    });

    it('falls back to the bare network entry and stays unarmed when neither is armed', function () {
        stubCoinScopedGate({ mainnet: gateRegistry.UNARMED, testnet: 42, regtest: 0 });
        expect(harness({ network: 'testnet' }).engine.gateHeight()).to.equal(42);
        expect(harness({ network: 'mainnet' }).engine.gateHeight()).to.equal(gateRegistry.UNARMED);
    });
}

function registerSoleValidatorTests() {
    it('persists one sole-validator row per distinct snapshot block, oldest first', async function () {
        const h = harness({ due: [118, 106, 112, 106] });

        await h.engine.tick();
        await h.engine.tick();
        await h.engine.tick();

        expect([...h.rows.values()].map(row => row.block_index)).to.deep.equal([100, 106, 112]);
        expect(h.db.listUncheckpointedSnapshotBlocks.firstCall.args)
            .to.deep.equal(['regtest', 0, 6, 10]);
        for (const row of h.rows.values()) {
            expect(row).to.include({
                chain: 'BTC',
                network: 'regtest',
                block_hash: hash('a'),
                state_root: hash('b'),
                state_root_version: 1,
            });
            expect(JSON.parse(row.validator_signatures)).to.deep.equal([{
                pubkey: key('1'),
                sig: 'f'.repeat(128),
            }]);
        }
    });

    it('waits until the BTC tip reaches the checkpoint plus confirmations', async function () {
        const h = harness({ tip: 105 });
        await h.engine.tick();
        expect(h.source.indexerCall.called).to.equal(false);
        expect(h.db.insertSnapshotCheckpoint.called).to.equal(false);

        h.setTip(106);
        await h.engine.tick();
        expect(h.db.insertSnapshotCheckpoint.calledOnce).to.equal(true);
    });
}

function registerLeaderTests() {
    it('rotates the leader over sorted distinct validator pubkeys', async function () {
        const validators = [
            { pubkey: key('2') },
            { pubkey: key('1') },
            { pubkey: key('2') },
        ];
        const leading = harness({ validators, due: [106], block: block(100) });
        sinon.stub(leading.engine, 'leadRound').resolves();
        await leading.engine.tick();
        expect(leading.engine.leadRound.calledOnce).to.equal(true);
        expect(leading.engine.leadRound.firstCall.args[1].map(row => row.pubkey))
            .to.deep.equal([key('1'), key('2')]);

        const following = harness({ validators, due: [107], block: block(101) });
        sinon.stub(following.engine, 'leadRound').resolves();
        await following.engine.tick();
        expect(following.engine.leadRound.called).to.equal(false);
        expect(following.identity.sign.called).to.equal(false);
    });

    it('hands a multi-member payload to leadRound without writing either checkpoint family', async function () {
        const h = harness({ validators: [{ pubkey: key('1') }, { pubkey: key('2') }] });
        sinon.stub(h.engine, 'leadRound').resolves();
        await h.engine.tick();

        expect(h.engine.leadRound.calledOnce).to.equal(true);
        expect(h.engine.leadRound.firstCall.args[0]).to.deep.equal({
            chain: 'BTC',
            network: 'regtest',
            block_index: 100,
            block_hash: hash('a'),
            state_root: hash('b'),
            state_root_version: 1,
        });
        expect(h.db.insertSnapshotCheckpoint.called).to.equal(false);
        expect(h.db.insertStateCheckpoint.called).to.equal(false);
        expect(h.peerManager.broadcast.called).to.equal(false);
    });
}

function registerRefusalTests() {
    it('refuses rootless blocks before signing', async function () {
        const h = harness({ block: block(100, { state_root: null }) });
        await h.engine.tick();
        expect(h.identity.sign.called).to.equal(false);
        expect(h.db.insertSnapshotCheckpoint.called).to.equal(false);
    });

    it('refuses a payload that conflicts with the row already stored at B', async function () {
        const h = harness({
            stored: [checkpoint('regtest', 100, { block_hash: hash('c') })],
        });
        h.db.listUncheckpointedSnapshotBlocks = sinon.spy(async () => [{ snapshot_block: 106 }]);
        await h.engine.tick();
        expect(h.identity.sign.called).to.equal(false);
        expect(h.db.insertSnapshotCheckpoint.called).to.equal(false);
    });

    it('keeps the first signed payload and refuses another payload for the same B', async function () {
        const h = harness({ validators: [{ pubkey: key('1') }, { pubkey: key('2') }] });
        sinon.stub(h.engine, 'leadRound').resolves();
        await h.engine.tick();
        h.setBlock(block(100, { block_hash: hash('c') }));
        await h.engine.tick();

        expect(h.identity.sign.calledOnce).to.equal(true);
        expect(h.engine.leadRound.calledOnce).to.equal(true);
        expect(h.db.insertSnapshotCheckpoint.called).to.equal(false);
    });
}

describe('SnapshotCheckpointEngine', function () {
    registerGateTests();
    registerCoinScopedGateTests();
    registerSoleValidatorTests();
    registerLeaderTests();
    registerRefusalTests();
});
