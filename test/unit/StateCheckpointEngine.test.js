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
const { waitUntil }         = require('../helpers/waitUntil');

// The mock bus hands SIGN_REQ to an async handler that _handleMessage fires and
// forgets, so "nobody co-signed" is only settled once every peer has finished
// judging the request. Wrapping the handler makes that countable, which is the
// observable the refusal cases used to stand a fixed sleep in for.
function countHandled(nodes, method) {
    let done = 0;
    for (let nd of nodes) {
        let engine = nd.engine;
        let orig = engine[method].bind(engine);
        engine[method] = async (...args) => { try { return await orig(...args); } finally { done++; } };
    }
    return () => done;
}

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    // SPV Phase 2: regtest CHECKPOINT_COMMITMENT flag-day is 0, so getblockhashes returns the
    // light-client roots and the engine signs + persists them (it refuses to sign without them).
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
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
                    let [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures] = params;
                    // append-only INSERT IGNORE keyed by the TIGHTENED unique index
                    // (chain, network, checkpoint_seq). A second row at an already-seated seq
                    // (even a different block_index) is dropped, exactly as the real DB's
                    // uq_chain_seq collapses a same-seq split-brain to one admitted row.
                    if (!checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq))
                        checkpoints.push({ id: checkpoints.length + 1, chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures });
                    return [];
                }
                if (sql.startsWith('SELECT * FROM state_checkpoints')) {
                    return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
                }
                if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                    // One multi-row statement carries the whole set, so walk the flattened
                    // params in groups of five rather than destructuring a single row.
                    for (let i = 0; i + 4 < params.length; i += 5) {
                        let [snapshot_block, capability, signing_pubkey, amount] = params.slice(i, i + 5);
                        if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
                            snapshots.push({ id: snapshots.length + 1, snapshot_block, capability, signing_pubkey, amount });
                    }
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
    // opts.btcBlock  : resolved BTC tip (drives cadence-leader election);
    // opts.hashesFor(self) : per-node getblockhashes result (default TIP).
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
        await waitUntil(() => bus.nodes[0].db.checkpoints.length === 1, { label: 'the single-validator round to self-sign and write' });

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
        await waitUntil(() => nd.db.checkpoints.length === 1, { label: 'the first boot to write its checkpoint' });
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
        // _tick() is awaited and the latch decision is taken inside it, so the
        // no-op is already decided; there is no later condition to poll for.
        expect(nd.db.checkpoints.length, 'no extra checkpoint after restart').to.equal(1);
        expect(nd.db.checkpoints[0].checkpoint_seq).to.equal(seqAfterBoot);

        // Once btcBlock advances past the interval, it checkpoints again.
        restarted.hub._resolveBtcLatestBlock = async () => 100 + restarted.intervalBlocks;
        await restarted._tick();
        await waitUntil(() => nd.db.checkpoints.length === 2, { label: 'the post-interval tick to write a second checkpoint' });
        expect(nd.db.checkpoints.length, 'checkpoints again past the interval').to.equal(2);
    });

    it('N=4: leader collects 2f+1, every node writes the same quorum-signed row', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        await tickAll(bus);
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints.length === 1), { label: 'every node to write the quorum-signed row' });

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
        // whichever hub DB they mirror; a follower's DB may be the only one
        // they read.
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        await tickAll(bus);
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints.length === 1 &&
            nd.db.snapshots.filter(s => s.capability === 'oracle_publish' && s.snapshot_block === 101).length === 4),
            { label: 'every node to persist the checkpoint and its oracle_publish snapshot' });

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
        await waitUntil(() => leaderNode(bus, 101).db.checkpoints.length === 1, { label: 'the leader to reach quorum without the diverged replica' });

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
        // Quorum (3) is unreachable, so wait on the stall point: the leader holds its
        // own signature plus the one honest follower's and can collect no more.
        await waitUntil(() => {
            let round = [...leaderNode(bus, 101).engine.pending.values()][0];
            return round && round.signatures.size >= 2;
        }, { label: 'the single honest co-sign to reach the leader' });
        for (let nd of bus.nodes) expect(nd.db.checkpoints.length, 'node ' + nd.i).to.equal(0);
    });

    it('followers never co-sign a stale checkpoint_seq (replay guard)', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        // seq is derived from snapshot_block, so the leader proposes seq 101
        // (btcBlock 101). Pre-record that same seq on every follower so the proposal
        // is a genuine replay (cp.checkpoint_seq 101 <= recorded maxSeq 101).
        let leader = leaderNode(bus, 101);
        for (let nd of bus.nodes) {
            if (nd === leader) continue;
            nd.db.checkpoints.push({ id: 1, chain: 'BTC', network: 'regtest', block_index: 1, block_hash: '', ledger_hash: '',
                                     actions_hash: '', contract_hash: '', checkpoint_seq: 101, snapshot_block: 101, validator_signatures: '[]' });
        }
        let reqsHandled = countHandled(bus.nodes.filter(nd => nd !== leader), '_handleSignReq');
        await tickAll(bus);
        await waitUntil(() => reqsHandled() === bus.nodes.length - 1, { label: 'every follower to finish judging the replayed SIGN_REQ' });
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
            // seq must match the value derived from snapshot_block, so the REQ
            // clears the deterministic-seq guard and is rejected specifically by the
            // non-leader (cadence) check we are exercising here.
            checkpoint_seq: 101, snapshot_block: 101
        };
        let canon = StateCheckpointEngine.canonicalCheckpoint(cp);
        let reqsHandled = countHandled(bus.nodes.filter(nd => nd !== impostor), '_handleSignReq');
        // Impostor broadcasts a well-formed, correctly signed REQ, but isn't the cadence leader.
        impostor.engine.peerManager.broadcast(StateCheckpointEngine.XCHK_SIGN_REQ, {
            checkpoint: cp, sig_pubkey: impostor.pubkey, sig: impostor.identity.sign(canon)
        });
        await waitUntil(() => reqsHandled() === bus.nodes.length - 1, { label: 'every peer to finish judging the non-leader SIGN_REQ' });
        for (let nd of bus.nodes) expect(nd.db.checkpoints.length, 'node ' + nd.i).to.equal(0);
    });

    it('multi-chain: one cadence tick checkpoints EVERY configured chain (BTC,LTC,DOGE)', async function () {
        // The per-chain loop in _tick (one round per chain under a single cadence leader)
        // is otherwise only exercised single-chain. A single-validator set self-signs each
        // chain's round immediately, so one tick must land one row per configured chain.
        let bus = buildMesh(1, { btcBlock: 100, chains: ['BTC', 'LTC', 'DOGE'] });
        await startAll(bus);
        await tickAll(bus);
        await waitUntil(() => bus.nodes[0].db.checkpoints.length === 3, { label: 'one tick to checkpoint all three configured chains' });

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
        await waitUntil(() => bus.nodes[0].db.checkpoints.length === 1, { label: 'the offset round to write its checkpoint' });

        let nd = bus.nodes[0];
        expect(nd.db.checkpoints.length).to.equal(1);
        expect(nd.db.checkpoints[0].block_index, 'tip minus confirmations').to.equal(TIP.block_index - 3); // 497
        expect(nd.db.checkpoints[0].snapshot_block, 'cadence block, not offset').to.equal(100);
    });

    // ── XCHK-TRUNC-1: an over-cap (truncated) weighted oracle_publish snapshot must carry
    // its .truncated flag through _resolveCapabilityValidators so meetsStakeThreshold fails
    // closed; otherwise the under-counted stake S lets a minority clear the 2/3 bar and
    // finalize a checkpoint a full snapshot would reject (the XHUB-TRUNC-1 root, missed here). ──
    describe('truncated-snapshot fail-closed (XCHK-TRUNC-1)', function () {
        const swq = require('../../src/stake_weighted_quorum');

        function makeEngine(snapshotResult) {
            let eng = new StateCheckpointEngine({ db: { doQuery: async () => [] }, network: 'regtest' });
            eng.capSnapshot = { getWeightSnapshot: async () => snapshotResult };
            return eng;
        }

        it('carries truncated=true through the weighted resolver, so meetsStakeThreshold fails closed', async function () {
            let eng = makeEngine({ validators: [{ pubkey: 'aa', source: 's1', weight: '100' }], truncated: true });
            let validators = await eng._resolveCapabilityValidators('oracle_publish', 100);
            expect(validators.truncated).to.be.true;
            // The exact computation _handleFinalized runs (weighted path) now refuses.
            expect(swq.meetsStakeThreshold(validators, ['aa'])).to.be.false;
        });

        it('leaves the flag unset for a non-truncated snapshot (quorum proceeds normally)', async function () {
            let eng = makeEngine({ validators: [{ pubkey: 'aa', source: 's1', weight: '100' }], truncated: false });
            let validators = await eng._resolveCapabilityValidators('oracle_publish', 100);
            expect(validators.truncated).to.be.undefined;
            expect(swq.meetsStakeThreshold(validators, ['aa'])).to.be.true;
        });
    });

    // ── Follower co-sign freshness bound (finding 1781) ─────────────────────
    // The follower must decline to co-sign a SIGN_REQ whose leader-supplied
    // snapshot_block deviates from its OWN resolved BTC tip beyond
    // cosignToleranceBlocks. snapshot_block selects the validator set and every
    // flag-day gate, so an unbounded stale value enables leader-grinding and
    // flag-day regression. Fail-closed when we cannot resolve our own tip.
    describe('co-sign freshness bound (finding 1781)', function () {

        // Build a valid SIGN_REQ for `snapshotBlock`, signed by the cadence
        // leader for that block, using the shared TIP block data.
        function makeSignReq(bus, snapshotBlock) {
            let leader = leaderNode(bus, snapshotBlock);
            let cp = {
                chain: 'BTC', network: TIP.network, block_index: TIP.block_index,
                block_hash: TIP.block_hash, ledger_hash: TIP.ledger_hash,
                actions_hash: TIP.actions_hash, contract_hash: TIP.contract_hash,
                // seq is derived from snapshot_block; use the derived value so
                // these freshness-bound cases exercise the freshness guard, not the seq guard.
                checkpoint_seq: snapshotBlock, snapshot_block: snapshotBlock,
                state_root: TIP.state_root, state_root_version: TIP.state_root_version,
                block_merkle_root: TIP.block_merkle_root, block_merkle_version: TIP.block_merkle_version
            };
            let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
            let sig = leader.identity.sign(canonical);
            let env = { type: 'XCHK_SIGN_REQ', sender: leader.pubkey,
                        data: { checkpoint: cp, sig_pubkey: leader.pubkey, sig } };
            let follower = bus.nodes.find(nd => nd.pubkey !== leader.pubkey);
            return { env, follower };
        }

        // Record XCHK_SIGN co-sign broadcasts from a follower.
        function watchCosign(follower) {
            let signs = [];
            let pm = follower.engine.peerManager;
            let orig = pm.broadcast.bind(pm);
            pm.broadcast = (type, data) => { if (type === 'XCHK_SIGN') signs.push(data); return orig(type, data); };
            return signs;
        }

        it('co-signs a SIGN_REQ whose snapshot_block matches our own BTC tip (fresh)', async function () {
            let SNAP = 500;
            let bus = buildMesh(2, { btcBlock: SNAP, confirmations: 0 });
            let { env, follower } = makeSignReq(bus, SNAP);
            follower.hub._resolveBtcLatestBlock = async () => SNAP;   // exactly fresh
            let signs = watchCosign(follower);
            await follower.engine._handleSignReq(env);
            expect(signs.length, 'follower co-signed a fresh snapshot_block').to.equal(1);
        });

        it('declines to co-sign when snapshot_block is staler than the tolerance', async function () {
            let SNAP = 500;
            let bus = buildMesh(2, { btcBlock: SNAP, confirmations: 0 });
            let { env, follower } = makeSignReq(bus, SNAP);
            // Our tip has moved well past the proposed snapshot_block (> default 144).
            follower.hub._resolveBtcLatestBlock = async () => SNAP + 200;
            expect(200).to.be.greaterThan(follower.engine.cosignToleranceBlocks);
            let signs = watchCosign(follower);
            await follower.engine._handleSignReq(env);
            expect(signs.length, 'stale snapshot_block declined').to.equal(0);
        });

        it('fails closed (declines) when it cannot resolve its own BTC tip', async function () {
            let SNAP = 500;
            let bus = buildMesh(2, { btcBlock: SNAP, confirmations: 0 });
            let { env, follower } = makeSignReq(bus, SNAP);
            follower.hub._resolveBtcLatestBlock = async () => null;   // no own tip
            let signs = watchCosign(follower);
            await follower.engine._handleSignReq(env);
            expect(signs.length, 'missing own tip fails closed').to.equal(0);
        });
    });

    // ── snapshot_block-derived checkpoint_seq + split-brain fence ─────
    // The old COALESCE(MAX(seq))+1 allocation let two one-block-tip-skewed leaders
    // mint the SAME seq for DIFFERENT blocks (split-brain), which the anchor
    // publisher then double-spent on DOGE. seq is now a deterministic function of
    // snapshot_block, followers refuse a leader whose seq does not match, and the
    // tightened (chain, network, checkpoint_seq) unique key collapses any residual
    // same-seq race to one admitted row.
    describe('snapshot_block-derived seq + split-brain fence', function () {

        it('deriveCheckpointSeq is the identity on snapshot_block, and a produced checkpoint uses it', async function () {
            expect(StateCheckpointEngine.deriveCheckpointSeq(900120)).to.equal(900120);
            expect(StateCheckpointEngine.deriveCheckpointSeq('42')).to.equal(42);

            let bus = buildMesh(1, { btcBlock: 250 });
            await startAll(bus);
            await tickAll(bus);
            await waitUntil(() => bus.nodes[0].db.checkpoints.length === 1, { label: 'the round to write its checkpoint' });
            let row = bus.nodes[0].db.checkpoints[0];
            // seq is the BTC cadence (snapshot) block, NOT a dense 0 from MAX+1.
            expect(row.checkpoint_seq, 'seq == snapshot_block').to.equal(250);
            expect(row.snapshot_block).to.equal(250);
        });

        it('followers refuse to co-sign a SIGN_REQ whose seq does not match its snapshot_block (grinding)', async function () {
            let SNAP = 500;
            let bus = buildMesh(2, { btcBlock: SNAP, confirmations: 0 });
            let leader   = leaderNode(bus, SNAP);
            let follower = bus.nodes.find(nd => nd.pubkey !== leader.pubkey);
            follower.hub._resolveBtcLatestBlock = async () => SNAP;   // fresh: passes the freshness bound

            // A leader-signed REQ that is fresh and correctly signed, but carries a
            // ground seq (SNAP+7) instead of the deterministic deriveCheckpointSeq(SNAP)=SNAP.
            let cp = {
                chain: 'BTC', network: TIP.network, block_index: TIP.block_index,
                block_hash: TIP.block_hash, ledger_hash: TIP.ledger_hash,
                actions_hash: TIP.actions_hash, contract_hash: TIP.contract_hash,
                checkpoint_seq: SNAP + 7, snapshot_block: SNAP,
                state_root: TIP.state_root, state_root_version: TIP.state_root_version,
                block_merkle_root: TIP.block_merkle_root, block_merkle_version: TIP.block_merkle_version
            };
            let canon = StateCheckpointEngine.canonicalCheckpoint(cp);
            let env = { type: 'XCHK_SIGN_REQ', sender: leader.pubkey,
                        data: { checkpoint: cp, sig_pubkey: leader.pubkey, sig: leader.identity.sign(canon) } };

            let signs = [];
            let pm = follower.engine.peerManager, orig = pm.broadcast.bind(pm);
            pm.broadcast = (type, data) => { if (type === 'XCHK_SIGN') signs.push(data); return orig(type, data); };
            await follower.engine._handleSignReq(env);
            expect(signs.length, 'ground seq refused').to.equal(0);
        });

        it('_handleFinalized rejects a finalized checkpoint whose seq does not match snapshot_block', async function () {
            let bus = buildMesh(1, { btcBlock: 300 });
            let nd  = bus.nodes[0];
            await nd.engine.start();
            let cp = {
                chain: 'BTC', network: TIP.network, block_index: TIP.block_index,
                block_hash: TIP.block_hash, ledger_hash: TIP.ledger_hash,
                actions_hash: TIP.actions_hash, contract_hash: TIP.contract_hash,
                checkpoint_seq: 999, snapshot_block: 300   // 999 != deriveCheckpointSeq(300)
            };
            await nd.engine._handleFinalized({ data: { checkpoint: cp, signatures: [{ pubkey: nd.pubkey, sig: 'x' }] } });
            expect(nd.db.checkpoints.length, 'malformed finalized seq not persisted').to.equal(0);
        });

        it('same-seq split-brain (different block_index) collapses to one admitted row', async function () {
            let bus = buildMesh(1, { btcBlock: 200 });
            let nd  = bus.nodes[0];
            let base = {
                chain: 'BTC', network: 'regtest', block_hash: TIP.block_hash,
                ledger_hash: TIP.ledger_hash, actions_hash: TIP.actions_hash,
                contract_hash: TIP.contract_hash, checkpoint_seq: 200, snapshot_block: 200,
                // Roots are populated: regtest has checkpoint-commitment active
                // from genesis, so a rootless checkpoint at this snapshot_block is now
                // refused on every path (propose, co-sign and persist). The propose path
                // already refused it before this change, so a rootless regtest checkpoint
                // was never reachable in practice and the old all-null fixture was
                // synthetic. This test is about the same-seq split-brain fence, not about
                // roots, so give it a checkpoint that is otherwise valid.
                state_root: 'a'.repeat(64), state_root_version: 1,
                block_merkle_root: 'b'.repeat(64), block_merkle_version: 1
            };
            // Two divergent payloads (block_index 10 vs 11) at the SAME seq 200 - exactly
            // the split-brain the old 4-column unique index admitted BOTH of.
            await nd.engine._acceptFinalized(Object.assign({}, base, { block_index: 10 }), [{ pubkey: nd.pubkey, sig: 'a' }], 1, true);
            await nd.engine._acceptFinalized(Object.assign({}, base, { block_index: 11 }), [{ pubkey: nd.pubkey, sig: 'b' }], 1, true);
            let atSeq = nd.db.checkpoints.filter(r => r.chain === 'BTC' && r.network === 'regtest' && r.checkpoint_seq === 200);
            expect(atSeq.length, 'exactly one row survives per seq').to.equal(1);
            expect(atSeq[0].block_index, 'first writer wins').to.equal(10);
        });
    });

    // ── The rootless-checkpoint guard runs on EVERY path ──────────
    //
    // The propose path always refused to sign a post-flag-day checkpoint with no
    // light-client roots. That was the only place the rule lived, and it is the one
    // path an attacker does not control. The canonical hides the gap: the root suffix
    // is the EMPTY STRING when roots are null, so a rootless proposal and a rootless
    // self-derivation produce byte-identical canonicals, the follower's "matches my
    // indexer?" check passes, and it co-signs. Quorum then forms and every hub
    // persists a checkpoint carrying none of the commitment its flag-day requires.
    describe('rootless-checkpoint guard on co-sign and persist (#3092)', function () {

        const ROOTED = {
            state_root: 'a'.repeat(64), state_root_version: 1,
            block_merkle_root: 'b'.repeat(64), block_merkle_version: 1
        };
        const ROOTLESS = {
            state_root: null, state_root_version: null,
            block_merkle_root: null, block_merkle_version: null
        };
        function cp(extra){
            return Object.assign({
                chain: 'BTC', network: 'regtest', block_index: 10,
                block_hash: TIP.block_hash, ledger_hash: TIP.ledger_hash,
                actions_hash: TIP.actions_hash, contract_hash: TIP.contract_hash,
                checkpoint_seq: 200, snapshot_block: 200
            }, extra);
        }

        it('isRootless is true only when commitment is active AND a root is missing', function () {
            expect(StateCheckpointEngine.isRootless(cp(ROOTLESS)), 'active + no roots').to.equal(true);
            expect(StateCheckpointEngine.isRootless(cp(ROOTED)),   'active + roots').to.equal(false);
            // A partially-populated checkpoint is just as unusable as an empty one.
            expect(StateCheckpointEngine.isRootless(cp(Object.assign({}, ROOTED, { block_merkle_root: null }))),
                'one missing root still counts').to.equal(true);
            expect(StateCheckpointEngine.isRootless(cp(Object.assign({}, ROOTED, { state_root_version: null }))),
                'a missing VERSION still counts').to.equal(true);
            expect(StateCheckpointEngine.isRootless(null), 'null input').to.equal(false);
        });

        it('the canonical does NOT distinguish rootless from rooted, which is why the guard is needed', function () {
            // This is the property that made the co-sign check useless on its own: the
            // suffix collapses to '' so two rootless hubs agree byte-for-byte.
            const a = StateCheckpointEngine.canonicalCheckpoint(cp(ROOTLESS));
            const b = StateCheckpointEngine.canonicalCheckpoint(cp(ROOTLESS));
            expect(a).to.equal(b);
            expect(a).to.not.equal(StateCheckpointEngine.canonicalCheckpoint(cp(ROOTED)));
        });

        it('persist REFUSES a rootless checkpoint, writing neither snapshot nor row', async function () {
            let bus = buildMesh(1, { btcBlock: 200 });
            let nd  = bus.nodes[0];
            let before = nd.db.checkpoints.length;
            let threw = null;
            try {
                await nd.engine._acceptFinalized(cp(ROOTLESS), [{ pubkey: nd.pubkey, sig: 'a' }], 1, true);
            } catch(e){ threw = e; }
            expect(threw, 'must fail closed rather than persist').to.not.equal(null);
            expect(String(threw.message)).to.match(/rootless checkpoint/);
            expect(nd.db.checkpoints.length, 'no row written').to.equal(before);
        });

        // ── SWQ gate plane, asserted rather than silently switched ──
        //
        // This engine resolves the stake-weighted-quorum gate on the DEPLOYMENT network
        // while StateAnchorPublisher resolves the same gate on the RECORD's network
        // (resolveQuorumNetwork). Two files, one gate, two planes. The v1 call is
        // kept on purpose: switching to cp.network would let a PEER choose this hub's
        // quorum rule by asserting a network in a gossiped checkpoint, which is worse
        // than the drift being fixed. So a genuine disagreement is refused loudly.
        it('refuses a checkpoint whose network disagrees with the deployment network', async function () {
            let bus = buildMesh(1, { btcBlock: 200 });
            let nd  = bus.nodes[0];
            nd.engine.network = 'mainnet';                 // deployment plane
            let threw = null;
            try {
                await nd.engine._acceptFinalized(cp(Object.assign({}, ROOTED, { network: 'regtest' })),
                    [{ pubkey: nd.pubkey, sig: 'a' }], 1, true);
            } catch(e){ threw = e; }
            expect(threw, 'a cross-network checkpoint must be refused').to.not.equal(null);
            expect(String(threw.message)).to.match(/network mismatch/);
            expect(String(threw.message), 'names BOTH values so it is diagnosable').to.match(/regtest[\s\S]*mainnet/);
            expect(nd.db.checkpoints.length, 'nothing persisted').to.equal(0);
        });

        // Third call site of the same predicate. The indexer byte-match further down
        // _handleSignReq rebuilds the canonical with the network OUR OWN indexer reports,
        // so it sees record-vs-indexer drift and is blind to record-vs-DEPLOYMENT drift:
        // co-sign membership resolves the SWQ gate on this.network, so without this the
        // follower contributes a signature under one plane and then refuses the finalized
        // checkpoint under the other.
        it('co-sign REFUSES a checkpoint whose network disagrees with the deployment network', async function () {
            let bus   = buildMesh(2, { btcBlock: 200 });
            let nd    = bus.nodes[0];
            let other = bus.nodes[1];
            nd.engine.network = 'mainnet';                 // deployment plane
            let types = [];
            let pm    = nd.engine.peerManager;
            let orig  = pm.broadcast.bind(pm);
            pm.broadcast = (type, data) => { types.push(type); return orig(type, data); };
            let threw = null;
            try {
                await nd.engine._handleSignReq({
                    type: 'XCHK_SIGN_REQ', sender: other.pubkey,
                    data: { checkpoint: cp(Object.assign({}, ROOTED, { network: 'regtest' })),
                            sig_pubkey: other.pubkey, sig: 'a' }
                });
            } catch(e){ threw = e; }
            expect(threw, 'a cross-network SIGN_REQ must be refused, not silently co-signed').to.not.equal(null);
            expect(String(threw.message)).to.match(/network mismatch in co-sign/);
            expect(String(threw.message), 'names BOTH values so it is diagnosable').to.match(/regtest[\s\S]*mainnet/);
            expect(types.includes('XCHK_SIGN'), 'no co-signature left the hub').to.equal(false);
        });

        it('accepts when the two agree', async function () {
            let bus = buildMesh(1, { btcBlock: 200 });
            let nd  = bus.nodes[0];
            // Both planes set to mainnet, where snapshot_block 200 is far below the
            // 961000 SWQ anchor, so the gate stays OFF and the mesh's count-based
            // capabilitySnapshot mock is the right shape. (Using regtest here would flip
            // SWQ on from genesis and need a weight snapshot the mock does not implement,
            // which tests the harness rather than the assert.)
            nd.engine.network = 'mainnet';
            await nd.engine._acceptFinalized(cp(Object.assign({}, ROOTED, { network: 'mainnet' })),
                [{ pubkey: nd.pubkey, sig: 'a' }], 1, true);
            expect(nd.db.checkpoints.length).to.equal(1);
        });

        // An UNSCOPED hub is a different, already-documented problem (#2236): it
        // resolves every flag-day gate to OFF. It is warned about, not refused, because
        // refusing would take every unscoped deployment offline at once.
        it('an unscoped hub warns once but keeps working (legacy path preserved)', async function () {
            let bus = buildMesh(1, { btcBlock: 200 });
            let nd  = bus.nodes[0];
            nd.engine.network = '';
            let warnings = [];
            let orig = console.warn;
            console.warn = (...a) => warnings.push(a.join(' '));
            try {
                await nd.engine._acceptFinalized(cp(ROOTED), [{ pubkey: nd.pubkey, sig: 'a' }], 1, true);
                await nd.engine._acceptFinalized(cp(Object.assign({}, ROOTED, { checkpoint_seq: 201, snapshot_block: 201 })),
                    [{ pubkey: nd.pubkey, sig: 'b' }], 1, true);
            } finally { console.warn = orig; }
            expect(nd.db.checkpoints.length, 'still persists').to.equal(2);
            let unscoped = warnings.filter(w => /NO deployment network/.test(w));
            expect(unscoped.length, 'warned exactly once, not per checkpoint').to.equal(1);
        });

        it('persist ACCEPTS the same checkpoint once the roots are present', async function () {
            let bus = buildMesh(1, { btcBlock: 200 });
            let nd  = bus.nodes[0];
            await nd.engine._acceptFinalized(cp(ROOTED), [{ pubkey: nd.pubkey, sig: 'a' }], 1, true);
            expect(nd.db.checkpoints.length, 'a rooted checkpoint still persists normally').to.equal(1);
        });
    });
});
