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

// (Pkg 8, item 929): the checkpoint cadence latch must advance on
// PEER-led rounds too, not only on the rounds this hub leads.
//
// `_loadLastCheckpointLatch` seeds the latch fleet-wide (MAX(snapshot_block)
// over rows written by ANY leader), but at runtime it used to be written only in
// the leader branch of `_tick`. With N validators and leader = btcBlock % N,
// every hub's latch was stale on the N-1 blocks it did not lead, so each hub
// re-led at its own residue and the FEDERATION produced a checkpoint roughly
// every intervalBlocks / N blocks: checkpoint_seq (and with it
// ANCHOR_CHECKPOINT_EVERY_N, defined against seq % N) ran N times faster than
// CHECKPOINT_INTERVAL_BLOCKS configured, burning DOGE on the extra anchors.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
const ValidatorIdentity     = require('../../src/ValidatorIdentity');
const { waitUntil }         = require('../helpers/waitUntil');

// Kept for the block-walk loop below, where the settle bounds how often the walk
// re-ticks rather than standing in for a condition.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

describe('StateCheckpointEngine cadence latch', function () {

    let meshes = [];

    afterEach(async function () {
        for (let bus of meshes) { for (let nd of bus.nodes) await nd.engine.stop(); }
        meshes = [];
    });

    // Minimal in-memory state_checkpoints + capability_snapshots store.
    function memDb() {
        let checkpoints = [], snapshots = [];
        return {
            checkpoints, snapshots,
            async doQuery(sql, params) {
                if (sql.startsWith('SELECT COALESCE(MAX(checkpoint_seq)')) {
                    let max = -1;
                    for (let r of checkpoints) if (r.chain === params[0] && r.network === params[1] && r.checkpoint_seq > max) max = r.checkpoint_seq;
                    return [{ next_seq: max + 1 }];
                }
                if (sql.startsWith('SELECT MAX(checkpoint_seq)')) {
                    let max = null;
                    for (let r of checkpoints) if (r.chain === params[0] && r.network === params[1] && (max == null || r.checkpoint_seq > max)) max = r.checkpoint_seq;
                    return [{ max_seq: max }];
                }
                if (sql.startsWith('SELECT MAX(snapshot_block)')) {
                    let max = null;
                    for (let r of checkpoints) if (max == null || r.snapshot_block > max) max = r.snapshot_block;
                    return [{ last_block: max }];
                }
                if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) {
                    let [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash,
                         checkpoint_seq, snapshot_block, state_root, state_root_version,
                         block_merkle_root, block_merkle_version, validator_signatures] = params;
                    if (!checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq))
                        checkpoints.push({ id: checkpoints.length + 1, chain, network, block_index, block_hash,
                                           ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block,
                                           state_root, state_root_version, block_merkle_root, block_merkle_version,
                                           validator_signatures });
                    return [];
                }
                if (sql.startsWith('SELECT * FROM state_checkpoints'))
                    return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] &&
                                                   r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
                if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                    let [snapshot_block, capability, signing_pubkey, amount] = params;
                    if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
                        snapshots.push({ id: snapshots.length + 1, snapshot_block, capability, signing_pubkey, amount });
                    return [];
                }
                if (sql.startsWith('SELECT * FROM capability_snapshots'))
                    return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] &&
                                                 r.signing_pubkey === params[2]).slice(0, 1);
                return [];
            }
        };
    }

    // n engines over one in-process gossip bus; bus.btcBlock drives the election.
    function buildMesh(n) {
        let bus = { nodes: [], btcBlock: 100 };
        let identities = [];
        for (let i = 0; i < n; i++) identities.push(new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64)));
        let validators = identities.map(id => ({ pubkey: id.getPubkeyHex().toLowerCase(), amount: '1' }));

        for (let i = 0; i < n; i++) {
            let identity = identities[i];
            let self = { i, identity, pubkey: identity.getPubkeyHex().toLowerCase(), handler: null };
            let peerManager = {
                on(evt, h) { if (evt === 'message') self.handler = h; },
                removeListener(evt) { if (evt === 'message') self.handler = null; },
                broadcast(type, data) {
                    let env = { type, sender: self.pubkey, data };
                    for (let other of bus.nodes) { if (other !== self && other.handler) other.handler(env); }
                }
            };
            let db = memDb();
            let hub = {
                db,
                p2pConfig: {
                    CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0',
                    CHECKPOINT_INTERVAL_BLOCKS: '6', BTC_INDEXER_URL: 'http://stub'
                },
                hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } },
                capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } },
                getPeerManager: () => peerManager,
                getIdentity: () => identity,
                _resolveBtcLatestBlock: async () => bus.btcBlock
            };
            self.db = db; self.hub = hub;
            self.engine = new StateCheckpointEngine(hub);
            self.engine._indexerCall = async () => Object.assign({}, TIP);
            bus.nodes.push(self);
        }
        meshes.push(bus);
        return bus;
    }

    it('N=3: the federation checkpoints once per CHECKPOINT_INTERVAL_BLOCKS, not once per leader rotation', async function () {
        let bus = buildMesh(3);
        for (let nd of bus.nodes) await nd.engine.start();

        // Walk BTC blocks 100..104 (interval 6, so exactly ONE round is due).
        // Pre-fix each hub led at its own residue and the mesh produced three.
        for (let b = 100; b <= 104; b++) {
            bus.btcBlock = b;
            for (let nd of bus.nodes) await nd.engine._tick();
            await sleep(20);
        }

        for (let nd of bus.nodes)
            expect(nd.db.checkpoints.length, 'node ' + nd.i + ' checkpoint rows').to.equal(1);

        // Every hub's latch tracks the finalized round, whoever led it.
        let seq = bus.nodes[0].db.checkpoints[0].snapshot_block;
        for (let nd of bus.nodes)
            expect(nd.engine._lastCheckpointBtcBlock, 'node ' + nd.i + ' latch').to.equal(seq);

        // The next round waits for a full interval past that snapshot_block.
        bus.btcBlock = seq + 5;
        for (let nd of bus.nodes) await nd.engine._tick();
        // Every tick is awaited and the latch refuses inside it, so the inside-interval
        // no-op is already decided here.
        for (let nd of bus.nodes)
            expect(nd.db.checkpoints.length, 'node ' + nd.i + ' still one round inside the interval').to.equal(1);

        bus.btcBlock = seq + 6;
        for (let nd of bus.nodes) await nd.engine._tick();
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints.length === 2), { label: 'the past-interval round to land on every hub' });
        for (let nd of bus.nodes)
            expect(nd.db.checkpoints.length, 'node ' + nd.i + ' second round past the interval').to.equal(2);
    });

    it('a peer-led finalized checkpoint advances this hub\'s latch, and the latch never walks backwards', async function () {
        let bus = buildMesh(3);
        let nd  = bus.nodes[0];
        await nd.engine.start();
        expect(nd.engine._lastCheckpointBtcBlock, 'no rows yet').to.equal(null);

        let cp = Object.assign({}, TIP, {
            chain: 'BTC', network: 'regtest', checkpoint_seq: StateCheckpointEngine.deriveCheckpointSeq(200),
            snapshot_block: 200
        });
        await nd.engine._acceptFinalized(cp, [], 1, false);          // peer-led (isLeader false)
        expect(nd.engine._lastCheckpointBtcBlock, 'peer round advances the latch').to.equal(200);

        // An out-of-order / replayed FINALIZED for an EARLIER snapshot_block must not
        // rewind the latch into an early extra round.
        let older = Object.assign({}, cp, { block_index: 400, checkpoint_seq: StateCheckpointEngine.deriveCheckpointSeq(150), snapshot_block: 150 });
        await nd.engine._acceptFinalized(older, [], 1, false);
        expect(nd.engine._lastCheckpointBtcBlock, 'latch is monotonic').to.equal(200);
    });
});
