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

// The multi-hub mesh harness for the StateAnchorPublisher suites: n publishers
// over a shared in-process gossip bus, each with its own in-memory DB seeded
// from the same rows, an honest on-chain ANCHOR oracle, and election helpers
// mirroring the publisher's hash ordering. Mesh harness mirrors
// StateCheckpointEngine.test.js. The row fixtures and the DB stand-in live in
// anchor_mesh_db.js and are re-exported here.

const os                   = require('os');
const path                 = require('path');
const StateAnchorPublisher = require('../../src/anchor/publisher');
const ValidatorIdentity    = require('../../src/validators/identity');
const arMod                = require('../../src/consensus/gates/anchor_reward_gate.js');
const meshDb               = require('./anchor_mesh_db.js');

const { CP_ROW, matchRow, matchCanonical, callCanonical, parseV7Sections, memDb } = meshDb;

// Every mesh built since the last stopMeshes(), so a suite's afterEach can stop
// every publisher a case started.
let buses = [];

// One node's gossip endpoint: broadcast delivers to every other node's handler.
function makePeerManager(self, bus) {
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
    return peerManager;
}

// One node's DB copy: the base checkpoint at the record network, the match and
// call rows signed by a mesh quorum, and any pending reward rows.
function seedNodeDb(opts, identities, n, recordNetwork) {
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
    return db;
}

// The hub a mesh node's publisher is built on: its DB, config, capability set,
// gossip endpoint, identity and reward tracker.
function makeNodeHub(self, db, opts, identity, validators, n, peerManager) {
    let hub = {
        db,
        // DOGE_INDEXER_URL wired so verifyAnchorOnChain runs its real gate;
        // the indexerCall stub below (installed per node) answers
        // getanchoraction from the node's OWN checkpoint rows, i.e. the
        // honest case (the on-chain anchor byte-matches the local checkpoint
        // at full depth). Adversarial receiver-path tests override the stub.
        p2pConfig: Object.assign({ ANCHOR_INTERVAL_MS: '3600000', DOGE_INDEXER_URL: 'http://doge-indexer.test' }, opts.cfg || {}),
        capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } },
        // Populated oracle_publish registry: the V0_DONE/FINALIZED handlers resolve
        // the membership set via getActiveOraclePublishPubkeys(null), which now falls
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
        resolveBtcLatestBlock: async () => (opts.btcBlock != null ? opts.btcBlock : 100)
    };
    return hub;
}

// Default on-chain ANCHOR oracle: answer getanchoraction from this
// node's own checkpoint rows so the honest receiver path (V0_DONE /
// FINALIZED for a checkpoint this node actually holds) verifies at full depth.
// Returns exists:false for an unknown checkpoint (the phantom-txid case).
//
// Models the HONEST case for the txid/version filter: the announced txid IS
// the transaction the anchor landed in, and the requested version is the one
// on-chain, so the row is echoed back bound to whatever the caller asked for.
// Adversarial receiver-path tests override this stub to return a different
// txid (forge), checkpoint_anchored, or no txid at all (stale indexer).
function honestAnchorOracle(self, db, bus) {
    return async (coin, method, params) => {
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
}

// The broadcast hook records what a node published and models mining.
function miningBroadcastHook(self, bus) {
    return async (payload) => {
        self.published.push(payload);
        // Model mining: a broadcast CHECKPOINT anchor (v0) becomes visible to
        // every node's getanchoraction stub (bus.onchain), one entry per SECTION,
        // because that is the granularity getanchoraction answers at.
        let f = String(payload).split('|');
        if (f[0] === 'ANCHOR' && f[1] === '0') {
            for (let sec of parseV7Sections(payload))
                bus.onchain.push({ chain: sec.chain, network: f[2], block_index: sec.block_index });
        }
        // Record what version this txid actually is, so a version-SET lookup
        // (the #4180 archive-head gate) gets the truth rather than a default.
        // v2 continuation chunks are excluded: they are not an anchor HEAD.
        if (f[0] === 'ANCHOR' && f[1] !== '2')
            bus.anchorVersions.set('txid' + self.published.length, Number(f[1]));
        return { txid: 'txid' + self.published.length };
    };
}

// Stake-weighted quorum setup. The attestation-bearing payloads (v0/v1) can
// only be produced at/above the anchor/archive reward flag-day, which on every
// network activates at or above the SWQ height (mainnet 961000/963000, regtest 0),
// so a round that emits them ALWAYS runs on the weighted quorum path - there is no
// count-path snapshot_block for them. Scope each hub to the record network so
// resolveCapabilitySet (which keys on this.network) resolves the WEIGHTED,
// source-keyed snapshot the round's stake tally needs, and back it with one
// distinct source per validator at equal weight: the 2/3-stake bar then coincides
// exactly with the 2f+1 count these tests assert (3-of-4), so the quorum-size
// assertions are unchanged - only the tally MECHANISM the fix now selects differs.
function applyStakeWeights(bus, recordNetwork) {
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
    // mainnet SWQ activation (961000, per src/consensus/stake_weighted_quorum.js), the gate
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
        let peerManager = makePeerManager(self, bus);
        let db = seedNodeDb(opts, identities, n, recordNetwork);
        if (opts.mutate) opts.mutate(self, db);
        let hub = makeNodeHub(self, db, opts, identity, validators, n, peerManager);
        self.db  = db;
        self.pub = new StateAnchorPublisher(hub);
        // start() arms the spend guard's durable window, so point it
        // at a per-node temp file the way this suite already points queuePath and
        // walPath. Left on its ./data default, every mesh node in every run wrote
        // into the checkout and the NEXT run inherited the spends, which reddens
        // this file once an hour of runs adds up to the window budget.
        self.pub.spendGuard.statePath = path.join(
            os.tmpdir(), 'anchor-spend-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.json');
        self.pub.indexerCall = honestAnchorOracle(self, db, bus);
        self.pub.setBroadcastHook(miningBroadcastHook(self, bus));
        bus.nodes.push(self);
    }
    if (opts.stakeWeighted) applyStakeWeights(bus, recordNetwork);
    buses.push(bus);
    return bus;
}

// Election helpers mirroring the publisher's hash-ordering (different key
// per pending checkpoint, one per election block for the archive round).
// The BUNDLE election order. One election per bundle, so the key binds only the
// network and the bundle's snapshot_block; the mesh's rows all share both.
function v0Order(bus, row) {
    row = row || Object.assign({}, CP_ROW, { network: bus.network });
    let key = 'XANCV7|' + (row.network || bus.network) + '|' + row.snapshot_block;
    let order = StateAnchorPublisher.hashOrder(key, bus.nodes.map(nd => nd.pubkey));
    return order.map(pk => bus.nodes.find(nd => nd.pubkey === pk));
}

// A signed XANC_BUNDLE_DONE for the mesh's own checkpoint rows. `sections` defaults
// to the single CP_ROW every node seeds; `signer` is the node whose identity signs.
function mkBundleDone(bus, signer, txid, sections) {
    sections = sections || [{ chain: CP_ROW.chain, block_index: CP_ROW.block_index,
                              checkpoint_seq: CP_ROW.checkpoint_seq }];
    let d = { network: bus.network, snapshot_block: CP_ROW.snapshot_block, txid: txid, sections: sections };
    d.sig_pubkey = signer.pubkey;
    d.sig = signer.identity.sign(signer.pub.bundleDoneCanonical(d, txid));
    return d;
}
function archiveOrder(bus, batchSeq) {
    // Wrapper-anchored key: the wrapper checkpoint identity (CP_ROW at the bus's
    // record network) and nothing else. Read from the publisher rather than
    // re-spelled here, so this helper cannot drift from the shipped key the way the
    // hardcoded copy did when the hub-local batch seq left the key.
    let key = bus.nodes[0].pub.archiveElectionKey(
        { chain: CP_ROW.chain, network: bus.network, checkpoint_seq: CP_ROW.checkpoint_seq }, batchSeq || 0);
    let order = StateAnchorPublisher.hashOrder(key, bus.nodes.map(nd => nd.pubkey));
    return order.map(pk => bus.nodes.find(nd => nd.pubkey === pk));
}
function archiveLeader(bus, batchSeq) {
    return archiveOrder(bus, batchSeq)[0];
}
async function startAll(bus) { for (let nd of bus.nodes) await nd.pub.start(); }
async function flushAll(bus) { for (let nd of bus.nodes) await nd.pub.flush(); }

// The mesh identity pubkey at index i (the derivation buildMesh uses), its
// deterministic source, and a pending anchor reward row credited to it.
const pkOf = (i) => new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64)).getPubkeyHex().toLowerCase();
const srcOf = (pk) => 'src_' + pk.substring(0, 12);
function rewardRow(pk, over) {
    return Object.assign({
        validator_pubkey: pk, round_number: 7, reward_type: 'anchor_BTC',
        amount: '10.00000000', block_index: 100, batch_seq: null
    }, over || {});
}

// Stop every publisher on every mesh built since the last call, then forget them.
async function stopMeshes() {
    for (let bus of buses) { for (let nd of bus.nodes) await nd.pub.stop(); }
    buses = [];
}

// These legacy v0/v1/v3 production tests exercise the PRE-anchor-reward-flag-day
// producer path (still real below the flag-day on mainnet, and as the degraded-
// federation fallback). Pin the regtest flag-day DORMANT here so the producer keeps
// emitting bundles with an empty attestation tail; the nested publisher-attestation
// suites re-activate it. save/restore keeps the toggle isolation-safe regardless
// of order.
let savedRegtestFlagDay, savedArchiveRegtestFlagDay;
function pinRewardFlagDaysDormant() {
    savedRegtestFlagDay        = arMod.ANCHOR_REWARD_ACTIVATION.regtest;
    savedArchiveRegtestFlagDay = arMod.ARCHIVE_REWARD_ACTIVATION.regtest;
    arMod.ANCHOR_REWARD_ACTIVATION.regtest  = 999999999;
    arMod.ARCHIVE_REWARD_ACTIVATION.regtest = 999999999;
}
function restoreRewardFlagDays() {
    arMod.ANCHOR_REWARD_ACTIVATION.regtest  = savedRegtestFlagDay;
    arMod.ARCHIVE_REWARD_ACTIVATION.regtest = savedArchiveRegtestFlagDay;
}

// The hooks every mesh suite shares: stop the meshes a case built, and pin the
// reward flag-days dormant around it. Called INSIDE a describe so the hooks
// belong to that suite and never register at mocha's root.
function registerMeshHooks() {
    afterEach(stopMeshes);
    beforeEach(pinRewardFlagDaysDormant);
    afterEach(restoreRewardFlagDays);
}

module.exports = {
    CP_ROW, matchRow, matchCanonical, callRow: meshDb.callRow, callCanonical,
    parseV7Sections, parseV7Tail: meshDb.parseV7Tail, memDb,
    buildMesh, v0Order, mkBundleDone, archiveOrder, archiveLeader, startAll, flushAll,
    pkOf, srcOf, rewardRow, registerMeshHooks, stopMeshes
};
