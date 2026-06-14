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
    let matches = [], checkpoints = [], snapshots = [], calls = [], rewardRows = [];
    return {
        matches, checkpoints, snapshots, calls, rewardRows,
        async doQuery(sql, params) {
            params = params || [];
            if (sql.startsWith('SELECT sc.* FROM state_checkpoints sc JOIN')) {
                let everyN = params[0] || 1;                       // ANCHOR_CHECKPOINT_EVERY_N
                let latest = {};
                for (let r of checkpoints) {
                    if (r.checkpoint_seq % everyN !== 0) continue; // only anchor-eligible seqs
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
            if (sql.startsWith('SELECT snapshot_block FROM state_checkpoints WHERE chain = ?')) {
                return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2])
                    .sort((a, b) => b.checkpoint_seq - a.checkpoint_seq)
                    .slice(0, 1).map(r => ({ snapshot_block: r.snapshot_block }));
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
                for (let r of matches)    if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
                for (let r of calls)      if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
                for (let r of rewardRows) if (r.batch_seq != null && r.batch_seq > max) max = r.batch_seq;
                return [{ next_seq: max + 1 }];
            }
            if (sql.startsWith('SELECT * FROM validator_rewards WHERE reward_type LIKE')) {
                return rewardRows.filter(r => /^anchor_/.test(String(r.reward_type)) && r.batch_seq == null && r.block_index != null)
                    .sort((a, b) => String(a.reward_type).localeCompare(String(b.reward_type)) ||
                                    a.round_number - b.round_number ||
                                    String(a.validator_pubkey).localeCompare(String(b.validator_pubkey)))
                    .slice(0, params[0]);
            }
            if (sql.startsWith('SELECT validator_pubkey, amount, block_index FROM validator_rewards')) {
                return rewardRows.filter(r => r.reward_type === params[0] && r.round_number === params[1]).slice(0, 1);
            }
            if (sql.startsWith('UPDATE validator_rewards SET batch_seq')) {
                for (let r of rewardRows)
                    if (r.reward_type === params[1] && r.round_number === params[2] &&
                        String(r.validator_pubkey).toLowerCase() === params[3]) r.batch_seq = params[0];
                return [];
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
            for (let r of (opts.rewards || [])) db.rewardRows.push(Object.assign({}, r));
            if (opts.mutate) opts.mutate(self, db);

            let hub = {
                db,
                p2pConfig: Object.assign({ ANCHOR_INTERVAL_MS: '3600000' }, opts.cfg || {}),
                capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } },
                getPeerManager: () => peerManager,
                getIdentity: () => identity,
                rewardTracker: {
                    anchorReward: '10.00000000',
                    recordAnchorReward: async (type, round, pubkey, blk) => { self.rewards.push({ type, round, pubkey, blk }); },
                    // Block-scoped indexer resolution — deterministic, so every
                    // hub resolves the same source (overridable for divergence
                    // / unresolvable-source tests).
                    resolveSourceByPubkey: async (pubkey, blk) => (opts.sourceResolver
                        ? opts.sourceResolver(self, pubkey, blk)
                        : 'src_' + String(pubkey).toLowerCase().substring(0, 12))
                },
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
    function archiveOrder(bus, batchSeq) {
        // Content-anchored key: wrapper checkpoint (CP_ROW in the mesh) + batch seq.
        let key = 'XANCV1|' + CP_ROW.chain + '|' + CP_ROW.network + '|' + CP_ROW.checkpoint_seq + '|' + (batchSeq || 0);
        let order = StateAnchorPublisher.hashOrder(key, bus.nodes.map(nd => nd.pubkey));
        return order.map(pk => bus.nodes.find(nd => nd.pubkey === pk));
    }
    function archiveLeader(bus, batchSeq) {
        return archiveOrder(bus, batchSeq)[0];
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

    it('ANCHOR_CHECKPOINT_EVERY_N anchors only the latest divisible seq; off-multiples stay off-chain', async function () {
        // Decouple on-chain anchoring from checkpoint production. With N=2 only
        // even seqs are eligible; the odd one is never anchored (it lives only in
        // the off-chain mirror). Seeds: seq6 already anchored, seq7 (odd, null),
        // seq8 (even, null) — the latest eligible unanchored is seq8.
        let bus = buildMesh(1, {
            cfg: { ANCHOR_CHECKPOINT_EVERY_N: '2' },
            mutate: (self, db) => {
                db.checkpoints.length = 0;
                db.checkpoints.push(Object.assign({}, CP_ROW, { id: 1, block_index: 493, checkpoint_seq: 6, anchor_txid: 'old' }));
                db.checkpoints.push(Object.assign({}, CP_ROW, { id: 2, block_index: 494, checkpoint_seq: 7, anchor_txid: null }));
                db.checkpoints.push(Object.assign({}, CP_ROW, { id: 3, block_index: 495, checkpoint_seq: 8, anchor_txid: null }));
            }
        });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);

        let v0s = nd.published.filter(p => p.split('|')[1] === '0');
        expect(v0s.length, 'exactly one v0 anchor').to.equal(1);
        let v0 = v0s[0].split('|');
        expect(v0[4], 'block_index of anchored row').to.equal('495');   // seq 8
        expect(v0[9], 'checkpoint_seq anchored').to.equal('8');

        let bySeq = s => nd.db.checkpoints.find(r => r.checkpoint_seq === s);
        expect(bySeq(8).anchor_txid, 'seq8 anchored on-chain').to.be.a('string');
        expect(bySeq(7).anchor_txid, 'odd seq7 stays off-chain').to.equal(null);
        expect(bySeq(6).anchor_txid, 'seq6 untouched').to.equal('old');
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
        let leader = archiveLeader(bus);                          // elected archive leader
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

        // Rewards: EVERY hub records both rows — the earner at publish time, the
        // rest by mirroring the signature-verified V0_DONE / FINALIZED
        // announcements — credited to the publisher/leader with the quorum-agreed
        // snapshot_block, so all hubs hold identical reward rows and any of them
        // can build/verify the archive's rewards section.
        for (let nd of bus.nodes) {
            let v0r = nd.rewards.filter(r => r.type === 'anchor_BTC');
            expect(v0r.length, 'node ' + nd.i + ' anchor_BTC').to.equal(1);
            expect(v0r[0], 'node ' + nd.i).to.deep.equal({ type: 'anchor_BTC', round: 7, pubkey: v0Pub.pubkey, blk: 100 });
            let arr = nd.rewards.filter(r => r.type === 'anchor_archive');
            expect(arr.length, 'node ' + nd.i + ' anchor_archive').to.equal(1);
            expect(arr[0], 'node ' + nd.i).to.deep.equal({ type: 'anchor_archive', round: 0, pubkey: leader.pubkey, blk: 100 });
        }
    });

    it('followers refuse an archive that diverges from their own match rows', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        let leader = archiveLeader(bus);
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

    it('late joiners co-sign archives covering history they never held (signature quorum alone)', async function () {
        // Live finding (3-hub venue): rows from the single-hub era exist only in
        // the founding hub's DB; followers added later refused every archive
        // containing them ("diverges from our DB"), so quorum 3 could never be
        // reached and history became unarchivable. A locally-MISSING row must be
        // accepted purely on its archived 2f+1 signatures; a present-but-
        // DIFFERENT row must still refuse (the divergence test above).
        let bus = buildMesh(4, { btcBlock: 101 });
        let leader = archiveLeader(bus);
        let pruned = 0;
        for (let nd of bus.nodes) {
            if (nd !== leader && pruned < 2) { nd.db.matches.length = 0; pruned++; }   // joined after m1
        }
        await startAll(bus);
        await leader.pub.flush();
        await sleep(120);

        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length, 'archive published despite two late joiners').to.equal(1);
        let v1 = v1s[0].split('|');
        expect(Number(v1[16]), 'sig count').to.be.at.least(3);                          // real quorum
    });

    // ── anchor-reward archive rail (F10) ────────────────────────────────────
    // Anchor-publish rewards are hub-pushed rows the indexer can never re-derive
    // from a chain parse — the archive is their recovery transport. Rows carry
    // no per-row signatures, so followers verify them by RE-DERIVATION.

    const pkOf = (i) => new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64)).getPubkeyHex().toLowerCase();
    const srcOf = (pk) => 'src_' + pk.substring(0, 12);
    function rewardRow(pk, over) {
        return Object.assign({
            validator_pubkey: pk, round_number: 7, reward_type: 'anchor_BTC',
            amount: '10.00000000', block_index: 100, batch_seq: null
        }, over || {});
    }

    it('N=4: pending anchor rewards ride the archive with a pinned source and back-fill batch_seq on every hub', async function () {
        let pk0 = pkOf(0);
        let bus = buildMesh(4, { btcBlock: 101, matches: [], rewards: [rewardRow(pk0)] });
        let leader = archiveLeader(bus);
        await startAll(bus);
        await flushAll(bus);
        await sleep(150);

        // Rewards-only batches publish (the empty-check includes rewards) with a
        // real co-sign quorum — followers re-derived every archived field.
        let v1Nodes = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(v1Nodes.length).to.equal(1);
        expect(v1Nodes[0]).to.equal(leader);
        let v1 = leader.published.find(p => p.split('|')[1] === '1').split('|');
        expect(Number(v1[16]), 'sig count').to.be.at.least(3);
        expect(v1[12], 'MATCH_COUNT counts matches only').to.equal('0');

        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(v1[15], 'base64url')).toString('utf8'));
        expect(archive.matches.length).to.equal(0);
        // serializeReward fixed shape, earn-time source pinned by the leader.
        expect(archive.rewards).to.deep.equal([{
            validator_pubkey: pk0, source: srcOf(pk0), round_number: 7,
            reward_type: 'anchor_BTC', amount: '10.00000000', block_index: 100
        }]);
        // oracle_publish set archived at the reward's earn block (recovery
        // re-checks the rewarded pubkey was an eligible publisher).
        expect(archive.capability_snapshots.filter(s =>
            s.capability === 'oracle_publish' && s.snapshot_block === 100).length).to.equal(4);

        // batch_seq back-filled on the leader directly and on followers via
        // XANC_FINALIZED — the row leaves the pending set federation-wide.
        for (let nd of bus.nodes)
            expect(nd.db.rewardRows[0].batch_seq, 'node ' + nd.i).to.equal(0);
    });

    it('a reward whose source cannot be resolved is deferred, not archived as a hole', async function () {
        let bus = buildMesh(1, { rewards: [rewardRow(pkOf(0))], sourceResolver: () => null });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);

        let v1 = nd.published.find(p => p.split('|')[1] === '1').split('|');
        let archive = JSON.parse(zlib.gunzipSync(Buffer.from(v1[15], 'base64url')).toString('utf8'));
        expect(archive.matches.length).to.equal(1);                    // the default match still archives
        expect(archive.rewards).to.deep.equal([]);                     // the reward did not
        expect(nd.db.rewardRows[0].batch_seq).to.equal(null);          // stays pending for a later batch
    });

    it('no matches/calls + only unresolvable rewards publishes NOTHING (empty-archive DOGE-burn fix)', async function () {
        // Live prod regression: an unstaked single-validator hub anchoring its
        // own checkpoints records anchor rewards whose pubkey resolves to no
        // stake source. Pre-fix the archive round counted them as pending and
        // broadcast an empty 0/0/0 archive to DOGE every cycle. With nothing
        // archivable after source resolution the round must publish nothing.
        let bus = buildMesh(1, { matches: [], calls: [], rewards: [rewardRow(pkOf(0))], sourceResolver: () => null });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);

        expect(nd.published.find(p => p.split('|')[1] === '1'), 'no v1 archive published').to.equal(undefined);
        expect(nd.db.rewardRows[0].batch_seq, 'reward stays pending').to.equal(null);
    });

    it('follower re-derivation rejects forged reward type / pubkey / amount / source / conflicting local row', async function () {
        let pk0 = pkOf(0), pk1 = pkOf(1);
        let bus = buildMesh(2, { matches: [], rewards: [rewardRow(pk0)] });
        let verify = (ar) => bus.nodes[1].pub._verifyArchiveAgainstLocal(
            { matches: [], calls: [], rewards: [ar], capability_snapshots: [] });
        let good = {
            validator_pubkey: pk0, source: srcOf(pk0), round_number: 7,
            reward_type: 'anchor_BTC', amount: '10.00000000', block_index: 100
        };

        expect(await verify(good), 'baseline must re-derive cleanly').to.equal(true);
        // oracle_round/attest_fee are indexer-derived and must never ride the archive.
        expect(await verify(Object.assign({}, good, { reward_type: 'oracle_round' }))).to.equal(false);
        // Pubkey outside our oracle_publish set at the earn block.
        expect(await verify(Object.assign({}, good, { validator_pubkey: 'ab'.repeat(32), source: srcOf('ab'.repeat(32)) }))).to.equal(false);
        // Amount must equal OUR configured publish reward exactly.
        expect(await verify(Object.assign({}, good, { amount: '11.00000000' }))).to.equal(false);
        // Source must match our own block-scoped indexer resolution.
        expect(await verify(Object.assign({}, good, { source: 'src_forged' }))).to.equal(false);
        // A held (type, round) row must agree — a leader crediting itself for
        // another hub's publish diverges here on every honest hub.
        expect(await verify(Object.assign({}, good, { validator_pubkey: pk1, source: srcOf(pk1) }))).to.equal(false);
        // Absence alone is tolerated (late joiner): an unheld round still
        // verifies on re-derivation.
        expect(await verify(Object.assign({}, good, { round_number: 8 }))).to.equal(true);
    });

    it('_getNextBatchSeq spans validator_rewards too', async function () {
        let bus = buildMesh(1, { rewards: [rewardRow(pkOf(0), { batch_seq: 5 })] });
        expect(await bus.nodes[0].pub._getNextBatchSeq()).to.equal(6);  // matches/calls hold no seq ≥ 5
    });

    it('followers tolerate per-hub mirror ids in archived rows (id is bookkeeping, not consensus)', async function () {
        // Live finding (3-hub venue): each hub assigns its own AUTO_INCREMENT id
        // to the same finalized row (hub1=60, hub2=36, hub3=34 for one call) —
        // byte-comparing ids made every multi-hub archive unverifiable.
        let bus = buildMesh(4, { btcBlock: 101 });
        let leader = archiveLeader(bus);
        for (let nd of bus.nodes) {
            if (nd !== leader) nd.db.matches[0].id = 1000 + nd.i;          // divergent local cursors
        }
        await startAll(bus);
        await leader.pub.flush();
        await sleep(120);
        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length, 'archive published despite divergent ids').to.equal(1);
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

    it('archive failover ladder: a non-leader publishes once its rank unlocks, with full co-sign quorum', async function () {
        // Live finding (devhost 3-hub): the archive election had NO rank
        // tolerance — a signer-less elected leader stalled archiving (only
        // 1-of-3 elections could publish), and on a static regtest tip the
        // same leader won forever. The election key is now content-anchored
        // (wrapper checkpoint + batch seq) and ranks unlock like v0 anchors:
        // since = btcBlock - wrapper snapshot_block = 37 → floor(37/36) = 1.
        let bus = buildMesh(4, { btcBlock: 137 });
        await startAll(bus);
        let order = archiveOrder(bus);

        await order[2].pub.flush();                                    // rank 2: still locked
        await order[3].pub.flush();                                    // rank 3: still locked
        await sleep(60);
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '1').length).to.equal(0);

        await order[1].pub.flush();                                    // rank 1: unlocked (rank-0 hub signer-less)
        await sleep(120);
        let v1Nodes = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(v1Nodes.length).to.equal(1);
        expect(v1Nodes[0]).to.equal(order[1]);
        // Followers co-signed the rank-1 publisher — a real quorum, not a self-sign.
        let v1 = order[1].published.find(p => p.split('|')[1] === '1').split('|');
        expect(Number(v1[16])).to.be.at.least(3);
        // Back-fill reached every node — the stalled rank-0 won't re-archive on return.
        for (let nd of bus.nodes) expect(nd.db.matches[0].batch_seq, 'node ' + nd.i).to.equal(0);
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

    // ── signing set is resolved at snapshot_block, not the election block ────────
    // The published v1 declares the wrapper checkpoint's snapshot_block on the
    // wire, and the indexer + full-parse recovery verify the wrapper signatures
    // against oracle_publish AT snapshot_block. The leader is elected by the
    // current BTC block for liveness, but the SIGNING/QUORUM set must track
    // snapshot_block — otherwise, when oracle_publish membership drifts inside the
    // tolerance window, a signer present only in the election set contributes a
    // signature the indexer drops, the v1 stores `invalid`, and the rows (already
    // dequeued) become permanently unrecoverable.
    it('archive is signed by the snapshot_block set even when the election-block set has drifted', async function () {
        // Wrapper checkpoint snapshot_block = 100 (CP_ROW); current BTC tip = 110
        // (a 10-block drift, well inside the 36-block tolerance window). Between
        // the two blocks oracle_publish membership changed: C left, D joined.
        let bus = buildMesh(4, { btcBlock: 110 });
        let [A, B, C, D] = bus.nodes;
        let snapSet = [A, B, C].map(nd => ({ pubkey: nd.pubkey, amount: '1' }));   // oracle_publish @ snapshot_block 100
        let elecSet = [A, B, D].map(nd => ({ pubkey: nd.pubkey, amount: '1' }));   // oracle_publish @ election block 110
        let fullSet = bus.nodes.map(nd => ({ pubkey: nd.pubkey, amount: '1' }));   // cross_chain (block-agnostic here)
        let blockAware = {
            async getSnapshot(capability, block) {
                if (capability === 'cross_chain') return { validators: fullSet };
                return { validators: (Number(block) === 100) ? snapSet : elecSet };  // oracle_publish
            }
        };
        for (let nd of bus.nodes) { nd.pub.capSnapshot = blockAware; nd.pub.hub.capabilitySnapshot = blockAware; }

        await startAll(bus);
        await flushAll(bus);
        await sleep(150);

        // Exactly one v1, and every signature on it belongs to the snapshot_block
        // set — so the indexer, verifying against oracle_publish @ snapshot_block,
        // accepts them all and stores the archive `valid`.
        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length, 'exactly one v1 archive').to.equal(1);
        let v1 = v1s[0].split('|');
        expect(v1[10], 'wire SNAPSHOT_BLOCK').to.equal('100');
        let sigCount = Number(v1[16]);
        let snapPubkeys = new Set(snapSet.map(v => v.pubkey));
        let signers = [];
        for (let i = 0; i < sigCount; i++) signers.push(v1[17 + 2 * i]);
        for (let s of signers)
            expect(snapPubkeys.has(s), 'signer ' + s.substring(0, 12) + '… is in the snapshot_block set').to.equal(true);
        // The election-only validator D never contributes a signature that would
        // be dropped on-chain (the pre-fix bug had it signing into the quorum).
        expect(signers.includes(D.pubkey), 'election-only validator absent from the v1 sigs').to.equal(false);
        // Indexer simulation: valid sigs over oracle_publish @ snapshot_block (N=3
        // → quorum 2) clear quorum, so the v1 is on-chain `valid`.
        expect(signers.length, 'sigs valid at snapshot_block reach quorum').to.be.at.least(2);

        // The archive is valid, so the source rows are safely dequeued on every hub.
        for (let nd of bus.nodes) {
            expect(nd.db.matches[0].batch_seq, 'node ' + nd.i).to.equal(0);
            expect(nd.db.matches[0].archived_status, 'node ' + nd.i).to.equal('finalized');
        }
    });

    // ── back-fill is gated on confirmed on-chain validity ───────────────────────
    // Even after a successful DOGE broadcast, the source rows must NOT be marked
    // archived unless the broadcast v1 will reach quorum over oracle_publish @
    // snapshot_block (the indexer's own check). Otherwise settled cross-chain
    // state is dequeued behind an `invalid` on-chain copy and lost forever.
    it('_publishArchive keeps rows pending when the broadcast v1 cannot reach on-chain quorum', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let cp = nd.pub._cpFromRow(nd.db.checkpoints[0]);                  // snapshot_block 100
        let batchSeq = 0, count = 1, crc = 'deadbeef';
        let canonical = nd.pub._archiveCanonical(cp, batchSeq, count, crc, 1);
        // A 3-member snapshot signing set (quorum 2) but only the leader's own
        // signature collected (1 valid) — the indexer would reject it as invalid.
        let validators = [nd.pubkey, pkOf(1), pkOf(2)];
        let round = {
            cp, batchSeq, crc, count, canonical,
            b64: 'x', chunks: ['x'],
            signer: { broadcastFn: nd.pub.broadcastFn },
            quorum: 2,
            matchIds: [{ match_id: 'm1', status: 'finalized' }],
            callIds: [], rewardIds: [],
            validators,
            signatures: new Map([[nd.pubkey, nd.identity.sign(canonical)]]),
            done: true, timer: null
        };
        await nd.pub._publishArchive(round);
        await sleep(20);

        // The v1 broadcast happened (a txid was produced) …
        expect(nd.published.some(p => p.split('|')[1] === '1'), 'v1 was broadcast').to.equal(true);
        // … but the row stays PENDING: batch_seq advances (a re-archive needs a
        // fresh seq) while archived_status is the sentinel, so archived_status <>
        // status keeps it eligible for re-archival rather than lost.
        expect(nd.db.matches[0].batch_seq, 'seq advances').to.equal(0);
        expect(nd.db.matches[0].archived_status, 'row stays pending via sentinel').to.equal('__partial__');
        // No archive reward is recorded for an invalid (non-finalized) publish.
        expect(nd.rewards.filter(r => r.type === 'anchor_archive').length, 'no reward on invalid publish').to.equal(0);
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

    it('a batch that loses v2 chunks is NOT marked archived and re-archives under a fresh seq', async function () {
        // Live finding (bug G): chunk broadcasts hitting txn-mempool-conflict
        // were lost while the batch was already back-filled as archived — an
        // unrecoverable archive (recovery refuses incomplete batches). A partial
        // publish must keep the rows pending and the retry must use a NEW seq
        // (two v1 anchors sharing one seq corrupt chunk reassembly).
        let bus = buildMesh(1, { cfg: { ANCHOR_CHUNK_MAX_BYTES: '600', ANCHOR_CHUNK_RETRY_MS: '1' },
                                 matches: [matchRow('m1'), matchRow('m2'), matchRow('m3')] });
        let nd = bus.nodes[0];
        let dropChunks = true;
        nd.pub.setBroadcastHook(async (payload) => {
            if (dropChunks && payload.split('|')[1] === '2') throw new Error('txn-mempool-conflict');
            nd.published.push(payload);
            return { txid: 'txid' + nd.published.length };
        });
        await startAll(bus);
        await nd.pub.flush();
        await sleep(50);

        // v1 went out but the batch must stay pending (sentinel ≠ real status)
        let v1a = nd.published.find(p => p.split('|')[1] === '1');
        expect(v1a, 'v1 broadcast').to.exist;
        let seqA = Number(v1a.split('|')[11]);
        for (let r of nd.db.matches) {
            expect(r.batch_seq, 'seq advances even on partial').to.equal(seqA);
            expect(r.archived_status).to.equal('__partial__');
        }

        // chunks deliverable again → next flush re-archives EVERYTHING under a new seq
        dropChunks = false;
        await nd.pub.flush();
        await sleep(50);
        let v1s = nd.published.filter(p => p.split('|')[1] === '1');
        expect(v1s.length).to.equal(2);
        let seqB = Number(v1s[1].split('|')[11]);
        expect(seqB, 'fresh seq for the retry').to.be.greaterThan(seqA);
        for (let r of nd.db.matches) {
            expect(r.batch_seq).to.equal(seqB);
            expect(r.archived_status).to.equal(r.status);                  // now genuinely archived
        }
    });

    it('v0 publishes retry through txn-mempool-conflict (and stay pending when exhausted)', async function () {
        // Live finding (first prod ANCHOR cycle post-XCALL deploy): multiple
        // chains' v0 anchors broadcast back-to-back from the one publisher
        // wallet; without a retry only the first landed each 30-min cycle and
        // DOGE/LTC staggered one chain per flush on 258: txn-mempool-conflict.
        let bus = buildMesh(1, { cfg: { ANCHOR_CHUNK_RETRY_MS: '1' } });
        let nd = bus.nodes[0];
        let v0Failures = 0, failuresLeft = 2;
        nd.pub.setBroadcastHook(async (payload) => {
            if (payload.split('|')[1] === '0' && failuresLeft > 0) {
                failuresLeft--; v0Failures++;
                throw new Error('Encoder RPC error: 258: txn-mempool-conflict');
            }
            nd.published.push(payload);
            return { txid: 'txid' + nd.published.length };
        });
        await startAll(bus);
        await nd.pub.flush();
        await sleep(30);

        // Two conflicts absorbed by the retry — the checkpoint still anchors this flush.
        expect(v0Failures).to.equal(2);
        expect(nd.db.checkpoints[0].anchor_txid).to.equal('txid1');

        // Exhausted retries (5 straight conflicts) leave the row pending for the next flush.
        nd.db.checkpoints.push(Object.assign({}, CP_ROW, { id: 2, chain: 'DOGE', anchor_txid: null }));
        failuresLeft = 99;
        await nd.pub.flush();
        await sleep(30);
        expect(nd.db.checkpoints[1].anchor_txid).to.equal(null);

        failuresLeft = 0;
        await nd.pub.flush();
        await sleep(30);
        expect(nd.db.checkpoints[1].anchor_txid).to.be.a('string');
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
        let leader = archiveLeader(bus);
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
