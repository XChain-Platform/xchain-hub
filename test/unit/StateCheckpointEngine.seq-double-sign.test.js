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
// ONE SIGNED PAYLOAD PER CHECKPOINT SEQUENCE.
//
// checkpoint_seq is derived from snapshot_block, and every co-sign guard keys on
// snapshot_block, so a cadence leader that proposes two DIFFERENT block_index values at
// one snapshot_block clears all of them twice. A follower that answers both hands the
// leader two quorum-signed checkpoints at one sequence; the unique key then seats
// whichever FINALIZED each hub received first and the fleet holds divergent state at
// that sequence, which the persist fence can report but cannot undo.
//
// The engine therefore remembers the canonical it signed at each (chain, network, seq)
// and refuses a second, different one. The cost is bounded and is measured by the
// second test here: a leader that loses a round in flight and re-proposes a NEW block at
// the same snapshot_block is refused, that one round is skipped, and the next cadence
// checkpoints normally.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
const ValidatorIdentity     = require('../../src/ValidatorIdentity');
const { waitUntil }         = require('../helpers/waitUntil');

// Deterministic 64-hex block data, distinct per height, so two heights produce two
// different canonicals and each is confirmable by a follower's own indexer.
function blockAt(n) {
    const h = (tag) => (tag + Number(n).toString(16).padStart(6, '0')).padEnd(64, '0');
    return {
        block_index: Number(n), network: 'regtest',
        block_hash: h('b1'), ledger_hash: h('a1'), actions_hash: h('c1'), contract_hash: h('d1'),
        // regtest CHECKPOINT_COMMITMENT flag-day is 0, so the engine refuses to sign
        // without the light-client roots; carry them.
        state_root: h('e1'), state_root_version: 1,
        block_merkle_root: h('f1'), block_merkle_version: 1
    };
}

describe('StateCheckpointEngine: one signed payload per sequence', function () {

    let buses = [];

    afterEach(async function () {
        for (let bus of buses) { for (let nd of bus.nodes) await nd.engine.stop(); }
        buses = [];
    });

    // Minimal in-memory hub DB: state_checkpoints + capability_snapshots, keyed by the
    // real (chain, network, checkpoint_seq) unique index.
    function memDb() {
        let checkpoints = [];
        let snapshots   = [];
        return {
            checkpoints, snapshots,
            async doQuery(sql, params) {
                if (sql.startsWith('SELECT MAX(checkpoint_seq)')) {
                    let max = null;
                    for (let r of checkpoints)
                        if (r.chain === params[0] && r.network === params[1] && (max == null || r.checkpoint_seq > max)) max = r.checkpoint_seq;
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
                if (sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?'))
                    return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] &&
                                                   r.checkpoint_seq === params[2]).slice(0, 1);
                if (sql.startsWith('SELECT * FROM state_checkpoints'))
                    return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] &&
                                                   r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
                if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                    for (let i = 0; i + 4 < params.length; i += 5) {
                        let [snapshot_block, capability, signing_pubkey, amount] = params.slice(i, i + 5);
                        if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
                            snapshots.push({ id: snapshots.length + 1, snapshot_block, capability, signing_pubkey, amount });
                    }
                    return [];
                }
                if (sql.startsWith('SELECT * FROM capability_snapshots'))
                    return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] &&
                                                 r.signing_pubkey === params[2]).slice(0, 1);
                return [];
            }
        };
    }

    // n engines over a shared in-memory gossip bus. opts is read at call time, so a test
    // moves the BTC tip (opts.btcBlock), the chain tip (opts.tip) or the drop filter
    // (opts.drop) between ticks.
    function buildMesh(n, opts) {
        let bus = { nodes: [] };
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
                    for (let other of bus.nodes) {
                        if (other === self) continue;
                        if (opts.drop && opts.drop(self, other, type, data)) continue;
                        if (other.handler) other.handler(env);
                    }
                }
            };
            let db  = memDb();
            let hub = {
                db,
                p2pConfig: {
                    CHECKPOINT_CHAINS: 'BTC', CHECKPOINT_CONFIRMATIONS: '0',
                    BTC_INDEXER_URL: 'http://stub'
                },
                hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } },
                capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } },
                getPeerManager: () => peerManager,
                getIdentity: () => identity,
                _resolveBtcLatestBlock: async () => opts.btcBlock
            };
            self.db  = db;
            self.hub = hub;
            self.engine = newEngine(self, opts);
            bus.nodes.push(self);
        }
        buses.push(bus);
        return bus;
    }

    // A fresh engine over a node's existing hub + DB, which is also how a restart is
    // modelled: the process-lifetime state is gone, the durable state is not.
    function newEngine(self, opts) {
        let engine = new StateCheckpointEngine(self.hub);
        engine._indexerCall = async (coin, method, params) =>
            blockAt(params && params.block_index != null ? params.block_index : opts.tip);
        return engine;
    }

    function leaderNode(bus, btcBlock) {
        let leaderPk = bus.nodes.map(nd => nd.pubkey).sort()[btcBlock % bus.nodes.length];
        return bus.nodes.find(nd => nd.pubkey === leaderPk);
    }

    // Record XCHK_SIGN co-sign broadcasts leaving a node.
    function watchCosign(node) {
        let signs = [];
        let pm = node.engine.peerManager;
        let orig = pm.broadcast.bind(pm);
        pm.broadcast = (type, data) => { if (type === 'XCHK_SIGN') signs.push(data); return orig(type, data); };
        return signs;
    }

    // A leader-signed SIGN_REQ for `blockIndex` at `snap`, exactly as a cadence leader
    // free to pick its own confirmation depth would put on the wire.
    function signReqFor(leader, snap, blockIndex) {
        let bh = blockAt(blockIndex);
        let cp = {
            chain: 'BTC', network: bh.network, block_index: bh.block_index,
            block_hash: bh.block_hash, ledger_hash: bh.ledger_hash,
            actions_hash: bh.actions_hash, contract_hash: bh.contract_hash,
            checkpoint_seq: StateCheckpointEngine.deriveCheckpointSeq(snap), snapshot_block: snap,
            state_root: bh.state_root, state_root_version: bh.state_root_version,
            block_merkle_root: bh.block_merkle_root, block_merkle_version: bh.block_merkle_version
        };
        let sig = leader.identity.sign(StateCheckpointEngine.canonicalCheckpoint(cp));
        return { type: 'XCHK_SIGN_REQ', sender: leader.pubkey,
                 data: { checkpoint: cp, sig_pubkey: leader.pubkey, sig } };
    }

    it('co-signs one payload at a sequence and refuses a second, different one', async function () {
        const SNAP = 500;
        let opts = { btcBlock: SNAP, tip: 500 };
        let bus  = buildMesh(2, opts);
        let leader   = leaderNode(bus, SNAP);
        let follower = bus.nodes.find(nd => nd !== leader);
        let signs = watchCosign(follower);

        // Both blocks are real on the follower's own indexer, both carry the roots, both
        // sit at the same snapshot_block: every existing guard passes for each.
        await follower.engine._handleSignReq(signReqFor(leader, SNAP, 500));
        await follower.engine._handleSignReq(signReqFor(leader, SNAP, 499));

        expect(signs.length, 'exactly one signature left the hub for this sequence').to.equal(1);
        expect(follower.engine._seqDoubleSignRefusals, 'the second is counted').to.equal(1);
        expect((await follower.engine.getStats()).seq_double_sign_refusals,
            'and is operator-visible').to.equal(1);
    });

    it('re-delivery of the SAME payload still co-signs (idempotent, not an equivocation)', async function () {
        const SNAP = 500;
        let opts = { btcBlock: SNAP, tip: 500 };
        let bus  = buildMesh(2, opts);
        let leader   = leaderNode(bus, SNAP);
        let follower = bus.nodes.find(nd => nd !== leader);
        let signs = watchCosign(follower);

        await follower.engine._handleSignReq(signReqFor(leader, SNAP, 500));
        await follower.engine._handleSignReq(signReqFor(leader, SNAP, 500));

        expect(signs.length, 'a duplicate gossip delivery is answered, not refused').to.equal(2);
        expect(follower.engine._seqDoubleSignRefusals, 'nothing is metered').to.equal(0);
    });

    it('costs one skipped round when a leader loses a round and re-proposes a new block', async function () {
        const SNAP = 100;
        let dropSigns = true;
        let opts = { btcBlock: SNAP, tip: 500, drop: (from, to, type) => dropSigns && type === 'XCHK_SIGN' };
        let bus  = buildMesh(2, opts);
        for (let nd of bus.nodes) await nd.engine.start();

        // Round one: the leader proposes block 500 at snapshot 100, the follower
        // co-signs, and the co-signature never reaches the leader. Nothing finalizes.
        let leader   = leaderNode(bus, SNAP);
        let follower = bus.nodes.find(nd => nd !== leader);
        let signs    = watchCosign(follower);
        await leader.engine._tick();
        await waitUntil(() => signs.length === 1, { label: 'the follower to co-sign the first proposal' });
        expect(bus.nodes.every(nd => nd.db.checkpoints.length === 0),
            'the dropped co-signature leaves the round short of quorum').to.equal(true);

        // The leader restarts mid-round: pending state is gone, the cadence latch reloads
        // from persisted rows (there are none), and the chain tip has moved on.
        await leader.engine.stop();
        opts.tip  = 501;
        dropSigns = false;
        leader.engine = newEngine(leader, opts);
        await leader.engine.start();
        await leader.engine._tick();
        await waitUntil(() => follower.engine._seqDoubleSignRefusals === 1,
            { label: 'the follower to refuse the second payload at that sequence' });

        expect(signs.length, 'no second signature left the follower').to.equal(1);
        expect(bus.nodes.every(nd => nd.db.checkpoints.length === 0),
            'the retry at a new block under the same sequence finalizes nothing').to.equal(true);

        // Next cadence (default interval 6 BTC blocks): a new snapshot_block is a new
        // sequence, so the federation checkpoints normally. The cost was one round.
        opts.btcBlock = SNAP + 6;
        await leader.engine._tick();
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints.length === 1),
            { label: 'the next cadence to finalize' });
        expect(follower.db.checkpoints[0].checkpoint_seq,
            'and it is the next sequence, not the refused one').to.equal(SNAP + 6);
    });
});
