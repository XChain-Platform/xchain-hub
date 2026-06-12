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

// StateAnchorPublisher: ANCHOR v0/v1/v2 payload construction, the archive
// signing round (followers co-sign only archives matching their own DB),
// chunking round-trips, re-archival of retracted matches, and back-fill via
// XANC_FINALIZED. Mesh harness mirrors StateCheckpointEngine.test.js.

const { expect }            = require('chai');
const zlib                  = require('zlib');
const crypto                = require('crypto');
const StateAnchorPublisher  = require('../../src/StateAnchorPublisher');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
const ValidatorIdentity     = require('../../src/ValidatorIdentity');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 494, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: 7, snapshot_block: 100, validator_signatures: '[]', anchor_txid: 'feedbeef'
};

function matchRow(id, status) {
    return {
        id: 1,
        match_id: id, snapshot_block: 100, network: 'regtest',
        a_chain: 'LTC', a_action_index: 5, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Lpay',
        b_chain: 'DOGE', b_action_index: 8, b_kind: 'swap', b_tick: null, b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Dpay',
        effective_time: 1700000000, validator_signatures: null,   // signed per-mesh in buildMesh
        status: status || 'finalized', batch_root: null, anchor_txid: null, batch_seq: null, archived_status: null
    };
}

// XMATCH canonical (mirror of the publisher's _matchCanonical) — fixtures sign
// real Ed25519 sigs over it so the follower's cryptographic verification passes.
function matchCanonical(m) {
    return ['XMATCH', m.match_id, String(m.snapshot_block),
        m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
        m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
        String(m.effective_time), m.network || '',
        m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
        m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')].join('|');
}

function callRow(id, phase, status) {
    return {
        id: phase === 'result' ? 2 : 1,
        call_id: id, phase: phase || 'dispatch', snapshot_block: 100, network: 'regtest',
        source_chain: 'LTC', source_action_index: 41, source_contract_index: 7,
        target_chain: 'DOGE', target_contract_index: 9, method: 'onArrival',
        params_json: '["a","b"]', gas_limit: 50000, cross_hops: 0,
        effective_time: 1700000100,
        result_status: phase === 'result' ? 'ok' : null,
        return_payload_b64: phase === 'result' ? 'cGF5bG9hZA' : null,
        validator_signatures: null,                                // signed per-mesh in buildMesh
        status: status || 'finalized', anchor_txid: null, batch_seq: null, archived_status: null
    };
}

// XCALL phase canonicals (mirror of the publisher's _callCanonical).
function callCanonical(c) {
    let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
    if (c.phase === 'result') {
        return ['XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
            c.target_chain, String(c.result_status || ''), sha(c.return_payload_b64), String(c.effective_time)].join('|');
    }
    return ['XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
        c.source_chain, String(c.source_action_index), String(c.source_contract_index),
        c.target_chain, String(c.target_contract_index), c.method, sha(c.params_json),
        String(c.gas_limit), String(c.cross_hops), String(c.effective_time)].join('|');
}

// In-memory hub DB for the publisher's query surface.
function memDb() {
    let matches = [], checkpoints = [], snapshots = [], calls = [];
    return {
        matches, checkpoints, snapshots, calls,
        async doQuery(sql, params) {
            params = params || [];
            if (sql.startsWith('SELECT sc.* FROM state_checkpoints sc JOIN')) {
                let latest = {};
                for (let r of checkpoints) {
                    let k = r.chain + '|' + r.network;
                    if (!latest[k] || r.checkpoint_seq > latest[k].checkpoint_seq) latest[k] = r;
                }
                return Object.values(latest).filter(r => r.anchor_txid == null);
            }
            if (sql.startsWith("SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC")) {
                let sorted = checkpoints.slice().sort((x, y) => (y.chain === 'BTC') - (x.chain === 'BTC') || y.id - x.id);
                return sorted.slice(0, 1);
            }
            if (sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ?')) {
                return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2]).slice(0, 1);
            }
            if (sql.startsWith('UPDATE state_checkpoints SET anchor_txid')) {
                let onlyIfNull = sql.includes('anchor_txid IS NULL');
                for (let r of checkpoints)
                    if (r.chain === params[1] && r.network === params[2] && r.block_index === params[3] &&
                        (!onlyIfNull || r.anchor_txid == null)) r.anchor_txid = params[0];
                return [];
            }
            if (sql.startsWith('SELECT * FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status')) {
                return matches.filter(r => r.batch_seq == null || r.archived_status !== r.status).slice(0, params[0]);
            }
            if (sql.startsWith('SELECT * FROM cross_chain_matches WHERE match_id = ?')) {
                return matches.filter(r => r.match_id === params[0]).slice(0, 1);
            }
            if (sql.startsWith('SELECT COALESCE(GREATEST(')) {
                let max = -1;
                for (let r of matches) if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
                for (let r of calls)   if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
                return [{ next_seq: max + 1 }];
            }
            if (sql.startsWith('UPDATE cross_chain_matches SET batch_seq')) {
                for (let r of matches) if (r.match_id === params[3]) {
                    r.batch_seq = params[0]; r.archived_status = params[1];
                    if (params[2] != null) r.anchor_txid = params[2];
                }
                return [];
            }
            if (sql.startsWith('SELECT * FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status')) {
                return calls.filter(r => r.batch_seq == null || r.archived_status !== r.status).slice(0, params[0]);
            }
            if (sql.startsWith('SELECT * FROM cross_chain_calls WHERE call_id = ?')) {
                return calls.filter(r => r.call_id === params[0] && r.phase === params[1]).slice(0, 1);
            }
            if (sql.startsWith('UPDATE cross_chain_calls SET batch_seq')) {
                for (let r of calls) if (r.call_id === params[3] && r.phase === params[4]) {
                    r.batch_seq = params[0]; r.archived_status = params[1];
                    if (params[2] != null) r.anchor_txid = params[2];
                }
                return [];
            }
            if (sql.startsWith('SELECT snapshot_block, capability, signing_pubkey, amount FROM capability_snapshots')) {
                return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1])
                    .sort((a, b) => a.signing_pubkey < b.signing_pubkey ? -1 : 1);
            }
            if (sql.startsWith('SELECT * FROM capability_snapshots WHERE snapshot_block = ?')) {
                return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] && r.signing_pubkey === params[2]).slice(0, 1);
            }
            return [];
        }
    };
}

describe('StateAnchorPublisher', function () {

    let buses = [];
    afterEach(async function () {
        for (let bus of buses) { for (let nd of bus.nodes) await nd.pub.stop(); }
        buses = [];
    });

    // n publishers over a shared gossip bus. Every node shares identical DB
    // contents unless opts.mutate(self) tweaks its copy (divergence tests).
    function buildMesh(n, opts) {
        opts = opts || {};
        let bus = { nodes: [] };
        let identities = [];
        for (let i = 0; i < n; i++) identities.push(new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64)));
        let validators = identities.map(id => ({ pubkey: id.getPubkeyHex().toLowerCase(), amount: '1' }));

        for (let i = 0; i < n; i++) {
            let identity = identities[i];
            let self = { i, identity, pubkey: identity.getPubkeyHex().toLowerCase(), handler: null, published: [], rewards: [] };
            let peerManager = {
                on(evt, h) { if (evt === 'message') self.handler = h; },
                removeListener(evt) { if (evt === 'message') self.handler = null; },
                broadcast(type, data) {
                    let env = { type, sender: self.pubkey, data };
                    for (let other of bus.nodes) {
                        if (other === self) continue;
                        if (other.handler) other.handler(env);
                    }
                }
            };
            let db = memDb();
            db.checkpoints.push(Object.assign({}, CP_ROW, { anchor_txid: null }));
            // Every node holds identically-TERMED matches; the signature set is
            // signed by a quorum of mesh identities (matching production, where
            // each hub's collected set may differ but the terms never do).
            for (let m of (opts.matches || [matchRow('m1')])) {
                let row = Object.assign({}, m);
                if (row.validator_signatures == null) {
                    let canon = matchCanonical(row);
                    let signers = identities.slice(0, Math.max(1, n - 1));
                    row.validator_signatures = JSON.stringify(signers.map(id =>
                        ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canon) })));
                }
                db.matches.push(row);
            }
            for (let c of (opts.calls || [])) {
                let row = Object.assign({}, c);
                if (row.validator_signatures == null) {
                    let canon = callCanonical(row);
                    let signers = identities.slice(0, Math.max(1, n - 1));
                    row.validator_signatures = JSON.stringify(signers.map(id =>
                        ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canon) })));
                }
                db.calls.push(row);
            }
            if (opts.mutate) opts.mutate(self, db);

            let hub = {
                db,
                p2pConfig: Object.assign({ ANCHOR_INTERVAL_MS: '3600000' }, opts.cfg || {}),
                capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } },
                getPeerManager: () => peerManager,
                getIdentity: () => identity,
                rewardTracker: { recordAnchorReward: async (type, round, pubkey, blk) => { self.rewards.push({ type, round, pubkey, blk }); } },
                _resolveBtcLatestBlock: async () => (opts.btcBlock != null ? opts.btcBlock : 100)
            };
            self.db  = db;
            self.pub = new StateAnchorPublisher(hub);
            self.pub.setBroadcastHook(async (payload) => {
                self.published.push(payload);
                return { txid: 'txid' + self.published.length };
            });
            bus.nodes.push(self);
        }
        buses.push(bus);
        return bus;
    }

    // Election helpers mirroring the publisher's hash-ordering (different key
    // per pending checkpoint, one per election block for the archive round).
    function v0Order(bus, row) {
        row = row || CP_ROW;
        let key = 'XANCV0|' + row.chain + '|' + row.network + '|' + row.checkpoint_seq + '|' + row.snapshot_block;
        let order = StateAnchorPublisher.hashOrder(key, bus.nodes.map(nd => nd.pubkey));
        return order.map(pk => bus.nodes.find(nd => nd.pubkey === pk));
    }
    function archiveLeader(bus, btcBlock) {
        let order = StateAnchorPublisher.hashOrder('XANCV1|' + btcBlock, bus.nodes.map(nd => nd.pubkey));
        return bus.nodes.find(nd => nd.pubkey === order[0]);
    }
    async function startAll(bus) { for (let nd of bus.nodes) await nd.pub.start(); }
    async function flushAll(bus) { for (let nd of bus.nodes) await nd.pub.flush(); }

    it('v0 payload matches the ANCHOR spec field order', function () {
        let bus = buildMesh(1);
        let row = Object.assign({}, CP_ROW, { validator_signatures: '[{"pubkey":"pk1","sig":"sg1"}]' });
        let payload = bus.nodes[0].pub._buildV0Payload(row);
        expect(payload).to.equal(['ANCHOR', '0', 'BTC', 'regtest', '494', CP_ROW.block_hash,
            CP_ROW.ledger_hash, CP_ROW.actions_hash, CP_ROW.contract_hash, '7', '100', '1', 'pk1', 'sg1'].join('|'));
    });

    it('single-node: flush publishes v0 + v1, archive round-trips, batch back-filled', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);

        expect(nd.published.length).to.equal(2);                       // v0 checkpoint + v1 archive
        let v0 = nd.published[0].split('|');
        expect(v0[1]).to.equal('0');
        expect(nd.db.checkpoints[0].anchor_txid).to.equal('txid1');

        let v1 = nd.published[1].split('|');
        expect(v1[1]).to.equal('1');
        expect(v1[11]).to.equal('0');                                  // MATCH_BATCH_SEQ
        expect(v1[12]).to.equal('1');                                  // MATCH_COUNT
        expect(v1[14]).to.equal('1');                                  // TOTAL_CHUNKS
        let json = zlib.gunzipSync(Buffer.from(v1[15], 'base64url')).toString('utf8');
        expect(nd.pub._crc32Hex(json)).to.equal(v1[13]);               // BATCH_CRC32 binds the blob
        let archive = JSON.parse(json);
        expect(archive.matches.length).to.equal(1);
        expect(archive.matches[0].match_id).to.equal('m1');
        expect(archive.matches[0].b_tick).to.equal(null);
        // Resolved via capabilitySnapshot (1 mesh validator) for BOTH capabilities:
        // cross_chain at the match's snapshot_block + oracle_publish at the wrapper's.
        expect(archive.capability_snapshots.length).to.equal(2);
        expect(archive.capability_snapshots.some(s => s.capability === 'cross_chain')).to.equal(true);
        expect(archive.capability_snapshots.some(s => s.capability === 'oracle_publish')).to.equal(true);

        // The v1 signature verifies over the extended canonical.
        let sigCount = Number(v1[16]);
        expect(sigCount).to.equal(1);
        let canonical = nd.pub._archiveCanonical(nd.pub._cpFromRow(nd.db.checkpoints[0]), 0, 1, v1[13], 1);
        expect(ValidatorIdentity.verify(canonical, v1[18], v1[17])).to.be.true;

        expect(nd.db.matches[0].batch_seq).to.equal(0);
        expect(nd.db.matches[0].archived_status).to.equal('finalized');
    });

    it('oversized archive splits into v1 + v2 chunks that reassemble byte-identically', async function () {
        let many = [];
        for (let i = 0; i < 40; i++) many.push(matchRow('m' + String(i).padStart(3, '0')));
        let bus = buildMesh(1, { matches: many, cfg: { ANCHOR_CHUNK_MAX_BYTES: '500' } });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);

        let v1 = nd.published[1].split('|');
        let total = Number(v1[14]);
        expect(total).to.be.greaterThan(1);
        expect(nd.published.length).to.equal(1 + total);               // v0 + v1 + (total-1) v2s
        let b64 = v1[15];
        for (let i = 2; i < nd.published.length; i++) {
            let v2 = nd.published[i].split('|');
            expect(v2[1]).to.equal('2');
            expect(Number(v2[2])).to.equal(0);                          // MATCH_BATCH_SEQ
            expect(Number(v2[3])).to.equal(i - 1);                      // CHUNK_INDEX
            expect(Number(v2[4])).to.equal(total);
            b64 += v2[5];
        }
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64url')).toString('utf8'));
        expect(archive.matches.length).to.equal(40);
    });

    it('N=4: per-row v0 election + archive leader; v1 carries 2f+1 sigs; back-fill propagates', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        await startAll(bus);
        let v0Pub  = v0Order(bus)[0];                                  // elected for the BTC checkpoint
        let leader = archiveLeader(bus, 101);                          // elected archive leader
        await flushAll(bus);                                           // every hub's timer fires
        await sleep(100);

        // Exactly one v0, published by the hash-order rank-0 node for that row's key.
        let v0s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '0').map(() => nd));
        expect(v0s.length).to.equal(1);
        expect(v0s[0]).to.equal(v0Pub);
        // XANC_V0_DONE back-fills every peer's row, so no other hub re-anchors.
        for (let nd of bus.nodes) expect(nd.db.checkpoints[0].anchor_txid, 'node ' + nd.i).to.be.a('string');

        // Exactly one v1, published by the elected archive leader with quorum sigs.
        let v1Nodes = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(v1Nodes.length).to.equal(1);
        expect(v1Nodes[0]).to.equal(leader);
        let v1 = leader.published.find(p => p.split('|')[1] === '1').split('|');
        let sigCount = Number(v1[16]);
        expect(sigCount).to.be.at.least(3);                            // quorum 2f+1 = 3
        let canonical = leader.pub._archiveCanonical(leader.pub._cpFromRow(leader.db.checkpoints[0]), 0, 1, v1[13], 1);
        for (let i = 0; i < sigCount; i++)
            expect(ValidatorIdentity.verify(canonical, v1[18 + 2 * i], v1[17 + 2 * i])).to.be.true;

        // All nodes back-filled batch metadata (leader directly, rest via XANC_FINALIZED).
        for (let nd of bus.nodes) {
            expect(nd.db.matches[0].batch_seq, 'node ' + nd.i).to.equal(0);
            expect(nd.db.matches[0].archived_status).to.equal('finalized');
        }

        // Rewards: the v0 publisher recorded anchor_BTC @ checkpoint_seq, the
        // archive leader anchor_archive @ batch_seq — each credited to itself.
        expect(v0Pub.rewards.some(r => r.type === 'anchor_BTC' && r.round === 7 && r.pubkey === v0Pub.pubkey)).to.equal(true);
        expect(leader.rewards.some(r => r.type === 'anchor_archive' && r.round === 0 && r.pubkey === leader.pubkey)).to.equal(true);
        for (let nd of bus.nodes) {
            if (nd !== v0Pub)  expect(nd.rewards.filter(r => r.type === 'anchor_BTC').length, 'node ' + nd.i).to.equal(0);
            if (nd !== leader) expect(nd.rewards.filter(r => r.type === 'anchor_archive').length, 'node ' + nd.i).to.equal(0);
        }
    });

    it('followers refuse an archive that diverges from their own match rows', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        let leader = archiveLeader(bus, 101);
        // Two followers hold a different amount for m1 → the leader can reach at
        // most 2 sigs (self + 1 honest) < quorum 3 → nothing published.
        let mutated = 0;
        for (let nd of bus.nodes) {
            if (nd !== leader && mutated < 2) { nd.db.matches[0].a_amount = '999'; mutated++; }
        }
        await startAll(bus);
        await leader.pub.flush();
        await sleep(120);
        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length).to.equal(0);
        for (let nd of bus.nodes) expect(nd.db.matches[0].batch_seq).to.equal(null);
    });

    it('failover ladder: higher ranks unlock only after the tolerance window', async function () {
        // since = btcBlock - snapshot_block = 37 → floor(37/36) = 1 → ranks 0–1.
        let bus = buildMesh(4, { btcBlock: 137 });
        await startAll(bus);
        let order = v0Order(bus);

        await order[2].pub.flush();                                    // rank 2: still locked
        await order[3].pub.flush();                                    // rank 3: still locked
        await sleep(30);
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '0').length).to.equal(0);

        await order[1].pub.flush();                                    // rank 1: unlocked (rank 0 absent)
        await sleep(30);
        let v0s = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '0'));
        expect(v0s.length).to.equal(1);
        expect(v0s[0]).to.equal(order[1]);
        // Back-fill reached rank 0 too — it won't double-publish when it returns.
        await order[0].pub.flush();
        await sleep(30);
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '0').length).to.equal(1);
    });

    it('distinct chains elect their own publishers (per-row election keys)', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        // Three pending checkpoints, one per chain, same heights/seq.
        for (let nd of bus.nodes) {
            nd.db.checkpoints.length = 0;
            for (let chain of ['BTC', 'LTC', 'DOGE'])
                nd.db.checkpoints.push(Object.assign({}, CP_ROW, { chain: chain, anchor_txid: null }));
        }
        await startAll(bus);
        await flushAll(bus);
        await sleep(50);

        for (let chain of ['BTC', 'LTC', 'DOGE']) {
            let expected = v0Order(bus, Object.assign({}, CP_ROW, { chain: chain }))[0];
            let publishers = bus.nodes.filter(nd => nd.published.some(p => {
                let f = p.split('|'); return f[1] === '0' && f[2] === chain;
            }));
            expect(publishers.length, chain).to.equal(1);
            expect(publishers[0], chain).to.equal(expected);
            expect(publishers[0].rewards.some(r => r.type === 'anchor_' + chain && r.round === 7)).to.equal(true);
            // Every node's row for this chain is anchored (publisher or gossip).
            for (let nd of bus.nodes)
                expect(nd.db.checkpoints.find(c => c.chain === chain).anchor_txid, chain + ' node ' + nd.i).to.be.a('string');
        }
    });

    it('a hub outside the oracle_publish snapshot never publishes', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        // Drop node 0 from every hub's view of the eligible set.
        let outsider = bus.nodes[0];
        for (let nd of bus.nodes) {
            let eligible = bus.nodes.filter(o => o !== outsider).map(o => ({ pubkey: o.pubkey, amount: '1' }));
            nd.pub.capSnapshot = { async getSnapshot() { return { validators: eligible }; } };
            nd.pub.hub.capabilitySnapshot = nd.pub.capSnapshot;
        }
        await startAll(bus);
        await outsider.pub.flush();
        await sleep(30);
        expect(outsider.published.length).to.equal(0);
        expect(outsider.rewards.length).to.equal(0);
    });

    it('flush returns a summary (and reports election skips honestly)', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        await startAll(bus);
        let first = await nd.pub.flush();
        await sleep(30);
        expect(first.anchored.length).to.equal(1);
        expect(first.anchored[0]).to.include({ chain: 'BTC', network: 'regtest', block_index: 494 });
        expect(first.anchored[0].txid).to.be.a('string');
        expect(first.archive).to.equal('published');

        let second = await nd.pub.flush();
        expect(second.anchored.length).to.equal(0);
        expect(second.archive).to.equal('none');
    });

    it('a match retracted after archival is re-archived with its new status', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);
        expect(nd.db.matches[0].batch_seq).to.equal(0);

        // Reorg retraction after archival → pending again under the re-archival rule.
        nd.db.matches[0].status = 'retracted';
        nd.db.checkpoints[0].anchor_txid = 'already';                  // no new v0 this flush
        await nd.pub.flush();
        await sleep(30);

        let v1s = nd.published.filter(p => p.split('|')[1] === '1');
        expect(v1s.length).to.equal(2);
        let last = v1s[1].split('|');
        expect(Number(last[11])).to.equal(1);                          // new batch_seq
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(last[15], 'base64url')).toString('utf8'));
        expect(archive.matches[0].status).to.equal('retracted');
        expect(nd.db.matches[0].batch_seq).to.equal(1);
        expect(nd.db.matches[0].archived_status).to.equal('retracted');
    });

    it('XCALL relay rows ride the archive (both phases) and back-fill batch metadata', async function () {
        let bus = buildMesh(1, { calls: [callRow('c'.repeat(64), 'dispatch'), callRow('c'.repeat(64), 'result')] });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);

        let v1s = nd.published.filter(p => p.split('|')[1] === '1');
        expect(v1s.length).to.equal(1);
        let f = v1s[0].split('|');
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(f[15], 'base64url')).toString('utf8'));
        // Fixed-key-order call records, both phases, alongside the match.
        expect(archive.matches.length).to.equal(1);
        expect(archive.calls.length).to.equal(2);
        expect(archive.calls[0].phase).to.equal('dispatch');
        expect(archive.calls[0].result_status).to.equal(null);
        expect(archive.calls[1].phase).to.equal('result');
        expect(archive.calls[1].result_status).to.equal('ok');
        expect(archive.calls[1].return_payload_b64).to.equal('cGF5bG9hZA');
        // The cross_chain snapshot for the calls' snapshot_block is self-contained.
        expect(archive.capability_snapshots.some(s => s.capability === 'cross_chain' && s.snapshot_block === 100)).to.equal(true);
        // Batch metadata back-filled on both phases; a second flush archives nothing.
        for (let c of nd.db.calls) {
            expect(c.batch_seq).to.equal(0);
            expect(c.archived_status).to.equal('finalized');
        }
        nd.db.checkpoints[0].anchor_txid = 'already';
        let second = await nd.pub.flush();
        expect(second.archive).to.equal('none');
    });

    it('a follower refuses to co-sign an archive whose call terms diverge from its DB', async function () {
        let bus = buildMesh(4, {
            calls: [callRow('d'.repeat(64), 'dispatch')],
            btcBlock: 300
        });
        // Two non-leader nodes hold a mutated copy of the call → no quorum forms.
        let leader = archiveLeader(bus, 300);
        let mutated = 0;
        for (let nd of bus.nodes) {
            if (nd !== leader && mutated < 2) { nd.db.calls[0].gas_limit = 999999; mutated++; }
        }
        await startAll(bus);
        await leader.pub.flush();
        await sleep(50);
        for (let nd of bus.nodes) expect(nd.db.calls[0].batch_seq).to.equal(null);
    });
});
