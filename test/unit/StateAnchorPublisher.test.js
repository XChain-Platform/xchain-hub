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

// StateAnchorPublisher: ANCHOR v0/v1/v2 payload construction, the archive
// signing round (followers co-sign only archives matching their own DB),
// chunking round-trips, re-archival of retracted matches, and back-fill via
// XANC_FINALIZED. Mesh harness mirrors StateCheckpointEngine.test.js.

const { expect }            = require('chai');
const zlib                  = require('zlib');
const crypto                = require('crypto');
const os                    = require('os');
const path                  = require('path');
const StateAnchorPublisher  = require('../../src/StateAnchorPublisher');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine');
const ValidatorIdentity     = require('../../src/ValidatorIdentity');
const eq                    = require('../../src/equivocation_header.js');
const ccr                   = require('../../src/cross_chain_royalty_activation.js');
const { waitUntil }         = require('../helpers/waitUntil');

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

// XMATCH canonical (mirror of the publisher's _matchCanonical) - fixtures sign
// real Ed25519 sigs over it so the follower's cryptographic verification passes.
function matchCanonical(m) {
    let raw = ['XMATCH', m.match_id, String(m.snapshot_block),
        m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
        m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
        String(m.effective_time), m.network || '',
        m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
        m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')].join('|');
    // Royalty legs ride the signed match at/above CROSS_CHAIN_ROYALTY (regtest genesis).
    if (ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
        raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
    // EQUIV active in regtest: TAG=XDEX, ROUND_ID=match_id, VIEW=finalizing_view (default 0).
    if (eq.isEquivHeaderActive(m.snapshot_block, m.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
    return raw;
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
    let phase = (c.phase === 'result') ? 'result' : 'dispatch';
    let raw;
    if (c.phase === 'result') {
        raw = ['XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
            c.target_chain, String(c.result_status || ''), sha(c.return_payload_b64), String(c.effective_time)].join('|');
    } else {
        raw = ['XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
            c.source_chain, String(c.source_action_index), String(c.source_contract_index),
            c.target_chain, String(c.target_contract_index), c.method, sha(c.params_json),
            String(c.gas_limit), String(c.cross_hops), String(c.effective_time)].join('|');
    }
    // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|'+phase+'|'+call_id), VIEW=finalizing_view.
    if (eq.isEquivHeaderActive(c.snapshot_block, c.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|' + phase + '|' + c.call_id), (c.finalizing_view != null ? c.finalizing_view : 0), raw);
    return raw;
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
                let net    = sql.includes('AND sc.network = ?') ? params[1] : null; // network scope (when configured)
                let latest = {};
                for (let r of checkpoints) {
                    if (r.checkpoint_seq % everyN !== 0) continue; // only anchor-eligible seqs
                    let k = r.chain + '|' + r.network;
                    if (!latest[k] || r.checkpoint_seq > latest[k].checkpoint_seq) latest[k] = r;
                }
                return Object.values(latest).filter(r => r.anchor_txid == null && (net == null || r.network === net));
            }
            if (sql.startsWith("SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC")) {
                let sorted = checkpoints.filter(r => r.network === params[0])
                    .sort((x, y) => (y.chain === 'BTC') - (x.chain === 'BTC') || y.id - x.id);
                return sorted.slice(0, 1);
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
            if (sql.startsWith('SELECT * FROM cross_chain_matches WHERE match_id IN')) {
                return matches.filter(r => params.includes(r.match_id) && r.status !== 'retracted');
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
                let onlyPending = sql.includes('batch_seq IS NULL');
                for (let r of rewardRows)
                    if (r.reward_type === params[1] && r.round_number === params[2] &&
                        String(r.validator_pubkey).toLowerCase() === params[3] &&
                        (!onlyPending || r.batch_seq == null)) r.batch_seq = params[0];
                return [];
            }
            if (sql.startsWith('UPDATE cross_chain_matches SET batch_seq')) {
                let onlyEligible = sql.includes('batch_seq IS NULL OR archived_status <> status');
                for (let r of matches) if (r.match_id === params[3] &&
                    (!onlyEligible || r.batch_seq == null || r.archived_status !== r.status)) {
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
                let onlyEligible = sql.includes('batch_seq IS NULL OR archived_status <> status');
                for (let r of calls) if (r.call_id === params[3] && r.phase === params[4] &&
                    (!onlyEligible || r.batch_seq == null || r.archived_status !== r.status)) {
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

const arMod = require('../../src/anchor_reward_activation.js');

describe('StateAnchorPublisher', function () {

    let buses = [];
    afterEach(async function () {
        for (let bus of buses) { for (let nd of bus.nodes) await nd.pub.stop(); }
        buses = [];
    });

    // These legacy v0/v1/v3 production tests exercise the PRE-anchor-reward-flag-day
    // producer path (still real below the flag-day on mainnet, and as the degraded-
    // federation fallback). Pin the regtest flag-day DORMANT here so the producer keeps
    // emitting v0/v3; the nested 'publisher-attestation round (v4/v5)' suite below
    // re-activates it. save/restore keeps the toggle isolation-safe regardless of order.
    let savedRegtestFlagDay, savedArchiveRegtestFlagDay;
    beforeEach(function () {
        savedRegtestFlagDay        = arMod.ANCHOR_REWARD_ACTIVATION.regtest;
        savedArchiveRegtestFlagDay = arMod.ARCHIVE_REWARD_ACTIVATION.regtest;
        arMod.ANCHOR_REWARD_ACTIVATION.regtest  = 999999999;
        arMod.ARCHIVE_REWARD_ACTIVATION.regtest = 999999999;
    });
    afterEach(function () {
        arMod.ANCHOR_REWARD_ACTIVATION.regtest  = savedRegtestFlagDay;
        arMod.ARCHIVE_REWARD_ACTIVATION.regtest = savedArchiveRegtestFlagDay;
    });

    // n publishers over a shared gossip bus. Every node shares identical DB
    // contents unless opts.mutate(self) tweaks its copy (divergence tests).
    function buildMesh(n, opts) {
        opts = opts || {};
        let bus = { nodes: [], onchain: [] };   // onchain = mined checkpoint anchors (existence gate)
        // txid -> the ANCHOR version that txid really carries on-chain. A receiver asking
        // for no EXACT version (the #4180 archive-head gate sends a version SET, and
        // rejectVersions is a client-side check the indexer never sees) must get the real
        // version back. Filled automatically for anything broadcast on the mesh; a test
        // that names a synthetic archive txid declares it here.
        bus.anchorVersions = new Map();
        // Network stamped on the checkpoint/match/call rows. Defaults to CP_ROW's
        // regtest. This routes the archive/attestation quorum gates through the
        // RECORD's network (matching the indexer), and regtest activates
        // STAKE_WEIGHTED_QUORUM at block 0, so regtest records take the weighted path.
        // A count-path test passes network:'mainnet': with snapshot_block 100 below the
        // mainnet SWQ activation (961000, per src/stake_weighted_quorum.js), the gate
        // resolves to the legacy 2f+1 COUNT quorum these tests exercise (every other
        // snapshot-block-gated rule - EQUIV, checkpoint-commitment, royalty, the anchor/
        // archive reward flag-days - also activates at >=961000 on mainnet, so a block-100
        // mainnet record sits on the fully-legacy, headerless path the count assertions expect).
        let recordNetwork = opts.network || CP_ROW.network;
        bus.network = recordNetwork;
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
            db.checkpoints.push(Object.assign({}, CP_ROW, { network: recordNetwork, anchor_txid: null }));
            // Every node holds identically-TERMED matches; the signature set is
            // signed by a quorum of mesh identities (matching production, where
            // each hub's collected set may differ but the terms never do).
            for (let m of (opts.matches || [matchRow('m1')])) {
                let row = Object.assign({}, m, { network: recordNetwork });
                if (row.validator_signatures == null) {
                    let canon = matchCanonical(row);
                    let signers = identities.slice(0, Math.max(1, n - 1));
                    row.validator_signatures = JSON.stringify(signers.map(id =>
                        ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canon) })));
                }
                db.matches.push(row);
            }
            for (let c of (opts.calls || [])) {
                let row = Object.assign({}, c, { network: recordNetwork });
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
                // DOGE_INDEXER_URL wired so _verifyAnchorOnChain runs its real gate;
                // the _indexerCall stub below (installed per node) answers
                // getanchoraction from the node's OWN checkpoint rows, i.e. the
                // honest case (the on-chain anchor byte-matches the local checkpoint
                // at full depth). Adversarial receiver-path tests override the stub.
                p2pConfig: Object.assign({ ANCHOR_INTERVAL_MS: '3600000', DOGE_INDEXER_URL: 'http://doge-indexer.test' }, opts.cfg || {}),
                capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } },
                // Populated oracle_publish registry: the V0_DONE/FINALIZED handlers resolve
                // the membership set via _getActiveOraclePublishPubkeys(null), which now falls
                // through to the registry. Mirrors a live hub (registry populated post-startup);
                // the empty-set case is the fail-closed startup window, exercised separately.
                capabilityRegistry: { getActiveValidators: async () => validators.slice(0, n).map(v => v.pubkey) },
                getPeerManager: () => peerManager,
                getIdentity: () => identity,
                rewardTracker: {
                    anchorReward: '10.00000000',
                    recordAnchorReward: async (type, round, pubkey, blk) => { self.rewards.push({ type, round, pubkey, blk }); },
                    // Block-scoped indexer resolution - deterministic, so every
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
            // start() arms the spend guard's durable window, so point it
            // at a per-node temp file the way this suite already points queuePath and
            // walPath. Left on its ./data default, every mesh node in every run wrote
            // into the checkout and the NEXT run inherited the spends, which reddens
            // this file once an hour of runs adds up to the window budget.
            self.pub.spendGuard.statePath = path.join(
                os.tmpdir(), 'anchor-spend-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.json');
            // Default on-chain ANCHOR oracle: answer getanchoraction from this
            // node's own checkpoint rows so the honest receiver path (V0_DONE /
            // FINALIZED for a checkpoint we actually hold) verifies at full depth.
            // Returns exists:false for an unknown checkpoint (the phantom-txid case).
            //
            // Models the HONEST case for the txid/version filter: the announced txid IS
            // the transaction the anchor landed in, and the requested version is the one
            // on-chain, so the row is echoed back bound to whatever the caller asked for.
            // Adversarial receiver-path tests override this stub to return a different
            // txid (forge), checkpoint_anchored, or no txid at all (stale indexer).
            self.pub._indexerCall = async (coin, method, params) => {
                if (method !== 'getanchoraction') return null;
                // A real DOGE indexer only knows MINED anchors. The
                // pre-broadcast existence check is the only txid-LESS caller
                // (receiver verification always binds an announced txid), so gate
                // txid-less lookups on a checkpoint anchor having actually been
                // broadcast on the mesh (bus.onchain, recorded by the broadcast
                // hook below); otherwise every fresh checkpoint would look
                // already-anchored and no publish test could run. txid-bound
                // lookups keep the honest-echo model (tests inject V0_DONE for
                // anchors that "landed" without a mesh broadcast).
                if (!params.txid) {
                    let mined = bus.onchain.some(a => a.chain === String(params.chain) &&
                        a.network === String(params.network) &&
                        Number(a.block_index) === Number(params.block_index));
                    if (!mined) return { exists: false, checkpoint_anchored: false, confirmations: 0 };
                }
                let r = db.checkpoints.find(c => c.chain === params.chain && c.network === params.network &&
                    Number(c.block_index) === Number(params.block_index));
                if (!r) return { exists: false, checkpoint_anchored: false, confirmations: 0 };
                return {
                    exists: true, checkpoint_anchored: true, status: 'valid',
                    version: (params.version != null) ? Number(params.version)
                             : (params.txid != null && bus.anchorVersions.has(String(params.txid))
                                ? Number(bus.anchorVersions.get(String(params.txid))) : 0),
                    txid: params.txid || 'onchain-txid',
                    confirmations: self.pub.dogeConfirmations,
                    block_hash: r.block_hash, ledger_hash: r.ledger_hash,
                    actions_hash: r.actions_hash, contract_hash: r.contract_hash,
                    state_root: r.state_root || null, block_merkle_root: r.block_merkle_root || null
                };
            };
            self.pub.setBroadcastHook(async (payload) => {
                self.published.push(payload);
                // Model mining: a broadcast CHECKPOINT anchor (v0/v3/v4/v5) becomes
                // visible to every node's getanchoraction stub (bus.onchain).
                let f = String(payload).split('|');
                if (f[0] === 'ANCHOR' && ['0', '3', '4', '5'].includes(f[1])) {
                    bus.onchain.push({ chain: f[2], network: f[3], block_index: Number(f[4]) });
                }
                // Record what version this txid actually is, so a version-SET lookup
                // (the #4180 archive-head gate) gets the truth rather than a default.
                // v2 continuation chunks are excluded: they are not an anchor HEAD.
                if (f[0] === 'ANCHOR' && f[1] !== '2')
                    bus.anchorVersions.set('txid' + self.published.length, Number(f[1]));
                return { txid: 'txid' + self.published.length };
            });
            bus.nodes.push(self);
        }
        // Stake-weighted quorum setup. The reward-attestation payloads (v4/v5/v6) can
        // only be produced at/above the anchor/archive reward flag-day, which on every
        // network activates at or above the SWQ height (mainnet 961000/963000, regtest 0),
        // so a round that emits them ALWAYS runs on the weighted quorum path - there is no
        // count-path snapshot_block for them. Scope each hub to the record network so
        // _resolveCapabilitySet (which keys on this.network) resolves the WEIGHTED,
        // source-keyed snapshot the round's stake tally needs, and back it with one
        // distinct source per validator at equal weight: the 2/3-stake bar then coincides
        // exactly with the 2f+1 count these tests assert (3-of-4), so the quorum-size
        // assertions are unchanged - only the tally MECHANISM the fix now selects differs.
        if (opts.stakeWeighted) {
            let weightSet = bus.nodes.map((nd, i) => ({ pubkey: nd.pubkey, weight: '1', source: 'wsrc' + i }));
            for (let nd of bus.nodes) {
                nd.pub.network = recordNetwork;
                let snap = {
                    async getSnapshot() { return { validators: weightSet.map(v => ({ pubkey: v.pubkey, amount: '1' })) }; },
                    async getWeightSnapshot() { return { validators: weightSet }; }
                };
                nd.pub.capSnapshot = snap;
                nd.pub.hub.capabilitySnapshot = snap;
            }
        }
        buses.push(bus);
        return bus;
    }

    // Election helpers mirroring the publisher's hash-ordering (different key
    // per pending checkpoint, one per election block for the archive round).
    function v0Order(bus, row) {
        // Default to the mesh's actual checkpoint row (CP_ROW at the bus's record
        // network) so the election key matches the source, which keys on the row's network.
        row = row || Object.assign({}, CP_ROW, { network: bus.network });
        let key = 'XANCV0|' + row.chain + '|' + row.network + '|' + row.checkpoint_seq + '|' + row.snapshot_block;
        let order = StateAnchorPublisher.hashOrder(key, bus.nodes.map(nd => nd.pubkey));
        return order.map(pk => bus.nodes.find(nd => nd.pubkey === pk));
    }
    function archiveOrder(bus, batchSeq) {
        // Content-anchored key: wrapper checkpoint (CP_ROW at the bus's record network) + batch seq.
        let key = 'XANCV1|' + CP_ROW.chain + '|' + bus.network + '|' + CP_ROW.checkpoint_seq + '|' + (batchSeq || 0);
        let order = StateAnchorPublisher.hashOrder(key, bus.nodes.map(nd => nd.pubkey));
        return order.map(pk => bus.nodes.find(nd => nd.pubkey === pk));
    }
    function archiveLeader(bus, batchSeq) {
        return archiveOrder(bus, batchSeq)[0];
    }
    async function startAll(bus) { for (let nd of bus.nodes) await nd.pub.start(); }
    async function flushAll(bus) { for (let nd of bus.nodes) await nd.pub.flush(); }

    // Publisher-attestation round (v4/v5): at/above the anchor-reward flag-day the
    // producer emits ANCHOR v4 (rootless) / v5 (root-bearing) carrying the elected
    // publisher + a 2f+1 oracle_publish attestation over XANCPUB, so the indexer DERIVES
    // the reward and the forgeable hub push is retired (#5311). This suite RE-ACTIVATES
    // the regtest flag-day (the parent suite pins it dormant for the legacy v0/v3 path).
    describe('publisher-attestation round (v4/v5)', function () {

        beforeEach(function () { arMod.ANCHOR_REWARD_ACTIVATION.regtest = 0; });   // active at genesis

        // Independent reimplementation of the indexer's Anchor._rewardCanonical: the hub's
        // _attestationCanonical MUST be byte-identical to this, or the derived reward forks.
        function rewardCanonical(cp, publisher) {
            let base = ['XANCPUB', 'anchor_' + cp.chain, String(cp.checkpoint_seq),
                        String(cp.snapshot_block), String(publisher).toLowerCase(),
                        arMod.ANCHOR_REWARD_AMOUNT].join('|');
            if (eq.isEquivHeaderActive(cp.snapshot_block, cp.network)) {
                let roundId = 'XANCPUB|' + cp.chain + '|' + cp.network + '|' + cp.checkpoint_seq + '|' + cp.snapshot_block;
                return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
            }
            return base;
        }

        it('_attestationCanonical is byte-identical to the indexer reward canonical (EQUIV-wrapped)', function () {
            let bus = buildMesh(1);
            let pub = bus.nodes[0].pub;
            let cp  = pub._cpFromRow(Object.assign({}, CP_ROW));
            let publisher = bus.nodes[0].pubkey;
            let expected = rewardCanonical(cp, publisher);
            // Sanity: the wrapped form is what the federation signs at/above the EQUIV flag-day.
            expect(expected).to.equal(
                'EQUIV|XCHECKPOINT|XANCPUB|BTC|regtest|7|100|0||XANCPUB|anchor_BTC|7|100|' +
                publisher + '|10.00000000');
            expect(pub._attestationCanonical(cp, publisher)).to.equal(expected);
        });

        it('single-node: flush emits ANCHOR v4 with a self-attestation the indexer can verify', async function () {
            // Weighted: v4 only emits at/above the anchor-reward flag-day, which everywhere
            // sits at/above the SWQ height, so there is no count-path block for it. Keep regtest
            // (flag-day active here) and back the round with one equal-weight source (self-attest).
            let bus = buildMesh(1, { stakeWeighted: true });
            let nd  = bus.nodes[0];
            await startAll(bus);
            await nd.pub.flush();
            await waitUntil(() => nd.published.some(p => p.split('|')[1] === '4'), { label: 'the single-node flush to emit a v4 anchor' });

            let v4 = nd.published.find(p => p.split('|')[1] === '4');
            expect(v4, 'a v4 anchor was published').to.be.a('string');
            let parts = v4.split('|');
            let sigCount = Number(parts[11]);                              // root SIG_COUNT
            let pubBase  = 12 + 2 * sigCount;
            expect(parts[pubBase], 'PUBLISHER').to.equal(nd.pubkey);
            expect(Number(parts[pubBase + 1]), 'ATTEST_SIG_COUNT').to.equal(1);
            let aPub = parts[pubBase + 2], aSig = parts[pubBase + 3];
            expect(aPub).to.equal(nd.pubkey);
            let cp = nd.pub._cpFromRow(nd.db.checkpoints[0]);
            expect(ValidatorIdentity.verify(rewardCanonical(cp, nd.pubkey), aSig, aPub)).to.be.true;

            // The anchor still lands and the reward is recorded (hub-local + mirrored).
            expect(nd.db.checkpoints[0].anchor_txid).to.be.a('string');
            expect(nd.rewards.filter(r => r.type === 'anchor_BTC').length).to.equal(1);
        });

        // item 2676: the balance check is a hard pre-send gate, not an advisory WARN.
        it('skips the flush when a wired DOGE balance is below the floor (item 2676)', async function () {
            let bus = buildMesh(1);
            let nd  = bus.nodes[0];
            nd.pub.setBalanceHook(async () => nd.pub.lowBalanceThreshold - 1);   // below floor
            await startAll(bus);
            let before = nd.published.length;
            let res = await nd.pub.flush();
            expect(res.skipped).to.equal('below_balance_floor');
            expect(nd.published.length).to.equal(before);   // nothing broadcast
        });

        it('skips the flush when a wired DOGE balance is unreadable (fail-closed, item 2676)', async function () {
            let bus = buildMesh(1);
            let nd  = bus.nodes[0];
            nd.pub.setBalanceHook(async () => { throw new Error('rpc down'); });  // -> null
            await startAll(bus);
            let before = nd.published.length;
            let res = await nd.pub.flush();
            expect(res.skipped).to.equal('balance_unreadable');
            expect(nd.published.length).to.equal(before);
        });

        it('publishes normally when the wired balance is above the floor (item 2676)', async function () {
            // Weighted: the flag-day-active flush emits a v4, which runs on the SWQ path (see
            // the v4 test above); one equal-weight source self-attests so the publish proceeds.
            let bus = buildMesh(1, { stakeWeighted: true });
            let nd  = bus.nodes[0];
            nd.pub.setBalanceHook(async () => nd.pub.lowBalanceThreshold + 100);
            await startAll(bus);
            let res = await nd.pub.flush();
            await waitUntil(() => nd.published.length > 0, { label: 'the above-floor flush to broadcast an anchor' });
            expect(res.skipped).to.be.undefined;
            expect(nd.published.length).to.be.greaterThan(0);
        });

        it('root-bearing checkpoint emits v5 (v3 shape + publisher tail)', async function () {
            // Weighted: v5 (root-bearing v4) only emits at/above the anchor-reward flag-day,
            // which sits at/above the SWQ height; keep regtest and self-attest one equal-weight source.
            let bus = buildMesh(1, {
                stakeWeighted: true,
                mutate: (self, db) => {
                    db.checkpoints[0].state_root           = 'aa'.repeat(32);
                    db.checkpoints[0].state_root_version   = 1;
                    db.checkpoints[0].block_merkle_root    = 'bb'.repeat(32);
                    db.checkpoints[0].block_merkle_version = 1;
                }
            });
            let nd = bus.nodes[0];
            await startAll(bus);
            await nd.pub.flush();
            await waitUntil(() => nd.published.some(p => p.split('|')[1] === '5'), { label: 'the root-bearing flush to emit a v5 anchor' });

            let v5 = nd.published.find(p => p.split('|')[1] === '5');
            expect(v5, 'a v5 anchor was published').to.be.a('string');
            let parts = v5.split('|');
            expect(parts[11], 'STATE_ROOT').to.equal('aa'.repeat(32));
            let sigCount = Number(parts[15]);                              // root SIG_COUNT (v5 sigBase)
            let pubBase  = 16 + 2 * sigCount;
            expect(parts[pubBase], 'PUBLISHER').to.equal(nd.pubkey);
            expect(Number(parts[pubBase + 1]), 'ATTEST_SIG_COUNT').to.be.at.least(1);
        });

        it('N=4: the elected publisher collects a 2f+1 XANCPUB quorum and emits v4', async function () {
            // v4 requires the anchor-reward flag-day active, which shares the 961000 height
            // with SWQ, so this round runs weighted; equal source-weights make the 2/3-stake
            // bar coincide with 2f+1 (3-of-4), so the quorum-size assertions below are unchanged.
            let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true });
            await startAll(bus);
            let leader = v0Order(bus)[0];                                   // rank-0 publisher for CP_ROW
            await leader.pub.flush();
            await waitUntil(() => leader.published.some(p => p.split('|')[1] === '4'), { label: 'the rank-0 publisher to emit a v4 anchor' });

            let v4 = leader.published.find(p => p.split('|')[1] === '4');
            expect(v4, 'rank-0 publisher emitted a v4').to.be.a('string');
            let parts = v4.split('|');
            let sigCount = Number(parts[11]);
            let pubBase  = 12 + 2 * sigCount;
            expect(parts[pubBase], 'PUBLISHER').to.equal(leader.pubkey);
            let attestCount = Number(parts[pubBase + 1]);
            expect(attestCount, '2f+1 attestation quorum').to.be.at.least(3);

            // Every attestation sig verifies over the shared XANCPUB canonical and belongs
            // to the oracle_publish set; the publisher is among the signers.
            let cp = leader.pub._cpFromRow(leader.db.checkpoints[0]);
            let canonical = rewardCanonical(cp, leader.pubkey);
            let setPubkeys = new Set(bus.nodes.map(n => n.pubkey));
            let signers = [];
            for (let i = 0; i < attestCount; i++) {
                let aPub = parts[pubBase + 2 + 2 * i], aSig = parts[pubBase + 2 + 2 * i + 1];
                expect(setPubkeys.has(aPub), 'attester in oracle_publish set').to.be.true;
                expect(ValidatorIdentity.verify(canonical, aSig, aPub)).to.be.true;
                signers.push(aPub);
            }
            expect(signers).to.include(leader.pubkey);
        });

        it('liveness fallback: a publisher that cannot reach attestation quorum emits legacy v0 (anchor lands, no v4)', async function () {
            // Degraded federation: the elected publisher is the ONLY started node, so no peer
            // co-signs XANCPUB. The bounded round times out and the publisher FALLS BACK to a
            // legacy v0 so the anchor still lands. A failed reward attestation must never block
            // the anchor (the primary safety invariant).
            // Weighted: v4 emission requires the SWQ path (flag-day >= SWQ height), so the
            // degraded round runs weighted too. The lone started leader holds 1-of-4 equal
            // weight, far under the 2/3 stake bar, so the round times out into the v0 fallback
            // exactly as the count path would with 1-of-4 signatures.
            let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
            let leader = v0Order(bus)[0];
            await leader.pub.start();                                       // followers intentionally NOT started
            await leader.pub.flush();
            // The v0 fallback is what the timed-out attestation round produces, so it is
            // the observable this round ends on (the no-v4 assertion then means something).
            await waitUntil(() => leader.published.some(p => p.split('|')[1] === '0'), { label: 'the timed-out attestation round to fall back to a legacy v0' });

            expect(leader.published.some(p => p.split('|')[1] === '4'), 'no v4 emitted').to.be.false;
            let v0 = leader.published.find(p => p.split('|')[1] === '0');
            expect(v0, 'fell back to legacy v0').to.be.a('string');
            expect(leader.db.checkpoints[0].anchor_txid, 'anchor still landed').to.be.a('string');
            // Reward-parity guard: at/above the flag-day no live indexer derives a
            // reward from a legacy v0 (formats 4/5 only) and the hub push is retired,
            // so recording one here would strand it in hub/archive bookkeeping and
            // fork a recovered ledger from live nodes. The degraded publish must
            // withhold the reward entirely.
            expect(leader.rewards.filter(r => r.type === 'anchor_BTC').length,
                'no anchor_BTC reward on a degraded legacy fallback').to.equal(0);
        });

        it('a peer does NOT mirror the anchor_<chain> reward from V0_DONE at/above the flag-day', async function () {
            // V0_DONE does not carry (and its canonical does not bind) which payload
            // version landed, so at/above the flag-day the mirror could mint a reward
            // for a degraded legacy fallback no live indexer credits. Peers therefore
            // skip the mirror entirely; live + recovering indexers derive the credit
            // from the on-chain v4/v5 attestation instead.
            let bus = buildMesh(3);
            let order = v0Order(bus, CP_ROW);
            let publisher = order[0];
            let receiver  = order[1];
            let d = { chain: CP_ROW.chain, network: CP_ROW.network, block_index: CP_ROW.block_index,
                      checkpoint_seq: CP_ROW.checkpoint_seq, txid: 'cc'.repeat(32) };
            d.sig_pubkey = publisher.pubkey;
            d.sig = publisher.identity.sign(receiver.pub._v0DoneCanonical(d, d.txid));

            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });

            expect(receiver.db.checkpoints[0].anchor_txid, 'the stamp itself still lands').to.equal('cc'.repeat(32));
            expect(receiver.rewards.filter(r => r.type === 'anchor_BTC').length,
                'no mirrored anchor_BTC at/above the flag-day').to.equal(0);
        });

        it('a follower refuses to co-sign when the proposer is not the rank-unlocked publisher', async function () {
            // The XANCPUB attestation binds the publisher to the v0 election: a non-rank-0
            // proposer (with the ladder not yet unlocked) must collect no follower signatures.
            let bus = buildMesh(4, { btcBlock: 100, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
            await startAll(bus);
            let order   = v0Order(bus);
            let impostor = order[order.length - 1];                        // highest rank, never unlocked at since=0
            let cp = impostor.pub._cpFromRow(impostor.db.checkpoints[0]);
            let canonical = impostor.pub._attestationCanonical(cp, impostor.pubkey);

            let collected = 0;
            let origBroadcast = impostor.pub.peerManager.broadcast;
            // Drive a bare REQ from the impostor and count co-signs that come back.
            impostor.pub._attestRound = {
                cp, publisher: impostor.pubkey, canonical, quorum: 3, weighted: false,
                validators: bus.nodes.map(n => ({ pubkey: n.pubkey, source: '', weight: '1' })),
                signatures: new Map([[impostor.pubkey, impostor.identity.sign(canonical)]]),
                done: false, timer: null, resolve: () => { collected++; }
            };
            // A refusal has nothing of its own to poll for, so wait on the thing that
            // makes the refusal final: every follower's message handler having run to
            // completion. A follower that DID co-sign broadcasts from inside that
            // handler, so once all of them settle the signature set can no longer grow.
            let handled = [];
            for (let nd of bus.nodes) {
                if (nd === impostor) continue;
                let origHandler = nd.handler;
                nd.handler = (env) => { let p = origHandler(env); handled.push(Promise.resolve(p)); return p; };
            }
            impostor.pub.peerManager.broadcast('XANCPUB_SIGN_REQ', {
                checkpoint: cp, publisher: impostor.pubkey,
                sig_pubkey: impostor.pubkey, sig: impostor.identity.sign(canonical)
            });
            await waitUntil(() => handled.length === bus.nodes.length - 1,
                { label: 'every follower to receive the impostor SIGN_REQ' });
            await Promise.all(handled);
            expect(impostor.pub._attestRound.signatures.size, 'only the impostor self-sig').to.equal(1);
        });
    });

    // Archive publisher-attestation round (v6): at/above the archive-reward
    // flag-day the elected archive leader emits ANCHOR v6 (the v1 archive anchor + the
    // publisher tail) carrying a 2f+1 oracle_publish attestation over the archive XANCPUB
    // canonical, so the indexer DERIVES the anchor_archive reward and the last
    // key-authenticated push rail is retired. This suite RE-ACTIVATES the archive
    // regtest flag-day only (the checkpoint side stays legacy v0, isolating the leg).
    describe('archive publisher-attestation round (v6)', function () {

        beforeEach(function () { arMod.ARCHIVE_REWARD_ACTIVATION.regtest = 0; });   // active at genesis

        // Independent reimplementation of the indexer's Anchor._rewardCanonical (FORMAT 6):
        // the hub's _archiveAttestationCanonical MUST be byte-identical to this.
        function archiveRewardCanonical(cp, batchSeq, publisher) {
            let base = ['XANCPUB', 'anchor_archive', String(batchSeq),
                        String(cp.snapshot_block), String(publisher).toLowerCase(),
                        arMod.ARCHIVE_REWARD_AMOUNT].join('|');
            if (eq.isEquivHeaderActive(cp.snapshot_block, cp.network)) {
                let roundId = 'XANCPUB|archive|' + cp.network + '|' + batchSeq + '|' + cp.snapshot_block;
                return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
            }
            return base;
        }

        it('_archiveAttestationCanonical is byte-identical to the indexer archive reward canonical (EQUIV-wrapped)', function () {
            let bus = buildMesh(1);
            let pub = bus.nodes[0].pub;
            let cp  = pub._cpFromRow(Object.assign({}, CP_ROW));
            let publisher = bus.nodes[0].pubkey;
            let expected = archiveRewardCanonical(cp, 0, publisher);
            // Sanity: the wrapped form is what the federation signs at/above the EQUIV
            // flag-day, with the 'archive' round-id family disjoint from every per-chain one.
            expect(expected).to.equal(
                'EQUIV|XCHECKPOINT|XANCPUB|archive|regtest|0|100|0||XANCPUB|anchor_archive|0|100|' +
                publisher + '|10.00000000');
            expect(pub._archiveAttestationCanonical(cp, 0, publisher)).to.equal(expected);
        });

        it('single-node: flush emits ANCHOR v6 with a self-attestation the indexer can verify', async function () {
            // Weighted: v6 only emits at/above the archive-reward flag-day (>= SWQ height),
            // so keep regtest (flag-day active here) and self-attest one equal-weight source.
            let bus = buildMesh(1, { stakeWeighted: true });
            let nd  = bus.nodes[0];
            await startAll(bus);
            await nd.pub.flush();
            await waitUntil(() => nd.published.some(p => p.split('|')[1] === '6'), { label: 'the single-node flush to emit a v6 archive anchor' });

            let v6 = nd.published.find(p => p.split('|')[1] === '6');
            expect(v6, 'a v6 archive anchor was published').to.be.a('string');
            let parts = v6.split('|');
            expect(parts[11], 'MATCH_BATCH_SEQ').to.equal('0');
            expect(parts[14], 'TOTAL_CHUNKS').to.equal('1');
            let sigCount = Number(parts[16]);                              // wrapper SIG_COUNT (v1 sigBase)
            let pubBase  = 17 + 2 * sigCount;
            expect(parts[pubBase], 'PUBLISHER').to.equal(nd.pubkey);
            expect(Number(parts[pubBase + 1]), 'ATTEST_SIG_COUNT').to.equal(1);
            let aPub = parts[pubBase + 2], aSig = parts[pubBase + 3];
            expect(aPub).to.equal(nd.pubkey);
            let cp = nd.pub._cpFromRow(nd.db.checkpoints[0]);
            expect(ValidatorIdentity.verify(archiveRewardCanonical(cp, 0, nd.pubkey), aSig, aPub)).to.be.true;

            // The wrapper signature still verifies over the UNCHANGED v1 archive canonical.
            let canonical = nd.pub._archiveCanonical(cp, 0, 1, parts[13], 1);
            expect(ValidatorIdentity.verify(canonical, parts[18], parts[17])).to.be.true;

            // The archive lands, rows back-fill, and the anchor_archive reward is recorded.
            expect(nd.db.matches[0].batch_seq).to.equal(0);
            expect(nd.rewards.filter(r => r.type === 'anchor_archive').length).to.equal(1);
        });

        it('N=4: the elected archive leader collects a 2f+1 archive attestation quorum and emits v6', async function () {
            // v6 requires the archive-reward flag-day active (>= SWQ height everywhere), so
            // the archive signing + attestation rounds run weighted; equal source-weights make
            // the 2/3-stake bar coincide with 2f+1 (3-of-4), keeping the assertions unchanged.
            let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true });
            await startAll(bus);
            for (let nd of bus.nodes) await nd.pub.flush();
            await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '6')), { label: 'the elected archive leader to emit a v6' });

            let leader = bus.nodes.find(nd => nd.published.some(p => p.split('|')[1] === '6'));
            expect(leader, 'an elected leader emitted a v6').to.exist;
            let parts = leader.published.find(p => p.split('|')[1] === '6').split('|');
            let sigCount = Number(parts[16]);
            let pubBase  = 17 + 2 * sigCount;
            expect(parts[pubBase], 'PUBLISHER is the leader').to.equal(leader.pubkey);
            let attestCount = Number(parts[pubBase + 1]);
            expect(attestCount, '2f+1 attestation quorum').to.be.at.least(3);

            let cp = leader.pub._cpFromRow(leader.db.checkpoints[0]);
            let canonical = archiveRewardCanonical(cp, Number(parts[11]), leader.pubkey);
            let setPubkeys = new Set(bus.nodes.map(n => n.pubkey));
            let signers = [];
            for (let i = 0; i < attestCount; i++) {
                let aPub = parts[pubBase + 2 + 2 * i], aSig = parts[pubBase + 2 + 2 * i + 1];
                expect(setPubkeys.has(aPub), 'attester in oracle_publish set').to.be.true;
                expect(ValidatorIdentity.verify(canonical, aSig, aPub)).to.be.true;
                signers.push(aPub);
            }
            expect(signers).to.include(leader.pubkey);
        });

        it('liveness fallback: a leader that cannot reach attestation quorum emits legacy v1 and withholds the reward', async function () {
            // Degraded federation: the elected archive leader is the ONLY started node
            // in a 4-member snapshot, so no peer co-signs the archive XANCPUB. The
            // bounded round times out, the leader FALLS BACK to a legacy v1 (the archive
            // must always land), and the anchor_archive reward is withheld: at/above the
            // flag-day no live indexer derives a reward from a v1, so recording one would
            // strand it in hub/archive bookkeeping and fork a recovered ledger.
            // Weighted (v6 needs the archive-reward flag-day, >= SWQ height): the archive
            // SIGNING round must still reach the stake-weighted quorum so a head publishes,
            // while the severed attestation round times out into the legacy v1 fallback.
            let bus = buildMesh(4, { btcBlock: 100, stakeWeighted: true, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
            await startAll(bus);
            // Sever ONLY the archive-attestation gossip: the archive SIGNING round must
            // still reach quorum (or no archive head publishes at all), but no attest
            // co-sign ever arrives, so the attestation round times out.
            for (let nd of bus.nodes) {
                let orig = nd.handler;
                nd.handler = (env) => { if (String(env.type).startsWith('XANCARCHPUB')) return; orig(env); };
            }
            for (let nd of bus.nodes) await nd.pub.flush();
            await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => ['1', '6'].includes(p.split('|')[1]))), { label: 'an archive head to be published' });

            let archiveHeads = bus.nodes.flatMap(nd => nd.published.filter(p => ['1', '6'].includes(p.split('|')[1])));
            expect(archiveHeads.length, 'an archive head was still published').to.be.at.least(1);
            expect(archiveHeads.every(p => p.split('|')[1] === '1'), 'fell back to legacy v1, no v6').to.be.true;
            let leader = bus.nodes.find(nd => nd.published.some(p => p.split('|')[1] === '1'));
            expect(leader.rewards.filter(r => r.type === 'anchor_archive').length,
                'no anchor_archive reward on a degraded legacy fallback').to.equal(0);
        });
    });

    it('v0 payload matches the ANCHOR spec field order', function () {
        let bus = buildMesh(1);
        let row = Object.assign({}, CP_ROW, { validator_signatures: '[{"pubkey":"pk1","sig":"sg1"}]' });
        let payload = bus.nodes[0].pub._buildV0Payload(row);
        expect(payload).to.equal(['ANCHOR', '0', 'BTC', 'regtest', '494', CP_ROW.block_hash,
            CP_ROW.ledger_hash, CP_ROW.actions_hash, CP_ROW.contract_hash, '7', '100', '1', 'pk1', 'sg1'].join('|'));
    });

    // Frozen wire-byte golden vectors: the PRODUCER half of the hub<->indexer ANCHOR
    // byte-identity contract. The v0 test above hand-asserts one shape; these pin the
    // full v0/v3/v4/v5 wire bytes against a vendored fixture that the indexer parser
    // asserts the OTHER half of (xchain-indexer test/unit/actions/anchor-golden-vectors.test.js,
    // same anchor_canonical_vectors.json). A field reorder in either repo breaks its own
    // side against the shared frozen string. Builders are invoked via the prototype with a
    // _parseSigs stub so this needs no mesh/DB. See protocol/test-vectors/anchor_canonical.json.
    describe('frozen ANCHOR canonical wire vectors (hub producer side)', function () {
        const GOLDEN = require('../fixtures/anchor_canonical_vectors.json');
        const stub = { _parseSigs: StateAnchorPublisher.prototype._parseSigs };
        // The builders read validator_signatures as a JSON string off the row.
        const row = Object.assign({}, GOLDEN.fixture.row, {
            validator_signatures: JSON.stringify(GOLDEN.fixture.row.validator_signatures),
        });
        const pub = GOLDEN.fixture.publisher;
        const att = GOLDEN.fixture.attest_sigs;

        it('v0 builder reproduces the frozen vector byte-for-byte', function () {
            expect(StateAnchorPublisher.prototype._buildV0Payload.call(stub, row)).to.equal(GOLDEN.vectors.v0);
        });
        it('v3 builder reproduces the frozen vector byte-for-byte', function () {
            expect(StateAnchorPublisher.prototype._buildV3Payload.call(stub, row)).to.equal(GOLDEN.vectors.v3);
        });
        it('v4 builder reproduces the frozen vector byte-for-byte', function () {
            expect(StateAnchorPublisher.prototype._buildV4Payload.call(stub, row, pub, att)).to.equal(GOLDEN.vectors.v4);
        });
        it('v5 builder reproduces the frozen vector byte-for-byte', function () {
            expect(StateAnchorPublisher.prototype._buildV5Payload.call(stub, row, pub, att)).to.equal(GOLDEN.vectors.v5);
        });
    });

    it('single-node: flush publishes v0 + v1, archive round-trips, batch back-filled', async function () {
        // Count-path archive mechanics: a mainnet record below the 961000 SWQ activation
        // takes the legacy count snapshot the getSnapshot stub serves (weighted has its own suite).
        let bus = buildMesh(1, { network: 'mainnet' });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.length >= 2, { label: 'the v0 checkpoint and v1 archive to both be broadcast' });

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

    it('archive v1 broadcast returning a null txid keeps rows pending and records no reward', async function () {
        // Mirrors the v0 null-txid guard for the archive path: a false/incomplete
        // broadcast success ({ txid: null }) must NOT dequeue the rows with their final
        // status (which would strand them in an unrecoverable hole) and must NOT credit
        // the anchor_archive reward for an anchor that never landed on-chain.
        let bus = buildMesh(1, { network: 'mainnet' });   // count-path archive mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        // v0 checkpoint still gets a txid; only the v1 archive broadcast returns none.
        nd.pub.setBroadcastHook(async (payload) => {
            nd.published.push(payload);
            let isArchiveV1 = payload.split('|')[1] === '1';
            return { txid: isArchiveV1 ? null : ('txid' + nd.published.length) };
        });
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.length >= 2, { label: 'the v0 checkpoint and the txid-less v1 archive to both be attempted' });

        expect(nd.published.length).to.equal(2);                       // v0 + v1 both attempted
        expect(nd.published[1].split('|')[1]).to.equal('1');           // the archive v1
        // Row stays eligible: archived_status is the __partial__ sentinel (!= status),
        // so the next flush re-archives it under a fresh batch seq instead of leaving a hole.
        expect(nd.db.matches[0].archived_status).to.equal('__partial__');
        expect(nd.db.matches[0].archived_status).to.not.equal(nd.db.matches[0].status);
        // No phantom reward for an archive that never reached the chain.
        expect(nd.rewards.filter(r => r.type === 'anchor_archive').length).to.equal(0);
    });

    it('ANCHOR_CHECKPOINT_EVERY_N anchors only the latest divisible seq; off-multiples stay off-chain', async function () {
        // Decouple on-chain anchoring from checkpoint production. With N=2 only
        // even seqs are eligible; the odd one is never anchored (it lives only in
        // the off-chain mirror). Seeds: seq6 already anchored, seq7 (odd, null),
        // seq8 (even, null) - the latest eligible unanchored is seq8.
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
        await waitUntil(() => nd.db.checkpoints.some(r => r.checkpoint_seq === 8 && r.anchor_txid), { label: 'the latest divisible seq to be anchored' });

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
        let bus = buildMesh(1, { network: 'mainnet', matches: many, cfg: { ANCHOR_CHUNK_MAX_BYTES: '500' } });   // count-path chunking mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published[1] && nd.published.length >= 1 + Number(nd.published[1].split('|')[14]), { label: 'every v1 + v2 archive chunk to be broadcast' });

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
        // Count-path: mainnet record below the 961000 SWQ activation, so the archive
        // quorum stays legacy 2f+1 (the weighted path has its own dedicated suite below).
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet' });
        await startAll(bus);
        let v0Pub  = v0Order(bus)[0];                                  // elected for the BTC checkpoint
        let leader = archiveLeader(bus);                          // elected archive leader
        await flushAll(bus);                                           // every hub's timer fires
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints[0].anchor_txid) && bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the v0 back-fill to reach every hub and the archive to publish' });

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

        // Rewards: EVERY hub records both rows - the earner at publish time, the
        // rest by mirroring the signature-verified V0_DONE / FINALIZED
        // announcements - credited to the publisher/leader with the quorum-agreed
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
        // flush() is fully awaited and every co-sign this round can collect is gathered
        // inside it, so the refusal is already decided here: there is no later condition
        // a poll could wait for, and the fixed settle it replaces only added dead time.
        await leader.pub.flush();
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
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet' });   // count-path (SWQ off below 961000)
        let leader = archiveLeader(bus);
        let pruned = 0;
        for (let nd of bus.nodes) {
            if (nd !== leader && pruned < 2) { nd.db.matches.length = 0; pruned++; }   // joined after m1
        }
        await startAll(bus);
        await leader.pub.flush();
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the archive to publish despite two late joiners' });

        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length, 'archive published despite two late joiners').to.equal(1);
        let v1 = v1s[0].split('|');
        expect(Number(v1[16]), 'sig count').to.be.at.least(3);                          // real quorum
    });

    // ── anchor-reward archive rail (F10) ────────────────────────────────────
    // Anchor-publish rewards are hub-pushed rows the indexer can never re-derive
    // from a chain parse - the archive is their recovery transport. Rows carry
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
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet', matches: [], rewards: [rewardRow(pk0)] });   // count-path
        let leader = archiveLeader(bus);
        await startAll(bus);
        await flushAll(bus);
        await waitUntil(() => bus.nodes.every(nd => nd.db.rewardRows[0].batch_seq === 0), { label: 'the archive batch_seq to back-fill on every hub' });

        // Rewards-only batches publish (the empty-check includes rewards) with a
        // real co-sign quorum - followers re-derived every archived field.
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
        // XANC_FINALIZED - the row leaves the pending set federation-wide.
        for (let nd of bus.nodes)
            expect(nd.db.rewardRows[0].batch_seq, 'node ' + nd.i).to.equal(0);
    });

    it('a reward whose source cannot be resolved is deferred, not archived as a hole', async function () {
        let bus = buildMesh(1, { network: 'mainnet', rewards: [rewardRow(pkOf(0))], sourceResolver: () => null });   // count-path (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the v1 archive to be broadcast' });

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
        // Nothing to poll on the negative claim, so gate it on the round it belongs to:
        // the v0 checkpoint anchor still goes out, and the archive must not follow it.
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '0'), { label: 'the v0 checkpoint anchor to be broadcast' });

        expect(nd.published.find(p => p.split('|')[1] === '1'), 'no v1 archive published').to.equal(undefined);
        expect(nd.db.rewardRows[0].batch_seq, 'reward stays pending').to.equal(null);
    });

    it('follower re-derivation rejects forged reward type / pubkey / amount / source / conflicting local row', async function () {
        let pk0 = pkOf(0), pk1 = pkOf(1);
        let bus = buildMesh(2, { matches: [], rewards: [rewardRow(pk0)] });
        // Since #4185 the verifier also REQUIRES the snapshot groups _buildArchive was
        // obliged to emit, so the fixture carries the oracle_publish group at the
        // reward's earn block instead of an empty list. The reward re-derivation
        // assertions below are unchanged.
        let verify = async (ar) => {
            let pub   = bus.nodes[1].pub;
            let set   = await pub._resolveCapabilitySet('oracle_publish', Number(ar.block_index), pub.network);
            let snaps = set.map(v => ({ snapshot_block: Number(ar.block_index), capability: 'oracle_publish',
                                        signing_pubkey: v.pubkey, amount: v.amount, source: v.source }));
            return pub._verifyArchiveAgainstLocal(
                { matches: [], calls: [], rewards: [ar], capability_snapshots: snaps });
        };
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
        // A held (type, round) row must agree - a leader crediting itself for
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
        // to the same finalized row (hub1=60, hub2=36, hub3=34 for one call) -
        // byte-comparing ids made every multi-hub archive unverifiable.
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet' });   // count-path (SWQ off below 961000)
        let leader = archiveLeader(bus);
        for (let nd of bus.nodes) {
            if (nd !== leader) nd.db.matches[0].id = 1000 + nd.i;          // divergent local cursors
        }
        await startAll(bus);
        await leader.pub.flush();
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the archive to publish despite divergent local ids' });
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
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '0').length).to.equal(0);

        await order[1].pub.flush();                                    // rank 1: unlocked (rank 0 absent)
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '0')), { label: 'the unlocked rank-1 publisher to emit the v0 anchor' });
        let v0s = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '0'));
        expect(v0s.length).to.equal(1);
        expect(v0s[0]).to.equal(order[1]);
        // Back-fill reached rank 0 too - it won't double-publish when it returns.
        await order[0].pub.flush();
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '0').length).to.equal(1);
    });

    it('archive failover ladder: a non-leader publishes once its rank unlocks, with full co-sign quorum', async function () {
        // Live finding (3-hub test cluster): the archive election had NO rank
        // tolerance - a signer-less elected leader stalled archiving (only
        // 1-of-3 elections could publish), and on a static regtest tip the
        // same leader won forever. The election key is now content-anchored
        // (wrapper checkpoint + batch seq) and ranks unlock like v0 anchors:
        // since = btcBlock - wrapper snapshot_block = 37 → floor(37/36) = 1.
        let bus = buildMesh(4, { btcBlock: 137, network: 'mainnet' });   // count-path (SWQ off below 961000)
        await startAll(bus);
        let order = archiveOrder(bus);

        await order[2].pub.flush();                                    // rank 2: still locked
        await order[3].pub.flush();                                    // rank 3: still locked
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '1').length).to.equal(0);

        await order[1].pub.flush();                                    // rank 1: unlocked (rank-0 hub signer-less)
        await waitUntil(() => order[1].published.some(p => p.split('|')[1] === '1') && bus.nodes.every(nd => nd.db.matches[0].batch_seq === 0), { label: 'the rank-1 archive to publish and back-fill every hub' });
        let v1Nodes = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(v1Nodes.length).to.equal(1);
        expect(v1Nodes[0]).to.equal(order[1]);
        // Followers co-signed the rank-1 publisher - a real quorum, not a self-sign.
        let v1 = order[1].published.find(p => p.split('|')[1] === '1').split('|');
        expect(Number(v1[16])).to.be.at.least(3);
        // Back-fill reached every node - the stalled rank-0 won't re-archive on return.
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
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints.every(c => c.anchor_txid)), { label: 'every per-chain checkpoint to be anchored on every hub' });

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
        expect(outsider.published.length).to.equal(0);
        expect(outsider.rewards.length).to.equal(0);
    });

    // ── fail closed when the oracle_publish set is empty / unresolved ────────────
    // An empty eligible set (empty validator snapshot, or an indexer that resolves
    // to no oracle_publish members) must DEFER publication, not bypass the election
    // gate. The pre-fix bug skipped the gate on an empty set, so every hub anchored
    // the same checkpoint from its own DOGE wallet - a guaranteed N-way double-
    // anchor + fee burn. Both call sites (v0 anchor + v1/v2 archive) fail closed.
    it('an empty oracle_publish set defers publication (no v0 anchor, no v1 archive, no reward)', async function () {
        let bus = buildMesh(3, { btcBlock: 200 });
        let empty = { async getSnapshot() { return { validators: [] }; } };
        for (let nd of bus.nodes) { nd.pub.capSnapshot = empty; nd.pub.hub.capabilitySnapshot = empty; }
        await startAll(bus);
        let summaries = [];
        for (let nd of bus.nodes) summaries.push(await nd.pub.flush());
        // Nothing went out from ANY hub, and no anchor reward was minted.
        for (let nd of bus.nodes) {
            expect(nd.published.length, 'node ' + nd.i + ' published nothing').to.equal(0);
            expect(nd.rewards.length, 'node ' + nd.i + ' minted no reward').to.equal(0);
        }
        for (let s of summaries) {
            expect(s.anchored.length, 'no checkpoints anchored').to.equal(0);
            expect(s.archive, 'archive round deferred').to.equal('none');
        }
        // The pending checkpoint is still unanchored on every hub (deferred, not lost).
        for (let nd of bus.nodes) expect(nd.db.checkpoints[0].anchor_txid).to.equal(null);
    });

    it('_mayPublish fails closed on an empty election order', function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        expect(nd.pub._mayPublish([], 0)).to.equal(false);
        expect(nd.pub._mayPublish([], 1000)).to.equal(false);
        // Sanity: a real single-member order in which this hub is rank 0 still may.
        expect(nd.pub._mayPublish([nd.pubkey], 0)).to.equal(true);
    });

    // ── signing set is resolved at snapshot_block, not the election block ────────
    // The published v1 declares the wrapper checkpoint's snapshot_block on the
    // wire, and the indexer + full-parse recovery verify the wrapper signatures
    // against oracle_publish AT snapshot_block. The leader is elected by the
    // current BTC block for liveness, but the SIGNING/QUORUM set must track
    // snapshot_block - otherwise, when oracle_publish membership drifts inside the
    // tolerance window, a signer present only in the election set contributes a
    // signature the indexer drops, the v1 stores `invalid`, and the rows (already
    // dequeued) become permanently unrecoverable.
    it('archive is signed by the snapshot_block set even when the election-block set has drifted', async function () {
        // Wrapper checkpoint snapshot_block = 100 (CP_ROW); current BTC tip = 110
        // (a 10-block drift, well inside the 36-block tolerance window). Between
        // the two blocks oracle_publish membership changed: C left, D joined.
        let bus = buildMesh(4, { btcBlock: 110, network: 'mainnet' });   // count-path (SWQ off below 961000)
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
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the archive to publish under the snapshot-block signer set' });

        // Exactly one v1, and every signature on it belongs to the snapshot_block
        // set - so the indexer, verifying against oracle_publish @ snapshot_block,
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
        // signature collected (1 valid) - the indexer would reject it as invalid.
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
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the v1 archive broadcast' });

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
        // Weighted-path: this test asserts the anchored summary carries network 'regtest'
        // (below), so the record must stay regtest, which activates SWQ at block 0. One
        // equal-weight source clears the 2/3 bar trivially, so the summary is unchanged.
        let bus = buildMesh(1, { stakeWeighted: true });
        let nd = bus.nodes[0];
        await startAll(bus);
        let first = await nd.pub.flush();
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
        // were lost while the batch was already back-filled as archived - an
        // unrecoverable archive (recovery refuses incomplete batches). A partial
        // publish must keep the rows pending and the retry must use a NEW seq
        // (two v1 anchors sharing one seq corrupt chunk reassembly).
        let bus = buildMesh(1, { network: 'mainnet',   // count-path re-archive mechanics (SWQ off below 961000)
                                 cfg: { ANCHOR_CHUNK_MAX_BYTES: '600', ANCHOR_CHUNK_RETRY_MS: '1' },
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
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the v1 archive head to be broadcast' });

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
        await waitUntil(() => nd.published.filter(p => p.split('|')[1] === '1').length === 2, { label: 'the retry flush to re-archive under a second v1' });
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
        await waitUntil(() => nd.db.checkpoints[0].anchor_txid === 'txid1', { label: 'the retried v0 broadcast to stamp the checkpoint' });

        // Two conflicts absorbed by the retry - the checkpoint still anchors this flush.
        expect(v0Failures).to.equal(2);
        expect(nd.db.checkpoints[0].anchor_txid).to.equal('txid1');

        // Exhausted retries (5 straight conflicts) leave the row pending for the next flush.
        nd.db.checkpoints.push(Object.assign({}, CP_ROW, { id: 2, chain: 'DOGE', anchor_txid: null }));
        failuresLeft = 99;
        await nd.pub.flush();
        expect(nd.db.checkpoints[1].anchor_txid).to.equal(null);

        failuresLeft = 0;
        await nd.pub.flush();
        await waitUntil(() => typeof nd.db.checkpoints[1].anchor_txid === 'string', { label: 'the conflict-free flush to anchor the deferred row' });
        expect(nd.db.checkpoints[1].anchor_txid).to.be.a('string');
    });

    it('a match retracted after archival is re-archived with its new status', async function () {
        let bus = buildMesh(1, { network: 'mainnet' });   // count-path re-archive mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.db.matches[0].batch_seq === 0, { label: 'the first archive to claim the match row' });
        expect(nd.db.matches[0].batch_seq).to.equal(0);

        // Reorg retraction after archival → pending again under the re-archival rule.
        nd.db.matches[0].status = 'retracted';
        nd.db.checkpoints[0].anchor_txid = 'already';                  // no new v0 this flush
        await nd.pub.flush();
        await waitUntil(() => nd.published.filter(p => p.split('|')[1] === '1').length === 2, { label: 'the retracted match to be re-archived under a second v1' });

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
        let bus = buildMesh(1, { network: 'mainnet', calls: [callRow('c'.repeat(64), 'dispatch'), callRow('c'.repeat(64), 'result')] });   // count-path XCALL archive mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the XCALL-bearing archive to be broadcast' });

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
        // Same shape as the diverging-match round above: the awaited flush settles the
        // refusal, so nothing remains to poll for.
        await leader.pub.flush();
        for (let nd of bus.nodes) expect(nd.db.calls[0].batch_seq).to.equal(null);
    });

    // ── STAKE_WEIGHTED_QUORUM (WI-1, finding #4120): the publisher's archive
    //    quorum + on-chain VALIDITY gate must apply the SAME stake-weighted rule
    //    the indexer (anchor.js) and full-parse recovery verify against. Pre-fix it
    //    was count-only, so a count-met-but-stake-short batch was published+dequeued
    //    while every indexer rejected it - stranding settled state in an
    //    unrecoverable hole. (The mesh tests above run with hub.network undefined →
    //    legacy count; here we drive network='regtest', activation=0 → weighted.)
    describe('stake-weighted archive quorum', function () {
        const CANON = 'XANC|test|canonical';
        function weightedPub() {
            return new StateAnchorPublisher({
                db: { async doQuery() { return []; } },
                network: 'regtest',                                   // activation = 0 → weighted on
                getPeerManager: () => ({ on() {}, removeListener() {}, broadcast() {} }),
                getIdentity: () => null,
                p2pConfig: {}
            });
        }
        // 4 validators, concentrated stake 70/10/10/10 over distinct sources.
        function stakeSet() {
            let ids = ['70', '11', '12', '13'].map(s => new ValidatorIdentity(s.repeat(32).slice(0, 64)));
            let weights = ['70', '10', '10', '10'];
            let set = ids.map((id, i) => ({ pubkey: id.getPubkeyHex().toLowerCase(), source: 'src' + i, weight: weights[i] }));
            return { ids, set };
        }
        const sigsFrom = (ids) => ids.map(id => ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(CANON) }));

        it('_quorumVerified: the three 10% holders meet 2f+1 COUNT but NOT 2/3 STAKE', function () {
            let pub = weightedPub();
            let { ids, set } = stakeSet();
            let minority = sigsFrom(ids.slice(1));                    // 3×10% = 30 of 100
            // Count regime would ACCEPT (3 of 4 ≥ 2f+1) - exactly the pre-fix producer bug.
            expect(pub._quorumVerified(CANON, minority, set, false)).to.equal(true);
            // Stake regime REJECTS (3·30 = 90 ≤ 2·100 = 200) - matches the indexer/recovery verdict.
            expect(pub._quorumVerified(CANON, minority, set, true)).to.equal(false);
        });

        it('_quorumVerified: adding the 70% holder clears the stake threshold', function () {
            let pub = weightedPub();
            let { ids, set } = stakeSet();
            let majority = sigsFrom([ids[0], ids[1]]);               // 70 + 10 = 80 of 100
            expect(pub._quorumVerified(CANON, majority, set, true)).to.equal(true);    // 3·80 = 240 > 200
        });

        it('_quorumVerified: a TRUNCATED weighted set fails CLOSED regardless of stake (XHUB-TRUNC-2)', function () {
            // An over-cap snapshot under-counts S; a stake-evicted minority could otherwise
            // authenticate a fabricated archived match/call. Mirrors the DEX/Call consensus
            // refuse and meetsStakeThreshold's own fail-closed.
            let pub = weightedPub();
            let { ids, set } = stakeSet();
            set.truncated = true;                                    // resolved set overflowed VALIDATOR_QUERY_LIMIT
            let all = sigsFrom(ids);                                 // 100% of stake WOULD clear the 2/3 bar
            expect(pub._quorumVerified(CANON, all, set, true)).to.equal(false);   // ...but truncated -> fail closed
            // COUNT path is proceed-on-truncation (deterministic cap; matches getQuorum).
            let three = sigsFrom(ids.slice(1));                      // 3 of 4 >= 2f+1
            expect(pub._quorumVerified(CANON, three, set, false)).to.equal(true);
        });

        it('_quorumVerified: duplicate pubkey with garbage sig FIRST still counts the later valid sig', function () {
            // seen-before-verify was an order-dependent under-count: the garbage
            // entry consumed the pubkey's seen slot and the real signature was
            // skipped, diverging from the indexer recovery twin (verify-first).
            let pub = weightedPub();
            let { ids, set } = stakeSet();
            let valid = sigsFrom([ids[0], ids[1]]);                  // 70 + 10 = 80 of 100, clears stake bar
            let poisoned = [{ pubkey: ids[0].getPubkeyHex().toLowerCase(), sig: '00'.repeat(64) }, ...valid];
            expect(pub._quorumVerified(CANON, poisoned, set, true)).to.equal(true);
        });

        it('_quorumVerified: a pubkey with ONLY invalid sigs is not counted and blocks nothing', function () {
            let pub = weightedPub();
            let { ids, set } = stakeSet();
            let garbageOnly = [{ pubkey: ids[0].getPubkeyHex().toLowerCase(), sig: '00'.repeat(64) },
                               ...sigsFrom(ids.slice(1))];           // 3×10% real = stake-short
            expect(pub._quorumVerified(CANON, garbageOnly, set, true)).to.equal(false);
        });

        it('_checkArchiveQuorum: a count-met-but-stake-short round does NOT publish/dequeue', async function () {
            let pub = weightedPub();
            let { ids, set } = stakeSet();
            let published = false;
            pub._publishArchive = async () => { published = true; };  // observe the dequeue decision
            pub._archiveRound = {
                done: false, weighted: true, quorum: 3, validators: set,
                signatures: new Map(sigsFrom(ids.slice(1)).map(s => [s.pubkey, s.sig])),   // 3×10%
                timer: null
            };
            await pub._checkArchiveQuorum();
            expect(published, 'sub-stake archive must not publish').to.equal(false);
            expect(pub._archiveRound, 'round stays open for more sigs').to.not.equal(null);

            // The SAME 3 sigs WOULD fire under legacy count - proving the regime, not
            // the signature count, is what now gates the dequeue.
            pub._archiveRound.weighted = false;
            await pub._checkArchiveQuorum();
            expect(published, 'count regime fires on 3 ≥ quorum').to.equal(true);
        });
    });

    it('ANCHOR_ENABLED=false: start() is a no-op (no message handler wired)', async function () {
        let bus = buildMesh(1, { cfg: { ANCHOR_ENABLED: 'false' } });
        let nd = bus.nodes[0];
        await nd.pub.start();
        expect(nd.pub._messageHandler, 'message handler stays null when disabled').to.be.null;
        expect(nd.handler, 'peerManager.on(message) not wired when disabled').to.be.null;
    });

    it('flush() guards re-entry: a second flush while one is in flight is skipped', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub._flushing = true;                                   // an in-flight flush holds the latch
        let res = await nd.pub.flush();
        expect(res.skipped).to.equal('already_flushing');
        expect(nd.published.length, 'nothing published by the re-entrant call').to.equal(0);
    });

    it('flush() skips with no_pipeline when no broadcast pipeline is configured', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub.setBroadcastHook(null);                             // drop the only signer path
        let res = await nd.pub.flush();
        expect(res.skipped).to.equal('no_pipeline');
        expect(nd.published.length).to.equal(0);
    });

    it('low DOGE balance emits a LOW-balance warning during flush', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub.setBalanceHook(async () => 0.5);                    // below the default 10 DOGE threshold
        let warned = [];
        let orig = console.warn;
        console.warn = (...a) => warned.push(a.join(' '));
        try { await nd.pub.flush(); } finally { console.warn = orig; }
        expect(warned.some(w => /balance LOW/i.test(w)), 'a LOW-balance warning fired').to.be.true;
    });

    it('a __partial__ archive does NOT mirror the anchor_archive reward (a complete one does)', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];          // signature-verified sender; both are oracle_publish validators
        let txid = 'dogetx_partialtest', snap = 100;
        bus.anchorVersions.set(txid, 1);      // the announced head really is a v1 archive on-chain (#4180 gate)

        // This test drives _handleFinalized directly (bypassing the SIGN_REQ round
        // that normally binds the elected leader), so seed the observed-leader
        // binding AND the batch's checkpoint identity the same way _handleSignReq
        // would after validating the election. The checkpoint (CP_ROW, in the mesh
        // DB) then verifies on-chain via the harness getanchoraction oracle, so the
        // COMPLETE control reaches the reward mirror.
        follower.pub._recordObservedArchiveLeader(0, leader.pubkey, CP_ROW);
        follower.pub._recordObservedArchiveLeader(1, leader.pubkey, CP_ROW);

        // (1) PARTIAL: a match carries the __partial__ sentinel → the follower must NOT mirror the reward.
        let pMatches = [matchRow('mp', '__partial__')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 0, txid: txid, snapshot_block: snap, matches: pMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(0, txid, pMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'no archive reward on a __partial__ publish').to.be.false;

        // (2) CONTROL - a COMPLETE archive (no sentinel) DOES mirror the reward. Also proves the
        // envelope is well-formed enough to reach the reward gate (guards against a false pass
        // where _backfillBatch silently failed for both cases).
        let cMatches = [matchRow('mc', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 1, txid: txid, snapshot_block: snap, matches: cMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(1, txid, cMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'a complete publish DOES mirror the reward').to.be.true;
    });

    it('a forged XANC_FINALIZED from an un-observed member is rejected: no back-fill, no reward', async function () {
        // XANC-FINALIZED-STRAND-1 + XANC-REWARD-THEFT-1 (archive half): membership +
        // signature alone let ANY oracle_publish member forge a FINALIZED. Without the
        // observed-leader gate the forge would (a) mark m1 archived under a bogus
        // batch_seq (stranding it from full-parse recovery) and (b) mirror the
        // anchor_archive reward crediting the attacker (minting COLLECT XCHAIN, since
        // the archive reward push is NOT retired by the anchor-reward flag-day).
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let attacker = bus.nodes[1];        // a real oracle_publish member, but no observed archive election for seq 7
        let txid = 'dogetx_forged', snap = 100;
        bus.anchorVersions.set(txid, 1);      // a real v1 archive head, so ONLY the observed-leader gate decides
        let fMatches = [matchRow('m1', 'finalized')];
        let env = () => ({ data: {
            batch_seq: 7, txid: txid, snapshot_block: snap, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: attacker.pubkey, sig: attacker.identity.sign(follower.pub._finalizedCanonical(7, txid, fMatches.length))
        }});

        await follower.pub._handleFinalized(env());
        let m1 = follower.db.matches.find(m => m.match_id === 'm1');
        expect(m1.archived_status, 'row NOT archived by the forge').to.not.equal('finalized');
        expect(m1.batch_seq, 'no bogus batch_seq stamped').to.equal(null);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'), 'no forged archive reward').to.equal(false);

        // The SAME envelope IS honored once the follower has observed that member's
        // election (with the batch's checkpoint identity) for the batch, proving the
        // gate (not a malformed envelope) rejected it.
        follower.pub._recordObservedArchiveLeader(7, attacker.pubkey, CP_ROW);
        await follower.pub._handleFinalized(env());
        expect(follower.db.matches.find(m => m.match_id === 'm1').archived_status,
            'observed leader IS honored').to.equal('finalized');
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'observed leader mirrors the reward').to.equal(true);
    });

    it('a FINALIZED for a batch whose checkpoint was NEVER anchored on-chain mirrors NO archive reward', async function () {
        // XANC-REWARD-THEFT-1 (archive half, LIVE): an elected-yet-Byzantine leader
        // that announces a FINALIZED for an archive it never published on DOGE must
        // earn nothing. The back-fill (local bookkeeping) still applies; only the
        // COLLECT-spendable anchor_archive reward mirror is gated on the batch's
        // checkpoint being on-chain at depth.
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub._recordObservedArchiveLeader(9, leader.pubkey, CP_ROW);        // observed + checkpoint identity stashed
        follower.pub._indexerCall = async () => ({ exists: false, confirmations: 0 });  // the checkpoint was never anchored
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 9, txid: 'dogetx_phantom', snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(9, 'dogetx_phantom', fMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'phantom archive earns no COLLECT-spendable reward').to.equal(false);
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq,
            'back-fill still applies (rows re-archive on a fresh seq if the checkpoint later confirms)').to.equal(9);
    });

    it('archive mirror gates on the CHECKPOINT network, not this.network, so an unscoped hub retires the push at/above the flag-day (#2359)', async function () {
        // Archive leg: on an unscoped hub (this.network===''),
        // ARCHIVE_REWARD_ACTIVATION[''] is undefined so isArchiveRewardActive('') is
        // false and the OLD code failed to retire the mirror even for a checkpoint
        // whose OWN network is at/above the archive flag-day, push-mirroring a reward
        // the indexer independently derives from v6 (a COLLECT-spendable double-credit).
        // The fix reads the checkpoint's network from the stashed identity, so the
        // mirror correctly retires. Here the checkpoint is regtest AT the flag-day
        // while the hub is unscoped.
        arMod.ARCHIVE_REWARD_ACTIVATION.regtest = 0;             // regtest checkpoint IS at/above its archive flag-day
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        expect(follower.pub.network).to.equal('');              // unscoped hub: the drift precondition
        bus.anchorVersions.set('dogetx_scoped', 1);             // real v1 head, so the flag-day gate is what decides
        // Observe the leader AND stash the batch's checkpoint identity (regtest), the
        // same way _handleSignReq would. The checkpoint verifies on-chain via the
        // default honest oracle, so the ONLY thing keeping the mirror from firing is
        // the corrected flag-day gate reading the checkpoint's network.
        follower.pub._recordObservedArchiveLeader(3, leader.pubkey, CP_ROW);
        let cMatches = [matchRow('m1', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 3, txid: 'dogetx_scoped', snapshot_block: 100, matches: cMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(3, 'dogetx_scoped', cMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'unscoped hub retires the mirror for a checkpoint at/above its OWN archive flag-day').to.equal(false);
    });

    // ── XANC-ELECTED-FORGE-1 (archive half): bind the v1 archive txid ────────────
    // Proving the CHECKPOINT is anchored is not enough: an elected leader could
    // reference a real-but-different anchored checkpoint and still mirror itself the
    // anchor_archive reward, which is LIVE (not retired by the anchor-reward flag-day).

    it('a FINALIZED binds the announced archive txid and v1 version to the indexer lookup', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub._recordObservedArchiveLeader(11, leader.pubkey, CP_ROW);
        let seen = null;
        follower.pub._indexerCall = async (coin, method, params) => {
            seen = params;
            return { exists: true, checkpoint_anchored: true, status: 'valid', version: Number(params.version),
                     confirmations: follower.pub.dogeConfirmations, txid: params.txid,
                     block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
                     actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash };
        };
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 11, txid: 'ab'.repeat(32), snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(11, 'ab'.repeat(32), fMatches.length))
        }});
        expect(seen.txid, 'archive gate binds the announced v1 head txid').to.equal('ab'.repeat(32));
        expect(seen.version, 'archive gate binds ANCHOR v1').to.equal(1);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'a verified archive anchor mirrors the reward').to.equal(true);
    });

    it('a FINALIZED naming a txid that is NOT the on-chain archive earns no reward', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub._recordObservedArchiveLeader(12, leader.pubkey, CP_ROW);
        // The checkpoint IS anchored, but no v1 archive with the announced txid exists:
        // the elected leader is referencing someone else's anchor.
        follower.pub._indexerCall = async () => ({ exists: false, checkpoint_anchored: true, confirmations: 0 });
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 12, txid: 'ff'.repeat(32), snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(12, 'ff'.repeat(32), fMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'referencing a different anchor earns nothing').to.equal(false);
    });

    it('a FINALIZED whose announced status diverges from the local row is rejected (unsigned content)', async function () {
        // XANC-FINALIZED-CONTENT-1: the XANCFIN canonical binds only (batch_seq,
        // txid, match COUNT), so a Byzantine ELECTED leader could announce
        // attacker-chosen id/status lists. The receiver must re-verify announced
        // content against its own rows before stamping.
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub._recordObservedArchiveLeader(4, leader.pubkey);   // leader IS observed for the batch

        // Announce m1 with a status that diverges from the follower's row
        // ('finalized'): stamping it would mark the row archived under a bogus
        // terminal status and strand it from every future archive round.
        let fMatches = [matchRow('m1', 'attacker_status')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 4, txid: 'dogetx_content', snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(4, 'dogetx_content', fMatches.length))
        }});
        let m1 = follower.db.matches.find(m => m.match_id === 'm1');
        expect(m1.batch_seq, 'no batch_seq stamped from diverging content').to.equal(null);
        expect(m1.archived_status, 'no archived_status stamped').to.equal(null);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'), 'no reward mirrored').to.equal(false);

        // Control: the TRUE status (and the __partial__ sentinel) both pass, so
        // the rejection above came from the content check, not a malformed envelope.
        let okMatches = [matchRow('m1', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 4, txid: 'dogetx_content', snapshot_block: 100, matches: okMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(4, 'dogetx_content', okMatches.length))
        }});
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq,
            'matching content IS stamped').to.equal(4);
    });

    it('a FINALIZED with a non-anchor reward_type in the reward list is rejected', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub._recordObservedArchiveLeader(5, leader.pubkey);
        follower.db.rewardRows.push({ reward_type: 'oracle_round', round_number: 1,
                                      validator_pubkey: leader.pubkey, batch_seq: null, block_index: 100 });
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 5, txid: 'dogetx_rw', snapshot_block: 100, matches: fMatches, calls: [],
            rewards: [{ reward_type: 'oracle_round', round_number: 1, validator_pubkey: leader.pubkey }],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(5, 'dogetx_rw', fMatches.length))
        }});
        expect(follower.db.rewardRows[0].batch_seq, 'indexer-derived reward row NOT stamped').to.equal(null);
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq, 'whole message rejected').to.equal(null);
    });

    it('the archive-reward mirror rejects a snapshot_block where the sender holds no oracle_publish', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub._recordObservedArchiveLeader(6, leader.pubkey);
        // d.snapshot_block is unsigned: resolve an EMPTY oracle_publish set at the
        // announced block (membership everywhere else stays intact).
        let orig = follower.pub._getActiveOraclePublishPubkeys.bind(follower.pub);
        follower.pub._getActiveOraclePublishPubkeys = async (blk) => (blk === 999999 ? [] : orig(blk));
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub._handleFinalized({ data: {
            batch_seq: 6, txid: 'dogetx_snap', snapshot_block: 999999, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub._finalizedCanonical(6, 'dogetx_snap', fMatches.length))
        }});
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq,
            'back-fill itself still applies').to.equal(6);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'no reward mirrored for an unresolvable snapshot_block').to.equal(false);
    });

    it('_backfillBatch cannot re-stamp a fully archived row, but a __partial__ row re-stamps', async function () {
        // Guard = the pending selectors' archive-eligibility predicate: a settled
        // row (batch_seq set AND archived_status = status) is immutable to a
        // replayed/forged FINALIZED; a __partial__ sentinel row must still take
        // its fresh seq on the legitimate re-archive.
        let archived = Object.assign(matchRow('ma', 'finalized'), { batch_seq: 0, archived_status: 'finalized', anchor_txid: 'dogetx_orig' });
        let partial  = Object.assign(matchRow('mp', 'finalized'), { batch_seq: 0, archived_status: '__partial__' });
        let bus = buildMesh(1, { matches: [archived, partial],
                                 rewards: [{ reward_type: 'anchor_DOGE', round_number: 3,
                                             validator_pubkey: 'aa'.repeat(32), batch_seq: 2, block_index: 100 }] });
        let nd = bus.nodes[0];

        await nd.pub._backfillBatch(9,
            [{ match_id: 'ma', status: 'finalized' }, { match_id: 'mp', status: 'finalized' }],
            'dogetx_replay', [],
            [{ reward_type: 'anchor_DOGE', round_number: 3, validator_pubkey: 'aa'.repeat(32) }]);

        let ma = nd.db.matches.find(m => m.match_id === 'ma');
        expect(ma.batch_seq, 'settled row keeps its original batch').to.equal(0);
        expect(ma.anchor_txid, 'settled row keeps its original txid').to.equal('dogetx_orig');
        expect(nd.db.matches.find(m => m.match_id === 'mp').batch_seq, '__partial__ row re-stamps').to.equal(9);
        expect(nd.db.rewardRows[0].batch_seq, 'already-archived reward row keeps its batch').to.equal(2);
    });

    it('_handleSignReq binds the elected archive leader locally (the FINALIZED gate source)', async function () {
        let bus = buildMesh(3);
        let batchSeq = 0;
        let leader   = archiveLeader(bus, batchSeq);
        let follower = bus.nodes.find(nd => nd !== leader);
        let cp = Object.assign({}, CP_ROW);
        // A SIGN_REQ that passes the election/rank check (valid sender + election_block)
        // but carries no usable archive (empty archive_b64) still binds the leader,
        // because the bind happens before the co-sign eligibility + archive checks.
        let canonical = follower.pub._archiveCanonical(cp, batchSeq, 1, 'deadbeef', 1);
        await follower.pub._handleSignReq({ data: {
            checkpoint: cp, election_block: 100, batch_seq: batchSeq,
            match_count: 1, batch_crc32: 'deadbeef', total_chunks: 1, archive_b64: '',
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(canonical)
        }});
        expect(follower.pub._isObservedArchiveLeader(batchSeq, leader.pubkey),
            'follower bound the elected leader for the batch').to.equal(true);
        let notLeader = bus.nodes.find(nd => nd !== leader && nd !== follower);
        expect(follower.pub._isObservedArchiveLeader(batchSeq, notLeader.pubkey),
            'a non-elected member is not bound').to.equal(false);
    });

    it('_backfillBatch re-broadcasts stamped match rows on the hub-DB mirror feed', async function () {
        let bus = buildMesh(1, { matches: [matchRow('m1'), matchRow('m2', 'retracted')] });
        let nd = bus.nodes[0];
        let broadcast = [];
        nd.pub.hub.hubDbBroadcaster = { broadcastRow: (ev) => broadcast.push(ev) };

        await nd.pub._backfillBatch(0,
            [{ match_id: 'm1', status: 'finalized' }, { match_id: 'm2', status: 'retracted' }],
            'dogetx_rebroadcast', [], []);

        // Only the non-retracted row re-emits (the stream already deleted retracted
        // rows on mirrors; re-inserting one would diverge them), and it carries the
        // freshly stamped anchor_txid plus the full signed content.
        expect(broadcast.length, 'exactly one re-broadcast').to.equal(1);
        expect(broadcast[0].table).to.equal('cross_chain_matches');
        expect(broadcast[0].row.match_id).to.equal('m1');
        expect(broadcast[0].row.anchor_txid).to.equal('dogetx_rebroadcast');
        expect(broadcast[0].row.a_amount, 'full row, not a partial patch').to.equal('1000');
    });

    it('_backfillBatch does NOT re-broadcast on a null txid or without a broadcaster', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let broadcast = [];
        nd.pub.hub.hubDbBroadcaster = { broadcastRow: (ev) => broadcast.push(ev) };

        // Null txid = the archive never landed on-chain (rows stay pending); there is
        // no stamp to propagate, so the feed stays quiet.
        await nd.pub._backfillBatch(0, [{ match_id: 'm1', status: '__partial__' }], null, [], []);
        expect(broadcast.length, 'no re-broadcast for a null txid').to.equal(0);

        // No broadcaster wired (standalone hub before start()): the back-fill itself
        // must still complete without throwing.
        delete nd.pub.hub.hubDbBroadcaster;
        await nd.pub._backfillBatch(1, [{ match_id: 'm1', status: 'finalized' }], 'dogetx_x', [], []);
        expect(nd.db.matches.find(m => m.match_id === 'm1').anchor_txid, 'back-fill still applied').to.equal('dogetx_x');
    });

    it('_handleSignReq bails on a stale tip (election_block far from our BTC view) before any election work', async function () {
        let bus = buildMesh(2, { btcBlock: 1000 });    // follower's BTC tip = 1000
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        let tol = follower.pub.electionToleranceBlocks;            // default 36

        // Spy on the first post-guard step: reached only if the stale-tip guard passes.
        let lookups = [];
        follower.pub._getActiveOraclePublishPubkeys = async (blk) => { lookups.push(blk); return []; };

        let mkReq = (electionBlock) => ({ data: {
            checkpoint: Object.assign({}, CP_ROW), election_block: electionBlock, batch_seq: 0,
            match_count: 1, batch_crc32: '0', total_chunks: 1, sig_pubkey: leader.pubkey, sig: 'deadbeef'
        }});

        // election_block well outside tolerance → bail at the stale-tip guard, no election lookup.
        await follower.pub._handleSignReq(mkReq(1000 + tol + 50));
        expect(lookups.length, 'no election lookup when the tip is stale').to.equal(0);

        // election_block within tolerance → proceeds past the guard into the election lookup
        // (which returns [] here, so the rest of the handler short-circuits harmlessly).
        await follower.pub._handleSignReq(mkReq(1000 + Math.floor(tol / 2)));
        expect(lookups.length, 'election lookup runs once the tip is within tolerance').to.be.greaterThan(0);
    });

    it('_resolveCapabilitySet uses the WEIGHTED snapshot (weight→amount, source kept) once SWQ is active', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let weighted = false, plain = false;
        nd.pub.capSnapshot = {
            getWeightSnapshot: async () => { weighted = true; return { validators: [{ pubkey: 'PKA', weight: '7', source: 'srcA' }] }; },
            getSnapshot:       async () => { plain = true;    return { validators: [{ pubkey: 'PKA', amount: '1' }] }; }
        };

        // SWQ activates at block >= 0 on regtest → weighted path, source-keyed.
        nd.pub.network = 'regtest';
        let set = await nd.pub._resolveCapabilitySet('oracle_publish', 100);
        expect(weighted, 'weighted snapshot used').to.be.true;
        expect(plain, 'plain snapshot not used').to.be.false;
        expect(set).to.deep.equal([{ pubkey: 'pka', amount: '7', source: 'srcA' }]);

        // mainnet activation is far in the future (999999999) → SWQ off → plain path, source ''.
        weighted = false; plain = false;
        nd.pub.network = 'mainnet';
        let set2 = await nd.pub._resolveCapabilitySet('oracle_publish', 100);
        expect(plain, 'plain snapshot used when SWQ off').to.be.true;
        expect(weighted, 'weighted snapshot not used when SWQ off').to.be.false;
        expect(set2).to.deep.equal([{ pubkey: 'pka', amount: '1', source: '' }]);
    });

    it('_resolveCapabilitySet carries the truncated flag from a weighted snapshot (XHUB-TRUNC-2)', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub.network = 'regtest';                          // SWQ active -> weighted path
        nd.pub.capSnapshot = {
            getWeightSnapshot: async () => ({ validators: [{ pubkey: 'PKA', weight: '7', source: 'srcA' }], truncated: true }),
            getSnapshot:       async () => ({ validators: [] })
        };
        let set = await nd.pub._resolveCapabilitySet('oracle_publish', 100);
        // Without the flag surviving the map, the archive quorum path would not fail closed.
        expect(set.truncated).to.equal(true);
    });

    it('_handleSignReq: a follower NOT in the snapshot_block signing set does not co-sign', async function () {
        let bus = buildMesh(2, { btcBlock: 500 });
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        let cp = Object.assign({}, CP_ROW);                       // snapshot_block = 100

        // Spy the first step AFTER the snapshot-set membership gate: the local
        // state_checkpoints re-SELECT. This used to spy _archiveCanonical, but the
        // proposer-signature verify now runs BEFORE the membership gate (it is what
        // authenticates the observed-leader record against a spoofed d.sig_pubkey), so
        // building the canonical no longer proves the gate was reached.
        let selects = 0;
        let origQuery = follower.pub.db.doQuery.bind(follower.pub.db);
        follower.pub.db.doQuery = (sql, params) => {
            if (/state_checkpoints/i.test(String(sql))) selects++;
            return origQuery(sql, params);
        };

        // A GENUINE leader signature over the archive canonical: with the verify ahead
        // of the membership gate, a bogus one would stop BOTH cases before the gate and
        // the control below would prove nothing.
        let reqCanonical = leader.pub._archiveCanonical(cp, 0, 1, '0', 1);
        let mkReq = () => ({ data: {
            checkpoint: cp, election_block: 500, batch_seq: 0, match_count: 1, batch_crc32: '0',
            total_chunks: 1, sig_pubkey: leader.pubkey, sig: leader.identity.sign(reqCanonical)
        }});

        // The election set must RESOLVE for either case to reach the membership gate at
        // all (#4184 made an empty election set fail closed), so the leader is the sole
        // elected publisher at election_block and ranks 0 on the ladder. Only the
        // snapshot_block set differs between the two cases.
        // (1) EXCLUDED: snapshot_block set omits the follower → bail at the membership
        // gate, never reads its own checkpoint row and never co-signs.
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [leader.pubkey] : [leader.pubkey];
        await follower.pub._handleSignReq(mkReq());
        expect(selects, 'excluded follower stops before the local checkpoint read').to.equal(0);

        // (2) CONTROL - INCLUDED in the snapshot_block set → proceeds past the gate to the
        // local checkpoint read (then stops harmlessly on the absent archive body).
        // Proves the membership gate is what stops case (1).
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [leader.pubkey, follower.pubkey] : [leader.pubkey];
        await follower.pub._handleSignReq(mkReq());
        expect(selects, 'included follower reads its own checkpoint row').to.equal(1);
    });

    it('_handleSignReq: an UNSIGNED SIGN_REQ never records an observed archive leader', async function () {
        // PeerManager authenticates the envelope RELAYER; d.sig_pubkey is a separate
        // application-level field, so any member can name another member there. The rank
        // ladder is no gate either: it is keyed on the WIRE checkpoint, so the sender
        // picks its own rank. Only the proposer's signature over the archive canonical
        // proves it holds the key it names, so nothing may be bound to that name before
        // the signature verifies: a poisoned _observedArchiveCheckpoints entry (first
        // observation wins) starves the genuine round's co-sign and makes the FINALIZED
        // back-fill abstain, and a flood past the cap evicts the in-flight entries.
        let bus = buildMesh(2, { btcBlock: 500 });
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        let cp = Object.assign({}, CP_ROW);
        const SEQ = 42;
        follower.pub._getActiveOraclePublishPubkeys = async () => [leader.pubkey];   // leader ranks 0

        let mkReq = (sig) => ({ data: {
            checkpoint: cp, election_block: 500, batch_seq: SEQ, match_count: 1, batch_crc32: '0',
            total_chunks: 1, sig_pubkey: leader.pubkey, sig: sig
        }});

        // Spoof: the leader's pubkey with a signature its key never produced.
        await follower.pub._handleSignReq(mkReq('deadbeef'));
        expect(follower.pub._isObservedArchiveLeader(SEQ, leader.pubkey),
               'an unsigned SIGN_REQ must not bind the named leader').to.equal(false);
        expect(follower.pub._observedArchiveCheckpoint(SEQ),
               'nor stash a checkpoint identity for the batch').to.equal(null);

        // CONTROL: the same REQ carrying the leader's real signature still records, so
        // the guard is the signature and not some other gate.
        let canonical = leader.pub._archiveCanonical(cp, SEQ, 1, '0', 1);
        await follower.pub._handleSignReq(mkReq(leader.identity.sign(canonical)));
        expect(follower.pub._isObservedArchiveLeader(SEQ, leader.pubkey)).to.equal(true);
        expect(follower.pub._observedArchiveCheckpoint(SEQ).checkpoint_seq).to.equal(Number(cp.checkpoint_seq));
    });

    it('_handleSignReq: an UNRESOLVED election set fails closed instead of skipping the ladder (#4184)', async function () {
        // The leader path already defers on an empty oracle_publish election set; the
        // follower fell through it, so during an unresolved window a NON-MEMBER could
        // solicit co-signatures from the historical wrapper set and assemble a duplicate
        // v1 under a batch_seq of its own choosing (honest content, doubled DOGE, two
        // archives able to claim one seq).
        let bus = buildMesh(2, { btcBlock: 500 });
        let follower = bus.nodes[0];
        let outsider = new ValidatorIdentity('99'.repeat(32)).getPubkeyHex().toLowerCase();
        let cp = Object.assign({}, CP_ROW);                       // snapshot_block = 100

        let canonCalls = 0;
        let origCanon = follower.pub._archiveCanonical.bind(follower.pub);
        follower.pub._archiveCanonical = (...a) => { canonCalls++; return origCanon(...a); };

        let mkReq = () => ({ data: {
            checkpoint: cp, election_block: 500, batch_seq: 0, match_count: 1, batch_crc32: '0',
            total_chunks: 1, sig_pubkey: outsider, sig: 'deadbeef'
        }});

        // (1) Election set UNRESOLVED while this follower IS in the snapshot_block signing
        // set - the exact combination the old fall-through admitted.
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [follower.pubkey] : [];
        await follower.pub._handleSignReq(mkReq());
        expect(canonCalls, 'an unresolved election set may not reach the co-sign path').to.equal(0);

        // (2) CONTROL - the SAME request with a resolved election set naming the sender
        // (rank 0) proceeds to the canonical, proving the empty-set gate stopped (1).
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [follower.pubkey] : [outsider];
        await follower.pub._handleSignReq(mkReq());
        expect(canonCalls, 'a resolved election set naming the sender still co-signs').to.equal(1);
    });

    // XANC-V0DONE partial: the peer back-fill UPDATE now keys on checkpoint_seq, exactly like
    // the publisher's own stamp, so one V0_DONE cannot mark a DIFFERENT/other seq row at the
    // height. (The full suppression fix - verifying the announced txid on-chain - is an open item.)
    it('_handleV0Done: stamps anchor_txid keyed on checkpoint_seq', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub._getActiveOraclePublishPubkeys = async () => [nd.pubkey];
        nd.pub._recordReward = () => {};                     // isolate the UPDATE assertion
        nd.pub._verifyAnchorOnChain = async () => 'verified';  // isolate from the on-chain gate (covered separately)
        let calls = [];
        nd.pub.db.doQuery = async (sql, params) => {
            calls.push({ sql, params });
            // The exact-identity SELECT feeds both the election vet and the on-chain
            // gate, so it must carry the checkpoint hashes + snapshot_block.
            if (sql.startsWith('SELECT * FROM state_checkpoints')) return [Object.assign({}, CP_ROW, { snapshot_block: 100 })];
            if (sql.startsWith('SELECT snapshot_block FROM state_checkpoints')) return [{ snapshot_block: 100 }];
            return [];
        };
        let d = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7, txid: 'aa'.repeat(32) };
        d.sig_pubkey = nd.pubkey;
        d.sig = nd.identity.sign(nd.pub._v0DoneCanonical(d, d.txid));

        await nd.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: nd.pubkey, data: d });

        let upd = calls.find(c => c.sql.startsWith('UPDATE state_checkpoints SET anchor_txid'));
        expect(upd, 'UPDATE issued').to.exist;
        expect(upd.sql).to.match(/checkpoint_seq = \?/);
        expect(upd.sql).to.match(/anchor_txid IS NULL/);
        expect(upd.params[4]).to.equal(7);
    });

    // XANC-V0DONE-SUPPRESS-1 / XANC-REWARD-THEFT-1: a V0_DONE from an oracle_publish member
    // that is NOT the rank-unlocked elected v0 publisher for the referenced checkpoint must be
    // rejected - otherwise a single Byzantine member forges a txid, stamps anchor_txid (the
    // `IS NULL` selector then skips the row fleet-wide, suppressing the real anchor) and mirrors
    // itself the reward. The gate re-runs the publisher's own election from the LOCAL
    // checkpoint's snapshot_block (no signed-canonical change).
    it('_handleV0Done: rejects a forged V0_DONE from a non-elected oracle_publish member', async function () {
        let bus = buildMesh(3);                     // default btcBlock=100 == snapshot_block => since=0, only rank 0 unlocked
        let order = v0Order(bus, CP_ROW);
        let attacker = order[2];                    // a member, but not the elected (rank-0) publisher
        let receiver = order[1];
        let d = { chain: CP_ROW.chain, network: CP_ROW.network, block_index: CP_ROW.block_index,
                  checkpoint_seq: CP_ROW.checkpoint_seq, txid: 'aa'.repeat(32) };
        d.sig_pubkey = attacker.pubkey;
        d.sig = attacker.identity.sign(receiver.pub._v0DoneCanonical(d, d.txid));

        await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: attacker.pubkey, data: d });

        expect(receiver.db.checkpoints[0].anchor_txid, 'forged V0_DONE must not stamp (suppression blocked)').to.equal(null);
        expect(receiver.rewards.length, 'forged V0_DONE must not mirror a reward (theft blocked)').to.equal(0);
    });

    it('_handleV0Done: accepts a V0_DONE from the rank-unlocked elected publisher', async function () {
        let bus = buildMesh(3);
        let order = v0Order(bus, CP_ROW);
        let publisher = order[0];                   // rank 0 is always unlocked
        let receiver  = order[1];
        let d = { chain: CP_ROW.chain, network: CP_ROW.network, block_index: CP_ROW.block_index,
                  checkpoint_seq: CP_ROW.checkpoint_seq, txid: 'bb'.repeat(32) };
        d.sig_pubkey = publisher.pubkey;
        d.sig = publisher.identity.sign(receiver.pub._v0DoneCanonical(d, d.txid));

        await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });

        expect(receiver.db.checkpoints[0].anchor_txid, 'elected publisher V0_DONE stamps').to.equal('bb'.repeat(32));
        // BELOW the anchor-reward flag-day (outer-suite pin) the hub rows are the
        // reward's only transport, so the mirror still fires (control for the
        // at/above-flag-day skip asserted in the v4/v5 suite).
        expect(receiver.rewards.filter(r => r.type === 'anchor_BTC').length,
            'below flag-day the mirror records the reward').to.equal(1);
    });

    // XANC-ELECTED-FORGE-1 / XANC-V0DONE-SUPPRESS-1 residual: the election gate
    // proves the SENDER is an elected v0 publisher but not that the announced
    // anchor was ever mined. _verifyAnchorOnChain asks OUR OWN DOGE indexer
    // (getanchoraction) for the DECODED anchor at THIS checkpoint and only lets the
    // stamp+reward through when it exists, is not decoded-invalid, is buried
    // >= XCHAIN_CONFIRMATIONS_DOGE, and its payload hashes byte-match our copy.
    describe('_handleV0Done on-chain ANCHOR verification', function () {
        // Build a signed V0_DONE from the rank-0 (always unlocked) elected publisher
        // for the mesh checkpoint, returning {receiver, d}.
        function electedV0Done(bus, txid) {
            let order = v0Order(bus, CP_ROW);
            let publisher = order[0], receiver = order[1];
            let d = { chain: CP_ROW.chain, network: CP_ROW.network, block_index: CP_ROW.block_index,
                      checkpoint_seq: CP_ROW.checkpoint_seq, txid: txid };
            d.sig_pubkey = publisher.pubkey;
            d.sig = publisher.identity.sign(receiver.pub._v0DoneCanonical(d, d.txid));
            return { publisher, receiver, d };
        }
        let matching = {
            block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
            actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash
        };

        it('ACCEPTS when the DOGE indexer confirms the anchor at depth with matching hashes', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ab'.repeat(32));
            // Honest indexer: the announced txid is the tx the anchor landed in.
            receiver.pub._indexerCall = async (coin, method, params) => Object.assign(
                { exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
                  confirmations: 60, txid: params.txid }, matching);
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, 'confirmed anchor stamps').to.equal('ab'.repeat(32));
            expect(receiver.rewards.filter(r => r.type === 'anchor_BTC').length, 'confirmed anchor mirrors reward').to.equal(1);
        });

        it('ABSTAINS (no stamp/reward) when the anchor is ABSENT on-chain (phantom txid)', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ac'.repeat(32));
            receiver.pub._indexerCall = async () => ({ exists: false, confirmations: 0 });
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, 'phantom anchor must not stamp (suppression blocked)').to.equal(null);
            expect(receiver.rewards.length, 'phantom anchor must not mirror a reward').to.equal(0);
        });

        // ── XANC-ELECTED-FORGE-1 (v0 half): the announced txid is now BOUND ──────
        // The election gate proves the sender is an elected publisher; it does NOT
        // prove the sender published THIS anchor. Before the txid binding, an elected
        // publisher could announce any txid for a checkpoint that happened to be
        // anchored, stamp it, and suppress the real anchor via `anchor_txid IS NULL`.

        it('REJECTS a fabricated txid for a checkpoint that IS anchored (elected-publisher forge)', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ff'.repeat(32));
            // Checkpoint is genuinely anchored, but by a DIFFERENT transaction: the
            // filtered lookup misses, and checkpoint_anchored marks it a positive forge.
            receiver.pub._indexerCall = async () => ({ exists: false, checkpoint_anchored: true, confirmations: 0 });
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, 'forged txid must not stamp').to.equal(null);
            expect(receiver.rewards.length, 'forged txid must not mirror a reward').to.equal(0);
        });

        it('REJECTS when the indexer returns an anchor whose txid differs from the announced one', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ab'.repeat(32));
            // An indexer that ignored the filter and returned the newest anchor instead.
            receiver.pub._indexerCall = async () => Object.assign(
                { exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
                  confirmations: 60, txid: 'cd'.repeat(32) }, matching);
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, 'unbound anchor must not stamp').to.equal(null);
        });

        it('FAILS CLOSED against an indexer too old to return a txid (roll indexers first)', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ab'.repeat(32));
            // Pre-filter indexer: ignores the txid param, response carries no txid.
            receiver.pub._indexerCall = async () => Object.assign(
                { exists: true, status: 'valid', version: 0, confirmations: 60 }, matching);
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, 'unbindable anchor must not stamp').to.equal(null);
            expect(receiver.rewards.length, 'unbindable anchor must not mirror a reward').to.equal(0);
        });

        it('passes the announced txid to the indexer as a filter', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ab'.repeat(32));
            let seen = null;
            receiver.pub._indexerCall = async (coin, method, params) => {
                seen = params;
                return Object.assign({ exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
                                       confirmations: 60, txid: params.txid }, matching);
            };
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(seen.txid, 'V0_DONE binds the announced txid').to.equal('ab'.repeat(32));
        });

        it('ABSTAINS when the anchor is SHALLOWER than XCHAIN_CONFIRMATIONS_DOGE', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ad'.repeat(32));
            receiver.pub._indexerCall = async () => Object.assign(
                { exists: true, status: 'valid', version: 0, confirmations: 59 }, matching);
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, '0..59-conf anchor must not stamp').to.equal(null);
            expect(receiver.rewards.length, 'shallow anchor must not mirror a reward').to.equal(0);
        });

        it('REJECTS when the DECODED anchor status is invalid', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'ae'.repeat(32));
            receiver.pub._indexerCall = async () => Object.assign(
                { exists: true, status: 'invalid: ledger_hash mismatch', version: 0, confirmations: 60 }, matching);
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, 'decoded-invalid anchor must not stamp').to.equal(null);
            expect(receiver.rewards.length, 'decoded-invalid anchor must not mirror a reward').to.equal(0);
        });

        it('REJECTS when the on-chain payload hashes do NOT byte-match our checkpoint', async function () {
            let bus = buildMesh(3);
            let { publisher, receiver, d } = electedV0Done(bus, 'af'.repeat(32));
            receiver.pub._indexerCall = async () => ({
                exists: true, status: 'valid', version: 0, confirmations: 60,
                block_hash: 'ff'.repeat(32),                         // diverges from CP_ROW.block_hash
                ledger_hash: CP_ROW.ledger_hash, actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash
            });
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(receiver.db.checkpoints[0].anchor_txid, 'hash-mismatched anchor must not stamp').to.equal(null);
            expect(receiver.rewards.length, 'hash-mismatched anchor must not mirror a reward').to.equal(0);
        });

        it('ABSTAINS (no stamp/reward) when no DOGE indexer is wired', async function () {
            let bus = buildMesh(3, { cfg: { DOGE_INDEXER_URL: '' } });   // hub opts out of on-chain verification
            let { publisher, receiver, d } = electedV0Done(bus, 'ba'.repeat(32));
            let called = 0;
            receiver.pub._indexerCall = async () => { called++; return { exists: true, status: 'valid', confirmations: 60 }; };
            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: publisher.pubkey, data: d });
            expect(called, 'no-indexer short-circuits before any RPC').to.equal(0);
            expect(receiver.db.checkpoints[0].anchor_txid, 'unverifiable anchor must not stamp').to.equal(null);
            expect(receiver.rewards.length, 'unverifiable anchor must not mirror a reward').to.equal(0);
        });
    });

    it('size-trigger: reaching batchSize match:finalized events fires a flush', async function () {
        let EventEmitter = require('events');
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let dex = new EventEmitter();
        nd.pub.hub.crossChainDex = dex;                           // wired into the match:finalized listener at start()
        nd.pub.batchSize = 2;
        nd.pub._pendingMatches = 0;

        let flushes = 0;
        let origFlush = nd.pub.flush.bind(nd.pub);
        nd.pub.flush = async () => { flushes++; return origFlush(); };
        await nd.pub.start();

        dex.emit('match:finalized');                             // 1 < batchSize → no flush
        await waitUntil(() => nd.pub._pendingMatches === 1, { label: 'the first match:finalized event to be counted' });
        expect(flushes, 'one event below batchSize does not flush').to.equal(0);

        dex.emit('match:finalized');                             // 2 >= batchSize → flush
        await waitUntil(() => flushes > 0, { label: 'reaching batchSize to trigger a flush' });
        expect(flushes, 'reaching batchSize triggers a flush').to.be.greaterThan(0);
    });

    // Finding 1205: the v0-publisher election rank/identity check now runs for a
    // size-1 elected set too (the old `length > 1` guard skipped it, letting any
    // CURRENT oracle_publish member impersonate the sole elected publisher and
    // stamp/suppress the anchor + mirror the reward). Rejection is a silent
    // return: anchor_txid stays null and no reward is mirrored.
    describe('_handleV0Done size-1 elected set (finding 1205)', function () {
        it('rejects a NON-elected current member when the elected set has exactly one member', async function () {
            let bus = buildMesh(2);
            let elected  = bus.nodes[0];             // the SOLE elected publisher (size-1 set)
            let attacker = bus.nodes[1];             // a current oracle_publish member, but not elected
            let receiver = bus.nodes[0];             // holds the checkpoint and processes the done
            // Current membership (null arg) admits BOTH nodes so the attacker clears the
            // membership gate; the snapshot_block election set is exactly [elected].
            receiver.pub._getActiveOraclePublishPubkeys = async (blk) =>
                (blk == null ? bus.nodes.map(nd => nd.pubkey) : [elected.pubkey]);

            let d = { chain: CP_ROW.chain, network: CP_ROW.network, block_index: CP_ROW.block_index,
                      checkpoint_seq: CP_ROW.checkpoint_seq, txid: 'aa'.repeat(32) };
            d.sig_pubkey = attacker.pubkey;
            d.sig = attacker.identity.sign(receiver.pub._v0DoneCanonical(d, d.txid));

            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: attacker.pubkey, data: d });

            expect(receiver.db.checkpoints[0].anchor_txid, 'non-elected member must not stamp (size-1 set)').to.equal(null);
            expect(receiver.rewards.length, 'non-elected member must not mirror a reward').to.equal(0);
        });

        it("accepts the sole elected publisher's request when the elected set has exactly one member", async function () {
            let bus = buildMesh(2);
            let elected  = bus.nodes[0];             // the SOLE elected publisher (rank 0, always unlocked)
            let receiver = bus.nodes[1];             // a peer that holds the checkpoint
            receiver.pub._getActiveOraclePublishPubkeys = async (blk) =>
                (blk == null ? bus.nodes.map(nd => nd.pubkey) : [elected.pubkey]);

            let d = { chain: CP_ROW.chain, network: CP_ROW.network, block_index: CP_ROW.block_index,
                      checkpoint_seq: CP_ROW.checkpoint_seq, txid: 'bb'.repeat(32) };
            d.sig_pubkey = elected.pubkey;
            d.sig = elected.identity.sign(receiver.pub._v0DoneCanonical(d, d.txid));

            await receiver.pub._handleV0Done({ type: 'XANC_V0_DONE', sender: elected.pubkey, data: d });

            expect(receiver.db.checkpoints[0].anchor_txid, 'sole elected publisher V0_DONE stamps').to.equal('bb'.repeat(32));
            expect(receiver.rewards.filter(r => r.type === 'anchor_BTC').length,
                'below flag-day the mirror records the reward').to.equal(1);
        });
    });

    // Findings 1206 / 1207: with a configured hub network, the v0 pending-anchor
    // selector and the archive wrapper-checkpoint selector are both scoped to
    // this.network, so a leftover row from a prior-network deployment can never be
    // re-anchored (1206) nor become the archive wrapper (1207).
    describe('network-scoped checkpoint selection (findings 1206 / 1207)', function () {
        // Isolate the network SCOPING from the stake-weighted quorum machinery:
        // configuring a regtest network would otherwise flip weighted quorum on and
        // pull in getWeightSnapshot wiring the mesh hub does not provide. Pin the
        // regtest activation dormant so the flow uses the legacy count path.
        const swqMod = require('../../src/stake_weighted_quorum.js');
        let savedSwqRegtest;
        beforeEach(function () {
            savedSwqRegtest = swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest;
            swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = 999999999;
        });
        afterEach(function () {
            swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = savedSwqRegtest;
        });

        it('does NOT select an unanchored checkpoint on a DIFFERENT network for anchoring (1206)', async function () {
            let bus = buildMesh(1);
            let nd = bus.nodes[0];
            nd.pub.network = 'regtest';                          // hub configured for regtest
            // A leftover unanchored checkpoint from a dead 'mainnet' deployment.
            nd.db.checkpoints.push(Object.assign({}, CP_ROW, {
                id: 99, network: 'mainnet', block_index: 777, anchor_txid: null
            }));
            await startAll(bus);

            let res = await nd.pub.flush();

            expect(res.anchored.length, 'only the regtest checkpoint is anchored').to.equal(1);
            expect(res.anchored[0]).to.include({ chain: 'BTC', network: 'regtest', block_index: 494 });
            expect(res.anchored.some(a => a.network === 'mainnet'),
                'the foreign-network row is never selected').to.equal(false);
        });

        it('selects only the matching-network wrapper checkpoint for the archive round (1207)', async function () {
            let bus = buildMesh(1);
            let nd = bus.nodes[0];
            nd.pub.network = 'regtest';
            // A foreign-network BTC checkpoint with a HIGHER id: the unscoped
            // "ORDER BY (chain='BTC') DESC, id DESC" would prefer it as the wrapper.
            nd.db.checkpoints.push(Object.assign({}, CP_ROW, {
                id: 99, network: 'mainnet', block_index: 777, anchor_txid: null
            }));
            // Capture the network the archive is built for (arg 0 of _buildArchive).
            let capturedNetwork = null;
            let origBuild = nd.pub._buildArchive.bind(nd.pub);
            nd.pub._buildArchive = async (network, ...rest) => {
                capturedNetwork = network;
                return origBuild(network, ...rest);
            };
            await startAll(bus);

            let res = await nd.pub.flush();

            expect(res.archive, 'archive round published').to.equal('published');
            expect(capturedNetwork, 'wrapper checkpoint is network-scoped to regtest').to.equal('regtest');
        });
    });
});

// Publisher-wallet runway stats (#5443): _checkBalance records the last-observed
// DOGE balance and getAnchorStats surfaces it for the monitor/operator.
describe('StateAnchorPublisher getAnchorStats balance', function () {
    function newPub(cfg) {
        return new StateAnchorPublisher({ db: {}, p2pConfig: Object.assign({ DOGE_ADDRESS: 'Dpub1' }, cfg || {}) });
    }
    it('starts with a null balance and exposes address + threshold', function () {
        let s = newPub({ DOGE_LOW_BALANCE_THRESHOLD: '10' }).getAnchorStats();
        expect(s.dogeBalance).to.equal(null);
        expect(s.dogeBalanceAt).to.equal(null);
        expect(s.dogeAddress).to.equal('Dpub1');
        expect(s.lowBalanceThreshold).to.equal(10);
    });
    it('_checkBalance records the observed balance into getAnchorStats', async function () {
        let pub = newPub();
        let bal = await pub._checkBalance({ getBalanceFn: async () => 42.5 });
        expect(bal).to.equal(42.5);
        let s = pub.getAnchorStats();
        expect(s.dogeBalance).to.equal(42.5);
        expect(s.dogeBalanceAt).to.be.a('number');
    });
    it('a failed balance read leaves the last-observed value untouched', async function () {
        let pub = newPub();
        await pub._checkBalance({ getBalanceFn: async () => 5 });
        await pub._checkBalance({ getBalanceFn: async () => { throw new Error('node down'); } });
        expect(pub.getAnchorStats().dogeBalance).to.equal(5);   // not clobbered to null
    });
});

describe('StateAnchorPublisher: capability-snapshot archive sort is a spec-stable total order', function () {

    // The archive JSON is crc32-bearing bytes verified byte-for-byte by
    // follower co-signers, so the capability-snapshot ordering must be fully
    // determined by the data (pubkey, then source), never by the engine's
    // handling of an inconsistent (equal-returns-1) comparator. Equal pubkeys
    // are legitimately possible in weighted snapshots: one row per
    // (source, pubkey), and a key may be delegated by multiple sources.

    function newPub() {
        return new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    }
    function capSnaps(pub, set) {
        pub._resolveCapabilitySet = async () => set.map(r => Object.assign({}, r));
        return pub._buildArchive('regtest', 1, [], 100, [], [])
            .then(a => JSON.parse(a.json).capability_snapshots
                .map(s => s.signing_pubkey + '|' + s.source));
    }

    it('orders equal-pubkey rows by source regardless of input order', async function () {
        let scrambled = [
            { pubkey: 'aa', amount: '1', source: 'srcB' },
            { pubkey: 'bb', amount: '2', source: 'srcA' },
            { pubkey: 'aa', amount: '1', source: 'srcA' }
        ];
        let out = await capSnaps(newPub(), scrambled);
        expect(out).to.deep.equal(['aa|srcA', 'aa|srcB', 'bb|srcA']);
    });

    it('produces byte-identical ordering for two different input orders of equal pubkeys', async function () {
        let orderA = [
            { pubkey: 'aa', amount: '1', source: 'srcA' },
            { pubkey: 'aa', amount: '1', source: 'srcB' }
        ];
        let orderB = [
            { pubkey: 'aa', amount: '1', source: 'srcB' },
            { pubkey: 'aa', amount: '1', source: 'srcA' }
        ];
        let outA = await capSnaps(newPub(), orderA);
        let outB = await capSnaps(newPub(), orderB);
        expect(outA).to.deep.equal(outB);
        expect(outA).to.deep.equal(['aa|srcA', 'aa|srcB']);
    });
});

// stop() must settle the archive-attestation round's awaited promise, mirroring
// the v4/v5 _attestRound teardown (#2360). Without it a stop() mid-round leaves
// _publishArchive hung on a promise only an unref'd timer could ever settle.
describe('StateAnchorPublisher stop() archive-attestation teardown (#2360)', function () {
    function barePub() {
        return new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    }

    it('resolves a pending _archiveAttestRound with { met:false, sigs:[] } and nulls the field', async function () {
        let pub = barePub();
        let settled = null;
        let timer = setTimeout(() => {}, 1e6);
        if (timer.unref) timer.unref();
        pub._archiveAttestRound = { done: false, timer: timer, resolve: (v) => { settled = v; } };
        await pub.stop();
        expect(settled, 'awaiting _publishArchive is unblocked on shutdown').to.deep.equal({ met: false, sigs: [] });
        expect(pub._archiveAttestRound, 'field nulled').to.equal(null);
    });

    it('is a no-op when the round is already done (no double-resolve)', async function () {
        let pub = barePub();
        let calls = 0;
        pub._archiveAttestRound = { done: true, timer: null, resolve: () => { calls++; } };
        await pub.stop();
        expect(calls, 'a completed round is not re-resolved').to.equal(0);
        expect(pub._archiveAttestRound).to.equal(null);
    });
});

// _cpFromRow intentionally omits the SPV roots, and the co-sign guards compare via
// _rawCanonicalCheckpoint so the presence-gated root suffix can never flip them
// fail-closed post-flag-day (#2462).
describe('StateAnchorPublisher checkpoint co-sign guard uses the rootless canonical (#2462)', function () {
    const ckptMod = require('../../src/checkpoint_commitment_activation.js');
    let savedRegtest;
    beforeEach(function () {
        savedRegtest = ckptMod.CHECKPOINT_COMMITMENT_ACTIVATION.regtest;
        ckptMod.CHECKPOINT_COMMITMENT_ACTIVATION.regtest = 0;   // roots committed at genesis on regtest
    });
    afterEach(function () {
        ckptMod.CHECKPOINT_COMMITMENT_ACTIVATION.regtest = savedRegtest;
    });

    it('_rawCanonicalCheckpoint matches across the rootless and root-bearing shapes while canonicalCheckpoint differs', function () {
        let row = {
            chain: 'BTC', network: 'regtest', block_index: 494,
            block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
            actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 7, snapshot_block: 100,
            state_root: 'd4'.repeat(32), state_root_version: 1,
            block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
        };
        let rootless = StateAnchorPublisher.prototype._cpFromRow(row);
        expect(rootless).to.not.have.property('state_root');    // _cpFromRow drops the roots by design
        let rootBearing = Object.assign({}, rootless, {
            state_root: row.state_root, state_root_version: row.state_root_version,
            block_merkle_root: row.block_merkle_root, block_merkle_version: row.block_merkle_version
        });
        // The guard (via _rawCanonicalCheckpoint) still binds identity fields and
        // passes even when exactly one operand carries roots.
        expect(StateCheckpointEngine._rawCanonicalCheckpoint(rootless))
            .to.equal(StateCheckpointEngine._rawCanonicalCheckpoint(rootBearing));
        // Whereas canonicalCheckpoint would DIFFER on the presence-gated suffix,
        // which is exactly why the guards must not use it.
        expect(StateCheckpointEngine.canonicalCheckpoint(rootless))
            .to.not.equal(StateCheckpointEngine.canonicalCheckpoint(rootBearing));
    });
});

// ── anchor_reward_attestations mirror INSERT ──────────────────────
describe('StateAnchorPublisher._recordRewardAttestation', function () {
    const sinon = require('sinon');

    function makePub(){
        const queries = [];
        const broadcast = [];
        const db = { async doQuery(sql, params){ queries.push({ sql, params }); return sql.indexOf('SELECT') === 0 ? [{ id: 1, publisher: params[5] }] : { affectedRows: 1 }; } };
        const hub = { db, getIdentity: () => null, hubDbBroadcaster: { broadcastRow: (ev) => broadcast.push(ev) } };
        return { pub: new StateAnchorPublisher(hub), queries, broadcast };
    }

    afterEach(() => sinon.restore());

    it('below the derive gate (inert mainnet placeholder) it writes NOTHING', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
        const { pub, queries, broadcast } = makePub();
        await pub._recordRewardAttestation('BTC', 'mainnet', 'anchor_BTC', 5, 1000000, 'ab'.repeat(32), [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }]);
        expect(queries.length).to.equal(0);
        expect(broadcast.length).to.equal(0);
    });

    it('at/above the gate it INSERT-IGNOREs the tuple with the FROZEN amount and broadcasts the row', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries, broadcast } = makePub();
        const pk = 'ab'.repeat(32);
        await pub._recordRewardAttestation('BTC', 'regtest', 'anchor_BTC', 5, 0, pk, [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }]);
        const ins = queries.find(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);
        expect(ins, 'INSERT IGNORE issued').to.exist;
        expect(ins.params[2]).to.equal('anchor_BTC');            // reward_type
        expect(ins.params[6]).to.equal(arMod.ANCHOR_REWARD_AMOUNT); // frozen amount, not wire
        expect(broadcast.length).to.equal(1);
        expect(broadcast[0].table).to.equal('anchor_reward_attestations');
    });

    it('uses the ARCHIVE frozen amount for an anchor_archive tuple', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makePub();
        await pub._recordRewardAttestation('BTC', 'regtest', 'anchor_archive', 3, 0, 'ab'.repeat(32), [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }]);
        const ins = queries.find(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);
        expect(ins.params[6]).to.equal(arMod.ARCHIVE_REWARD_AMOUNT);
    });

    it('writes nothing when the attestation sig list is empty', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makePub();
        await pub._recordRewardAttestation('BTC', 'regtest', 'anchor_BTC', 5, 0, 'ab'.repeat(32), []);
        expect(queries.length).to.equal(0);
    });
});

// ── The attestation row waits for a MINED anchor, not a broadcast one ────
// _broadcastWithRetry returns on DOGE mempool acceptance, so writing the append-only,
// never-retracted mirror row there minted a permanent COLLECT-spendable reward for an
// anchor that could still be evicted or reorged away. Both producer sites now queue.
describe('StateAnchorPublisher reward attestation confirm-then-write (#4456)', function () {
    const sinon = require('sinon');

    const TXID = 'ab'.repeat(32);
    const ATTEST = [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }];

    // A publisher whose DB serves CP_ROW for the checkpoint re-SELECT and records every
    // write, with a wired (stubbable) DOGE indexer so _verifyAnchorOnChain can run.
    function makeRewardPub() {
        const queries = [];
        const broadcast = [];
        const db = {
            async doQuery(sql, params) {
                queries.push({ sql, params });
                if (sql.indexOf('SELECT * FROM state_checkpoints') === 0) return [Object.assign({}, CP_ROW)];
                if (sql.indexOf('SELECT') === 0) return [{ id: 1, publisher: params[5] }];
                return { affectedRows: 1 };
            }
        };
        const hub = { db, getIdentity: () => null, hubDbBroadcaster: { broadcastRow: (ev) => broadcast.push(ev) } };
        const pub = new StateAnchorPublisher(hub);
        pub.indexers.DOGE = { url: 'http://doge.indexer.invalid', key: '' };
        pub.dogeConfirmations = 60;
        return { pub, queries, broadcast };
    }

    function entry(extra) {
        return Object.assign({
            chain: CP_ROW.chain, network: CP_ROW.network,
            blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
            txid: TXID, anchorVersion: 4,
            rewardType: 'anchor_BTC', roundReference: CP_ROW.checkpoint_seq,
            snapshotBlock: CP_ROW.snapshot_block,
            publisher: 'ab'.repeat(32), attestSigs: ATTEST
        }, extra || {});
    }

    const onChain = (over) => Object.assign({
        exists: true, checkpoint_anchored: true, status: 'valid', version: 4,
        confirmations: 60, txid: TXID,
        block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
        actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash
    }, over || {});

    const inserts = (queries) => queries.filter(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);

    afterEach(() => sinon.restore());

    it('below the derive gate it queues nothing (the table has no rows at all)', function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
        const { pub } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('at/above the gate the publish path QUEUES instead of writing (mempool txid)', function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        expect(pub._deferredRewardAttest.size, 'entry queued').to.equal(1);
        expect(inserts(queries).length, 'nothing written at broadcast time').to.equal(0);
    });

    it('writes the row once the anchor is buried at the bound txid AND version', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries, broadcast } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        pub._indexerCall = async () => onChain();
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'confirmed anchor writes the attestation').to.equal(1);
        expect(broadcast.length, 'and streams it to this hub\'s indexer subscribers').to.equal(1);
        expect(pub._deferredRewardAttest.size, 'entry cleared').to.equal(0);
    });

    it('does NOT write while the anchor is still shallow (the mempool/reorg window)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        pub._indexerCall = async () => onChain({ confirmations: 3 });
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'no reward for an unburied anchor').to.equal(0);
        expect(pub._deferredRewardAttest.size, 'entry retained for retry').to.equal(1);
    });

    it('does NOT write when the anchor is absent, i.e. the tx was evicted and never mined', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        pub._indexerCall = async () => ({ exists: false, checkpoint_anchored: false, confirmations: 0 });
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'evicted anchor mints nothing').to.equal(0);
    });

    it('does NOT write when a DIFFERENT anchor confirmed for this checkpoint (txid unbound)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        pub._indexerCall = async () => onChain({ txid: 'cc'.repeat(32) });
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length).to.equal(0);
    });

    it('drops on a decided content rejection (a v0 fallback landed, not the attested v4)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        pub._indexerCall = async () => onChain({ version: 0 });
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'a legacy v0 anchor derives no reward').to.equal(0);
        expect(pub._deferredRewardAttest.size, 'terminal verdict clears the entry').to.equal(0);
    });

    it('expires the entry after the TTL rather than writing on a never-confirming anchor', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub._deferRewardAttestation(entry());
        pub._deferredRewardAttest.get([...pub._deferredRewardAttest.keys()][0]).at =
            Date.now() - (pub.announceRetryTtlMs + 1);
        pub._indexerCall = async () => onChain();
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'an expired entry must not write').to.equal(0);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('binds version 6 for the archive leg, so a legacy v1 head derives nothing', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        const archive = () => entry({ anchorVersion: 6, rewardType: 'anchor_archive', roundReference: 42 });
        pub._deferRewardAttestation(archive());
        pub._indexerCall = async () => onChain({ version: 1 });
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'a degraded v1 archive head derives no reward').to.equal(0);
        pub._deferRewardAttestation(archive());
        pub._indexerCall = async () => onChain({ version: 6 });
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'the attested v6 head does').to.equal(1);
    });

    it('is bounded: a flood evicts the OLDEST entry and never writes one', function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.announceQueueMax = 3;
        for (let i = 0; i < 6; i++)
            pub._deferRewardAttestation(entry({ roundReference: i, txid: (i + 10).toString(16).repeat(32) }));
        expect(pub._deferredRewardAttest.size).to.equal(3);
        expect(inserts(queries).length).to.equal(0);
    });
});

// ── XANCREWARD: hub-to-hub federation of the confirmed attestation row (AML #4170) ──
//
// Before this, the anchor_reward_attestations row reached only the PUBLISHING hub's own
// indexer subscribers. The publisher rotates per checkpoint, so a federation's hubs held
// disjoint subsets and each indexer derived only the slice its own hub happened to publish.
// The fix broadcasts the CONFIRMED row, and the security property is entirely on the
// receiving side: the message supplies identity, never authority. Every one of these cases
// is a way a receiver must refuse to turn a wire message into a money row.
describe('StateAnchorPublisher XANCREWARD federation (#4170)', function () {
    const sinon = require('sinon');
    const XANCREWARD = require('../../src/StateAnchorPublisher.js').XANCREWARD;

    const TXID = 'ab'.repeat(32);

    // A hub with an identity, a wired DOGE indexer, and a resolvable oracle_publish set.
    // `members` are the pubkeys in that set; the receiver's own key is always a member.
    function makeReceiver(members) {
        const queries   = [];
        const broadcast = [];
        const sent      = [];
        const db = {
            async doQuery(sql, params) {
                queries.push({ sql, params });
                if (sql.indexOf('SELECT * FROM state_checkpoints') === 0) return [Object.assign({}, CP_ROW)];
                if (sql.indexOf('SELECT') === 0) return [{ id: 1, publisher: params[5] }];
                return { affectedRows: 1 };
            }
        };
        const hub = { db, getIdentity: () => null, hubDbBroadcaster: { broadcastRow: (ev) => broadcast.push(ev) } };
        const pub = new StateAnchorPublisher(hub);
        pub.identity    = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        pub.peerManager = { broadcast: (type, data) => sent.push({ type, data }), on: () => {} };
        pub.indexers.DOGE = { url: 'http://doge.indexer.invalid', key: '' };
        pub.dogeConfirmations = 60;
        pub.network = CP_ROW.network;
        const set = (members || []).concat([pub.identity.getPubkeyHex().toLowerCase()]);
        pub._resolveCapabilitySet = async () => set.map(pk => ({ pubkey: pk, source: pk, amount: '1' }));
        return { pub, queries, broadcast, sent, set };
    }

    // A signed XANCREWARD payload for the per-chain (v4) reward on CP_ROW, attested by
    // `signers` (ValidatorIdentity instances) and relayed by `sender`.
    function payloadFrom(pub, sender, signers, over) {
        const publisher = (over && over.publisher) || sender.getPubkeyHex().toLowerCase();
        const d = Object.assign({
            chain: CP_ROW.chain, network: CP_ROW.network,
            reward_type: 'anchor_' + CP_ROW.chain, round_reference: CP_ROW.checkpoint_seq,
            snapshot_block: CP_ROW.snapshot_block, publisher: publisher,
            doge_anchor_txid: TXID, anchor_version: 4,
            block_index: CP_ROW.block_index, checkpoint_seq: CP_ROW.checkpoint_seq
        }, over || {});
        const cp = { chain: d.chain, network: d.network, checkpoint_seq: d.round_reference, snapshot_block: d.snapshot_block };
        const canonical = (d.reward_type === 'anchor_archive')
            ? pub._archiveAttestationCanonical({ network: d.network, snapshot_block: d.snapshot_block }, d.round_reference, d.publisher)
            : pub._attestationCanonical(cp, d.publisher);
        d.attest_sigs = (over && over.attest_sigs) || signers.map(s => ({
            pubkey: s.getPubkeyHex().toLowerCase(), sig: s.sign(canonical)
        }));
        d.sig_pubkey = sender.getPubkeyHex().toLowerCase();
        d.sig        = sender.sign(pub._rewardFederationCanonical(d));
        return d;
    }

    const onChain = (over) => Object.assign({
        exists: true, checkpoint_anchored: true, status: 'valid', version: 4,
        confirmations: 60, txid: TXID,
        block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
        actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash
    }, over || {});

    const inserts = (queries) => queries.filter(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);

    afterEach(() => sinon.restore());

    it('the publisher federates the row at the CONFIRMED write, never at broadcast time', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries, sent } = makeReceiver([]);
        const me = pub.identity.getPubkeyHex().toLowerCase();
        pub._deferRewardAttestation({
            chain: CP_ROW.chain, network: CP_ROW.network,
            blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
            txid: TXID, anchorVersion: 4,
            rewardType: 'anchor_' + CP_ROW.chain, roundReference: CP_ROW.checkpoint_seq,
            snapshotBlock: CP_ROW.snapshot_block, publisher: me,
            attestSigs: [{ pubkey: me, sig: 'ef'.repeat(64) }],
            federate: true
        });
        expect(sent.filter(m => m.type === XANCREWARD).length, 'nothing federated while unconfirmed').to.equal(0);

        pub._indexerCall = async () => onChain();
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'the row is written locally first').to.equal(1);
        const msg = sent.find(m => m.type === XANCREWARD);
        expect(msg, 'the confirmed row is federated').to.exist;
        expect(msg.data.doge_anchor_txid, 'bound to the PROVEN txid').to.equal(TXID);
        expect(msg.data.reward_amount, 'the frozen amount is never put on the wire').to.equal(undefined);
    });

    it('the proven txid is persisted on the row (doge_anchor_txid)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeReceiver([]);
        const me = pub.identity.getPubkeyHex().toLowerCase();
        pub._deferRewardAttestation({
            chain: CP_ROW.chain, network: CP_ROW.network,
            blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
            txid: TXID, anchorVersion: 4,
            rewardType: 'anchor_' + CP_ROW.chain, roundReference: CP_ROW.checkpoint_seq,
            snapshotBlock: CP_ROW.snapshot_block, publisher: me,
            attestSigs: [{ pubkey: me, sig: 'ef'.repeat(64) }]
        });
        pub._indexerCall = async () => onChain();
        await pub._drainDeferredRewardAttest();
        const ins = inserts(queries)[0];
        expect(ins.sql).to.contain('doge_anchor_txid');
        expect(ins.params[8]).to.equal(TXID);
    });

    it('a receiver queues a quorum-valid message and writes it only once IT proves the anchor mined', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub, queries, sent } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        // A 2-member set needs both signatures: the relayer's and this receiver's own.
        await pub._handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer, pub.identity]) });
        expect(pub._deferredRewardAttest.size, 'queued behind its own mined-anchor proof').to.equal(1);
        expect(inserts(queries).length, 'nothing written on receipt alone').to.equal(0);

        pub._indexerCall = async () => onChain();
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length, 'written once this hub proved the anchor itself').to.equal(1);
        expect(sent.filter(m => m.type === XANCREWARD).length, 'a receiver never re-broadcasts').to.equal(0);
    });

    it('a receiver writes NOTHING when its own DOGE view cannot confirm the anchor', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub, queries } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        await pub._handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer, pub.identity]) });
        expect(pub._deferredRewardAttest.size, 'the quorum was valid, so it queued').to.equal(1);
        pub._indexerCall = async () => ({ exists: false, checkpoint_anchored: false });
        await pub._drainDeferredRewardAttest();
        expect(inserts(queries).length).to.equal(0);
    });

    it('below the derive gate a receiver ignores the message entirely', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub, queries } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        await pub._handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
        expect(queries.length).to.equal(0);
    });

    it('refuses a message whose XANCPUB quorum does not verify against the RECEIVER\'s own set', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const outsider = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        // The relayer is a member, but the only attestation signature belongs to a
        // non-member: a quorum the receiver's own oracle_publish set does not support.
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        const d = payloadFrom(pub, relayer, [outsider]);
        await pub._handleRewardAttestation({ data: d });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a message relayed by a non-member (no free verification work for outsiders)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const outsider = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([]);                       // outsider is NOT in the set
        await pub._handleRewardAttestation({ data: payloadFrom(pub, outsider, [outsider]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a message crediting a publisher outside the receiver\'s oracle_publish set', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        await pub._handleRewardAttestation({
            data: payloadFrom(pub, relayer, [relayer], { publisher: 'cd'.repeat(32) })
        });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a message whose transport signature does not verify (a tampered tuple)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        const d = payloadFrom(pub, relayer, [relayer]);
        d.round_reference = d.round_reference + 1;              // signed over the ORIGINAL tuple
        await pub._handleRewardAttestation({ data: d });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('refuses a malformed txid, an unattested ANCHOR version, and a mismatched reward_type', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        for (const over of [{ doge_anchor_txid: 'nope' }, { anchor_version: 0 }, { reward_type: 'anchor_LTC' }]) {
            await pub._handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer], over) });
            expect(pub._deferredRewardAttest.size, JSON.stringify(over)).to.equal(0);
        }
    });

    it('refuses to act on an unresolved oracle_publish set (fail closed)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        pub._resolveCapabilitySet = async () => [];
        await pub._handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    // reward_type and anchor_version were validated INDEPENDENTLY, so a cross-paired
    // tuple got in: v6 is the archive leg and v4/v5 the per-chain leg, and the BTC
    // derive path (indexer anchor_proof_client._judge) enforces that pairing forever.
    // A cross-paired row passes the drain's byte-match (an archive head wraps the same
    // checkpoint, so the four core hashes agree) and lands permanently in an
    // append-only table the derive path then rejects: a stranded credit, not a mint.
    it('refuses a reward_type cross-paired with the other leg\'s anchor_version', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const relayer = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const { pub } = makeReceiver([relayer.getPubkeyHex().toLowerCase()]);
        for (const over of [{ anchor_version: 6 },                                  // per-chain leg on an archive version
                            { reward_type: 'anchor_archive', anchor_version: 4 },   // archive leg on a per-chain version
                            { reward_type: 'anchor_archive', anchor_version: 5 }]) {
            await pub._handleRewardAttestation({ data: payloadFrom(pub, relayer, [relayer], over) });
            expect(pub._deferredRewardAttest.size, JSON.stringify(over)).to.equal(0);
        }
    });

    it('ignores its own broadcast echoing back', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub } = makeReceiver([]);
        await pub._handleRewardAttestation({ data: payloadFrom(pub, pub.identity, [pub.identity]) });
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('the transport canonical is tagged so it can never be replayed as an attestation signature', function () {
        const { pub } = makeReceiver([]);
        const d = { chain: 'BTC', network: 'regtest', reward_type: 'anchor_BTC', round_reference: 7,
                    snapshot_block: 100, publisher: 'ab'.repeat(32), doge_anchor_txid: TXID,
                    anchor_version: 4, block_index: 494, checkpoint_seq: 7 };
        expect(pub._rewardFederationCanonical(d)).to.equal(
            'XANCREWARD|BTC|regtest|anchor_BTC|7|100|' + 'ab'.repeat(32) + '|' + TXID + '|4|494|7');
    });
});
