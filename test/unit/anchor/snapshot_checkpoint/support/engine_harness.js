'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The SnapshotCheckpointEngine test harness: a fake db, indexer, identity and peer manager
// around one engine, shared by the engine suites.

const { expect } = require('chai');
const sinon = require('sinon');
const SnapshotCheckpointEngine = require(
    '../../../../../src/anchor/snapshot_checkpoint/engine.js');

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

module.exports = { key, hash, block, checkpoint, harness };
