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

// An in-process checkpoint federation for the cadence liveness suites: n engines over
// one synchronous gossip bus, each with its own in-memory state_checkpoints table, its
// own BTC tip (so tips can skew between hubs) and a stubbed indexer that can be taken
// down per hub. Rounds run with a short timeout so a walk over many blocks stays fast.

const crypto                = require('crypto');
const StateCheckpointEngine = require('../../../../../../src/anchor/checkpoint_engine');
const ValidatorIdentity     = require('../../../../../../src/validators/identity');
const { DB_METHODS }        = require('../../../../../helpers/mockHub.js');

const NET = 'regtest';
const ROUND_TIMEOUT_MS = 30;
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 10; i++) await sleep(1); };

// The indexer's per-block hash set at height n: a pure function of (n, network).
function blockHashes(n, network) {
    const h = (tag) => crypto.createHash('sha256').update(tag + ':' + n).digest('hex');
    return {
        block_index: n, block_hash: h('blk'), network,
        ledger_hash: h('led'), actions_hash: h('act'), contract_hash: h('con'),
        state_root: h('sr'), state_root_version: 1, block_merkle_root: h('bm'), block_merkle_version: 1
    };
}

function maxOf(rows, pick) {
    let m = null;
    for (const r of rows) if (m == null || pick(r) > m) m = pick(r);
    return m;
}

function insertCheckpoint(checkpoints, p) {
    const [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash,
           checkpoint_seq, snapshot_block, state_root, state_root_version,
           block_merkle_root, block_merkle_version, validator_signatures] = p;
    if (checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq)) return;
    checkpoints.push({ chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash,
                       checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root,
                       block_merkle_version, validator_signatures });
}

// state_checkpoints and capability_snapshots, enough for the engine's reads and writes.
function memDb() {
    const checkpoints = [];
    return { ...DB_METHODS, checkpoints,
        async doQuery(sql, p) {
            p = p || [];
            if (sql.startsWith('SELECT MAX(snapshot_block)'))
                return [{ last_block: maxOf(checkpoints.filter(r => r.network === p[0]), r => r.snapshot_block) }];
            if (sql.startsWith('SELECT MAX(checkpoint_seq)'))
                return [{ max_seq: maxOf(checkpoints.filter(r => r.chain === p[0] && r.network === p[1]), r => r.checkpoint_seq) }];
            if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) { insertCheckpoint(checkpoints, p); return []; }
            if (sql.startsWith('SELECT * FROM state_checkpoints') && sql.includes('block_index'))
                return checkpoints.filter(r => r.chain === p[0] && r.network === p[1] && r.block_index === p[2] && r.checkpoint_seq === p[3]).slice(0, 1);
            if (sql.startsWith('SELECT * FROM state_checkpoints'))
                return checkpoints.filter(r => r.chain === p[0] && r.network === p[1] && r.checkpoint_seq === p[2]).slice(0, 1);
            return [];
        }
    };
}

function hubConfig(opts) {
    return {
        CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0', CHECKPOINT_INTERVAL_BLOCKS: '6',
        BTC_INDEXER_URL: 'http://stub', CHECKPOINT_ROUND_TIMEOUT_MS: String(opts.timeoutMs || ROUND_TIMEOUT_MS)
    };
}

// One hub: its peer manager on the bus, its hub double, and an engine factory so a
// restart can boot a fresh engine over the same DB and identity.
function makeNode(bus, i, identity, opts) {
    const self = { i, identity, pubkey: identity.getPubkeyHex().toLowerCase(), handler: null, btcTip: 100, indexerDown: false };
    const peerManager = {
        on(evt, h) { if (evt === 'message') self.handler = h; },
        removeListener(evt) { if (evt === 'message') self.handler = null; },
        broadcast(type, data) {
            const env = { type, sender: self.pubkey, data: JSON.parse(JSON.stringify(data)) };
            for (const other of bus.nodes) {
                if (other === self || !other.handler) continue;
                if (bus.drop && bus.drop(env, self, other)) continue;
                other.handler(env);
            }
        }
    };
    self.db = memDb();
    self.hub = {
        db: self.db, network: NET, p2pConfig: hubConfig(opts),
        hubDbBroadcaster: { subscribers: new Set(), broadcastRow() {} },
        capabilitySnapshot: {
            async getSnapshot() { return { validators: bus.validators.map(v => ({ pubkey: v.pubkey, amount: v.amount })) }; },
            async getWeightSnapshot() { return { validators: bus.validators.map(v => ({ pubkey: v.pubkey, source: v.source, weight: v.weight })) }; }
        },
        getPeerManager: () => peerManager,
        getIdentity: () => identity,
        resolveBtcLatestBlock: async () => self.btcTip
    };
    self.makeEngine = () => {
        const e = new StateCheckpointEngine(self.hub);
        e.indexerCall = async (coin, method, params) => {
            if (self.indexerDown) throw new Error('indexer down (injected)');
            const n = (params && params.block_index != null) ? params.block_index : bus.chainTip;
            return n > bus.chainTip ? null : blockHashes(n, NET);
        };
        return e;
    };
    self.engine = self.makeEngine();
    return self;
}

// opts: n (hubs), timeoutMs (round timeout). Every hub holds equal stake.
function buildMesh(opts) {
    const n = opts.n || 3;
    const bus = { nodes: [], chainTip: 500, drop: null };
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(new ValidatorIdentity(crypto.createHash('sha256').update('hub-' + i).digest('hex')));
    bus.validators = ids.map((id, i) => ({ pubkey: id.getPubkeyHex().toLowerCase(), source: 'src' + i, weight: '100', amount: '100' }));
    for (let i = 0; i < n; i++) bus.nodes.push(makeNode(bus, i, ids[i], opts));
    bus.roundWaitMs = (opts.timeoutMs || ROUND_TIMEOUT_MS) + 10;
    bus.setTip = (b) => { for (const nd of bus.nodes) nd.btcTip = b; };
    bus.startAll = async () => { for (const nd of bus.nodes) await nd.engine.start(); };
    bus.stopAll = async () => { for (const nd of bus.nodes) await nd.engine.stop(); };
    bus.tickAll = async () => { for (const nd of bus.nodes) await nd.engine.tick(); await settle(); };
    // Crash and restart: a fresh engine over the same DB and identity, so in-memory round
    // state is gone and the finalized latch is reseeded from persisted rows.
    bus.restart = async (nd) => { await nd.engine.stop(); nd.engine = nd.makeEngine(); await nd.engine.start(); };
    bus.leaderAt = (b) => { const pks = bus.validators.map(v => v.pubkey).sort(); return bus.nodes.find(nd => nd.pubkey === pks[b % pks.length]); };
    bus.snapshots = (nd) => nd.db.checkpoints.map(r => r.snapshot_block);
    return bus;
}

// Walk every hub's BTC tip over from..to, ticking each block twice with a round
// timeout between, so timed-out rounds and their retries get their turn.
async function walk(bus, from, to) {
    for (let b = from; b <= to; b++) {
        bus.setTip(b); await bus.tickAll(); await sleep(bus.roundWaitMs); await bus.tickAll();
    }
}

// The cadence invariants every liveness suite checks on a hub's persisted snapshots
// after the seed checkpoint at 100: one checkpoint per interval at most (consecutive
// snapshots at least `interval` apart) and a first checkpoint after the seed no later
// than `firstBy` (by default inside the first due interval, so it was not skipped).
function cadenceViolations(snaps, interval, firstBy) {
    const out = [];
    for (let k = 1; k < snaps.length; k++)
        if (snaps[k] - snaps[k - 1] < interval) out.push('two checkpoints in one interval: ' + snaps[k - 1] + ', ' + snaps[k]);
    const limit = firstBy != null ? firstBy : snaps[0] + 2 * interval - 1;
    if (snaps.length < 2 || snaps[1] > limit) out.push('no checkpoint after ' + snaps[0] + ' by ' + limit + ': ' + JSON.stringify(snaps));
    return out;
}

module.exports = { buildMesh, walk, cadenceViolations, blockHashes, sleep, settle, NET };
