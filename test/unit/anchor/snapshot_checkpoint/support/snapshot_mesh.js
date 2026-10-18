'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const { leadsSnapshotSlot } = require('../../../../../src/anchor/snapshot_checkpoint/leader.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const SNAPSHOT_DB_METHODS = require('../../../../../src/db/snapshots/snapshot_checkpoints.js');

const NETWORK = 'regtest';
const DEFAULT_TIMEOUT_MS = 30;
const COLUMNS = [
    'chain', 'network', 'block_index', 'block_hash', 'state_root',
    'state_root_version', 'validator_signatures'
];

function copy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function indexerRow(blockIndex) {
    const hash = tag => crypto.createHash('sha256')
        .update([NETWORK, tag, blockIndex].join(':')).digest('hex');
    return {
        block_index: blockIndex,
        block_hash: hash('block'),
        network: NETWORK,
        state_root: hash('root'),
        state_root_version: 1
    };
}

function memoryDb() {
    const rows = new Map();
    let snapshotBlocks = [];
    const queries = [];
    const key = (chain, network, blockIndex) => [chain, network, blockIndex].join('|');

    return {
        ...DB_METHODS,
        ...SNAPSHOT_DB_METHODS,
        queries,
        seedSnapshots(blocks) {
            snapshotBlocks = Array.isArray(blocks) ? blocks.slice() : [];
        },
        async doQuery(sql, params = []) {
            queries.push(sql);
            if (sql.startsWith('INSERT IGNORE INTO snapshot_checkpoints')) {
                const row = Object.fromEntries(COLUMNS.map((column, i) => [column, params[i]]));
                const rowKey = key(row.chain, row.network, row.block_index);
                if (rows.has(rowKey)) return { affectedRows: 0 };
                rows.set(rowKey, copy(row));
                return { affectedRows: 1 };
            }
            if (sql.startsWith('SELECT * FROM snapshot_checkpoints')) {
                const row = rows.get(key(params[0], params[1], params[2]));
                return row ? [copy(row)] : [];
            }
            if (sql.startsWith('SELECT DISTINCT cs.snapshot_block')) {
                const from = Number(params[1]);
                const burial = Number(params[4]);
                const limit = Number(params[5]);
                const distinct = [...new Set(snapshotBlocks.map(Number))]
                    .filter(block => block >= from)
                    .filter(block => !rows.has(key(params[2], params[3], block - burial)))
                    .sort((a, b) => a - b)
                    .slice(0, limit);
                return distinct.map(block => ({ snapshot_block: block }));
            }
            return [];
        }
    };
}

function makeNode(bus, index, identity, timeoutMs) {
    const node = {
        index,
        identity,
        pubkey: identity.getPubkeyHex().toLowerCase(),
        btcTip: bus.chainTip,
        indexerDown: false,
        engine: null
    };
    let handler = null;
    const changes = new Map();
    const peerManager = {
        on(event, listener) {
            if (event === 'message') handler = listener;
        },
        removeListener(event) {
            if (event === 'message') handler = null;
        },
        broadcast(type, data) {
            const envelope = { type, sender: node.pubkey, data: copy(data) };
            bus.sent.push({ type, sender: node.pubkey });
            for (const target of bus.nodes) {
                if (target === node || !target.receive) continue;
                if (bus.drop && bus.drop(envelope, node, target)) continue;
                target.receive(copy(envelope));
            }
        }
    };

    node.receive = envelope => {
        if (handler) handler(envelope);
    };
    node.tamper = (blockIndex, fields) => {
        changes.set(blockIndex, { ...(changes.get(blockIndex) || {}), ...copy(fields) });
    };
    node.db = memoryDb();
    node.hub = {
        db: node.db,
        network: NETWORK,
        p2pConfig: {
            CHECKPOINT_CHAINS: 'BTC',
            CHECKPOINT_CONFIRMATIONS: '0',
            CHECKPOINT_ROUND_TIMEOUT_MS: String(timeoutMs)
        },
        capabilitySnapshot: {
            async getSnapshot() {
                return { validators: copy(bus.validators) };
            },
            async getWeightSnapshot() {
                return { validators: copy(bus.validators) };
            }
        },
        getPeerManager: () => peerManager,
        getIdentity: () => identity,
        resolveBtcLatestBlock: async () => node.btcTip
    };
    node.stateCheckpoints = {
        hub: node.hub,
        network: NETWORK,
        identity,
        peerManager,
        roundTimeoutMs: timeoutMs,
        async indexerCall(coin, method, params) {
            if (node.indexerDown) throw new Error('indexer unavailable');
            const blockIndex = Number(params && params.block_index);
            if (blockIndex > bus.chainTip) return null;
            return { ...indexerRow(blockIndex), ...(changes.get(blockIndex) || {}) };
        },
        async resolveCapabilityValidators() {
            return copy(bus.validators);
        }
    };
    return node;
}

function buildSnapshotMesh(options = {}) {
    const n = options.n == null ? 3 : options.n;
    const timeoutMs = options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    const bus = {
        network: NETWORK,
        nodes: [],
        validators: [],
        sent: [],
        drop: null,
        chainTip: 500
    };
    const identities = Array.from({ length: n }, (_, index) => new ValidatorIdentity(
        crypto.createHash('sha256').update('snapshot-hub-' + index).digest('hex')));
    bus.validators = identities.map((identity, index) => ({
        pubkey: identity.getPubkeyHex().toLowerCase(),
        source: 'src' + index,
        weight: '100',
        amount: '100'
    }));
    bus.nodes = identities.map((identity, index) => makeNode(bus, index, identity, timeoutMs));
    bus.setTip = blockIndex => {
        for (const node of bus.nodes) node.btcTip = blockIndex;
    };
    bus.leaderAt = blockIndex => bus.nodes.find(node =>
        leadsSnapshotSlot(blockIndex, bus.validators, node.pubkey));
    return bus;
}

module.exports = { buildSnapshotMesh };
