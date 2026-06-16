'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// In-process checkpoint mesh: K StateCheckpointEngine instances share a mock
// gossip bus (mirror of CrossChainDexConsensus.test.js), each with a real
// ValidatorIdentity, an in-memory state_checkpoints "DB", and a stubbed
// per-node indexer (getblockhashes). Exercises the leader-elected
// SIGN_REQ → SIGN → FINALIZED round, single-node collapse, the
// diverged-replica refusal, quorum failure, the seq replay guard, and the
// non-leader SIGN_REQ guard.

const { expect }            = require('chai');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
const ValidatorIdentity     = require('../../src/ValidatorIdentity');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32)
};

describe('StateCheckpointEngine', function () {

    let buses = [];

    afterEach(async function () {
        for (let bus of buses) { for (let nd of bus.nodes) await nd.engine.stop(); }
        buses = [];
    });

    // Minimal in-memory hub DB: state_checkpoints + capability_snapshots.
    function memDb() {
        let checkpoints = [];          // rows keyed by (chain, network, block_index)
        let snapshots   = [];
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
                    let [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures] = params;
                    // Append-only INSERT IGNORE keyed by (chain, network, block_index, checkpoint_seq)
                    if (!checkpoints.some(r => r.chain === chain && r.network === network && r.block_index === block_index && r.checkpoint_seq === checkpoint_seq))
                        checkpoints.push({ id: checkpoints.length + 1, chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures });
                    return [];
                }
                if (sql.startsWith('SELECT * FROM state_checkpoints')) {
                    return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
                }
                if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                    let [snapshot_block, capability, signing_pubkey, amount] = params;
                    if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
                        snapshots.push({ id: snapshots.length + 1, snapshot_block, capability, signing_pubkey, amount });
                    return [];
                }
                if (sql.startsWith('SELECT * FROM capability_snapshots')) {
                    return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] && r.signing_pubkey === params[2]).slice(0, 1);
                }
                return [];
            }
        };
    }

    // Build n engines over a shared in-memory gossip bus.
    // opts.btcBlock — resolved BTC tip (drives cadence-leader election);
    // opts.hashesFor(self) — per-node getblockhashes result (default TIP).
    function buildMesh(n, opts) {
        opts = opts || {};
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
            let db = memDb();
            let hub = {
                db,
                p2pConfig: {
                    CHECKPOINT_CHAINS:        (opts.chains || ['BTC']).join(','),
                    CHECKPOINT_CONFIRMATIONS: String(opts.confirmations != null ? opts.confirmations : 0),
                    BTC_INDEXER_URL: 'http://stub', LTC_INDEXER_URL: 'http://stub', DOGE_INDEXER_URL: 'http://stub'
                },
                hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } },
                capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } },
                getPeerManager: () => peerManager,
                getIdentity: () => identity,
                _resolveBtcLatestBlock: async () => (opts.btcBlock != null ? opts.btcBlock : 100)
            };
            self.db  = db;
            self.hub = hub;
            self.engine = new StateCheckpointEngine(hub);
            self.engine._indexerCall = async (coin, method, params) => {
                let h = opts.hashesFor ? opts.hashesFor(self, params, coin) : TIP;
                return h ? Object.assign({}, h) : null;
            };
            self.finalized = [];
            self.engine.on('checkpoint:finalized', (ev) => self.finalized.push(ev));
            bus.nodes.push(self);
        }
        buses.push(bus);
        return bus;
    }

    function sortedPubkeys(bus) { return bus.nodes.map(nd => nd.pubkey).sort(); }
    function leaderNode(bus, btcBlock) {
        let leaderPk = sortedPubkeys(bus)[btcBlock % bus.nodes.length];
        return bus.nodes.find(nd => nd.pubkey === leaderPk);
    }
    async function startAll(bus) { for (let nd of bus.nodes) await nd.engine.start(); }
    async function tickAll(bus)  { for (let nd of bus.nodes) await nd.engine._tick(); }

    it('canonical string matches the ANCHOR spec byte-for-byte', function () {
        let canon = StateCheckpointEngine.canonicalCheckpoint({
            chain: 'BTC', network: 'mainnet', block_index: 900123, block_hash: 'ab'.repeat(32),
            ledger_hash: 'cd'.repeat(32), actions_hash: 'ef'.repeat(32), contract_hash: '01'.repeat(32),
            checkpoint_seq: 417, snapshot_block: 900120
        });
        expect(canon).to.equal('XCHECKPOINT|BTC|mainnet|900123|' + 'ab'.repeat(32) + '|' + 'cd'.repeat(32) +
                               '|' + 'ef'.repeat(32) + '|' + '01'.repeat(32) + '|417|900120');
    });

    it('N=1: single-validator set self-signs and writes immediately', async function () {
        let bus = buildMesh(1, { btcBlock: 100 });
        await startAll(bus);
        await tickAll(bus);
        await sleep(30);

        let nd = bus.nodes[0];
        expect(nd.finalized.length).to.equal(1);
        expect(nd.db.checkpoints.length).to.equal(1);
        let row  = nd.db.checkpoints[0];
        expect(row.chain).to.equal('BTC');
        expect(row.block_index).to.equal(TIP.block_index);
        let sigs = JSON.parse(row.validator_signatures);
        expect(sigs.length).to.equal(1);
        let canon = StateCheckpointEngine.canonicalCheckpoint(nd.finalized[0].checkpoint);
        expect(ValidatorIdentity.verify(canon, sigs[0].sig, sigs[0].pubkey)).to.be.true;
        // Streamed to the indexer mirror (capability snapshot rows + the checkpoint row).
        expect(nd.hub.hubDbBroadcaster.rows.some(r => r.table === 'state_checkpoints')).to.be.true;
    });

    it('restart does not re-checkpoint: cadence latch is restored from persisted rows', async function () {
        // First boot: one checkpoint at btcBlock 100 (default intervalBlocks 6).
        let bus = buildMesh(1, { btcBlock: 100 });
        let nd  = bus.nodes[0];
        await nd.engine.start();
        await nd.engine._tick();
        await sleep(30);
        expect(nd.db.checkpoints.length, 'after first boot').to.equal(1);
        let seqAfterBoot = nd.db.checkpoints[0].checkpoint_seq;

        // Simulate a restart: a fresh engine over the SAME hub/db, btcBlock
        // unchanged (no new interval elapsed). Pre-fix this re-checkpointed
        // immediately (latch null) and burned another on-chain anchor round.
        let restarted = new StateCheckpointEngine(nd.hub);
        restarted._indexerCall = async () => Object.assign({}, TIP);
        await restarted.start();
        expect(restarted._lastCheckpointBtcBlock, 'latch restored on start').to.equal(100);
        await restarted._tick();
        await sleep(30);
        expect(nd.db.checkpoints.length, 'no extra checkpoint after restart').to.equal(1);
        expect(nd.db.checkpoints[0].checkpoint_seq).to.equal(seqAfterBoot);

        // Once btcBlock advances past the interval, it checkpoints again.
        restarted.hub._resolveBtcLatestBlock = async () => 100 + restarted.intervalBlocks;
        await restarted._tick();
        await sleep(30);
        expect(nd.db.checkpoints.length, 'checkpoints again past the interval').to.equal(2);
    });

    it('N=4: leader collects 2f+1, every node writes the same quorum-signed row', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        await tickAll(bus);
        await sleep(80);

        for (let nd of bus.nodes) {
            expect(nd.db.checkpoints.length, 'node ' + nd.i + ' rows').to.equal(1);
            let sigs = JSON.parse(nd.db.checkpoints[0].validator_signatures);
            expect(sigs.length).to.be.at.least(3);                      // quorum 2f+1 = 3
            let canon = StateCheckpointEngine.canonicalCheckpoint(bus.nodes[0].finalized[0]
                ? bus.nodes[0].finalized[0].checkpoint
                : nd.db.checkpoints[0]);
            expect(sigs.every(s => ValidatorIdentity.verify(canon, s.sig, s.pubkey))).to.be.true;
        }
        // Only the cadence leader emits as leader, but all nodes hold identical rows.
        let rows = bus.nodes.map(nd => JSON.stringify([nd.db.checkpoints[0].chain, nd.db.checkpoints[0].block_index,
                                                       nd.db.checkpoints[0].ledger_hash, nd.db.checkpoints[0].checkpoint_seq]));
        expect(new Set(rows).size).to.equal(1);
    });

    it('every node (followers included) persists the oracle_publish snapshot at finalize', async function () {
        // Bug-C analog: only the cadence leader persisted capability_snapshots
        // (in _tick), but ANCHOR verifiers check checkpoint signatures against
        // whichever hub DB they mirror — a follower's DB may be the only one
        // they read.
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        await tickAll(bus);
        await sleep(80);

        for (let nd of bus.nodes) {
            expect(nd.db.checkpoints.length, 'node ' + nd.i + ' checkpoint').to.equal(1);
            let snaps = nd.db.snapshots.filter(s => s.capability === 'oracle_publish' && s.snapshot_block === 101);
            expect(snaps.length, 'node ' + nd.i + ' snapshot rows').to.equal(4);
        }
    });

    it('a diverged replica refuses to sign; 3 honest of 4 still reach quorum', async function () {
        let bus = buildMesh(4, {
            btcBlock: 101,
            hashesFor: (self) => {
                let leader = leaderNode(buses[0], 101);
                if (self !== leader && self.i === divergedIndex(buses[0], leader)) {
                    return Object.assign({}, TIP, { ledger_hash: 'ff'.repeat(32) });   // diverged state
                }
                return TIP;
            }
        });
        function divergedIndex(b, leader) { return b.nodes.find(nd => nd !== leader).i; }
        await startAll(bus);
        await tickAll(bus);
        await sleep(80);

        let leader = leaderNode(bus, 101);
        expect(leader.db.checkpoints.length).to.equal(1);
        let sigs = JSON.parse(leader.db.checkpoints[0].validator_signatures);
        expect(sigs.length).to.equal(3);                                 // 4 minus the diverged refuser
        let diverged = bus.nodes.find(nd => nd !== leader);
        expect(sigs.some(s => s.pubkey === diverged.pubkey)).to.be.false;
    });

    it('two diverged replicas of 4 → no quorum, nothing written anywhere', async function () {
        let bus = buildMesh(4, {
            btcBlock: 101,
            hashesFor: (self) => {
                let leader = leaderNode(buses[0], 101);
                let followers = buses[0].nodes.filter(nd => nd !== leader);
                if (self === followers[0] || self === followers[1])
                    return Object.assign({}, TIP, { ledger_hash: 'ff'.repeat(32) });
                return TIP;
            }
        });
        await startAll(bus);
        await tickAll(bus);
        await sleep(80);
        for (let nd of bus.nodes) expect(nd.db.checkpoints.length, 'node ' + nd.i).to.equal(0);
    });

    it('followers never co-sign a stale checkpoint_seq (replay guard)', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        // Pre-record seq 5 on every follower — the leader (fresh DB) proposes seq 0.
        let leader = leaderNode(bus, 101);
        for (let nd of bus.nodes) {
            if (nd === leader) continue;
            nd.db.checkpoints.push({ id: 1, chain: 'BTC', network: 'regtest', block_index: 1, block_hash: '', ledger_hash: '',
                                     actions_hash: '', contract_hash: '', checkpoint_seq: 5, snapshot_block: 1, validator_signatures: '[]' });
        }
        await tickAll(bus);
        await sleep(80);
        // No follower signed → leader stuck below quorum → no new row on the leader.
        expect(leader.db.checkpoints.length).to.equal(0);
    });

    it('SIGN_REQ from a non-leader validator is ignored', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        let leader = leaderNode(bus, 101);
        let impostor = bus.nodes.find(nd => nd !== leader);
        let cp = {
            chain: 'BTC', network: TIP.network, block_index: TIP.block_index, block_hash: TIP.block_hash,
            ledger_hash: TIP.ledger_hash, actions_hash: TIP.actions_hash, contract_hash: TIP.contract_hash,
            checkpoint_seq: 0, snapshot_block: 101
        };
        let canon = StateCheckpointEngine.canonicalCheckpoint(cp);
        // Impostor broadcasts a well-formed, correctly signed REQ — but isn't the cadence leader.
        impostor.engine.peerManager.broadcast(StateCheckpointEngine.XCHK_SIGN_REQ, {
            checkpoint: cp, sig_pubkey: impostor.pubkey, sig: impostor.identity.sign(canon)
        });
        await sleep(60);
        for (let nd of bus.nodes) expect(nd.db.checkpoints.length, 'node ' + nd.i).to.equal(0);
    });

    it('multi-chain: one cadence tick checkpoints EVERY configured chain (BTC,LTC,DOGE)', async function () {
        // The per-chain loop in _tick (one round per chain under a single cadence leader)
        // is otherwise only exercised single-chain. A single-validator set self-signs each
        // chain's round immediately, so one tick must land one row per configured chain.
        let bus = buildMesh(1, { btcBlock: 100, chains: ['BTC', 'LTC', 'DOGE'] });
        await startAll(bus);
        await tickAll(bus);
        await sleep(40);

        let nd = bus.nodes[0];
        expect(nd.db.checkpoints.map(r => r.chain).sort()).to.deep.equal(['BTC', 'DOGE', 'LTC']);
        // Each chain's row carries its own valid self-signature over its own canonical
        // (the chain name is part of the preimage, so the three sigs are distinct).
        for (let row of nd.db.checkpoints) {
            let sigs = JSON.parse(row.validator_signatures);
            expect(sigs.length, row.chain + ' sigs').to.equal(1);
            let canon = StateCheckpointEngine.canonicalCheckpoint(row);
            expect(ValidatorIdentity.verify(canon, sigs[0].sig, sigs[0].pubkey), row.chain + ' verifies').to.be.true;
        }
    });

    it('confirmations offset: checkpoints the tip MINUS CHECKPOINT_CONFIRMATIONS (snapshot_block unchanged)', async function () {
        // tip.block_index = 500; _runRound re-fetches getblockhashes at (tip - confirmations),
        // so the persisted block_index is 497 while snapshot_block tracks the BTC cadence block.
        let bus = buildMesh(1, {
            btcBlock: 100,
            confirmations: 3,
            hashesFor: (self, params) =>
                Object.assign({}, TIP, (params && params.block_index != null) ? { block_index: params.block_index } : {})
        });
        await startAll(bus);
        await tickAll(bus);
        await sleep(40);

        let nd = bus.nodes[0];
        expect(nd.db.checkpoints.length).to.equal(1);
        expect(nd.db.checkpoints[0].block_index, 'tip minus confirmations').to.equal(TIP.block_index - 3); // 497
        expect(nd.db.checkpoints[0].snapshot_block, 'cadence block, not offset').to.equal(100);
    });
});
