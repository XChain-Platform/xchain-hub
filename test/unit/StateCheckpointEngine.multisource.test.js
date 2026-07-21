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

//  multi-source-pubkey checkpoint/anchor family. Every defect here manifests
// ONLY at/above STAKE_WEIGHTED_QUORUM and ONLY when a signing key is delegated by two
// or more stake sources (the weighted snapshot then emits one row per (source, pubkey)).
// regtest activation is 0, so a scoped regtest engine is always in weighted mode: the
// natural venue for a forced-above-SWQ, two-source scenario. Each `it` pins one of the
// five ratified behaviors (2647 election, 2648 archive verifier, 2649 network gate,
// 2650 mirror persist, 2651 self-sign).

const { expect }              = require('chai');
const StateCheckpointEngine   = require('../../src/StateCheckpointEngine');
const StateAnchorPublisher    = require('../../src/StateAnchorPublisher');
const ValidatorIdentity       = require('../../src/ValidatorIdentity');
const swq                     = require('../../src/stake_weighted_quorum');
const { resolveQuorumNetwork } = require('../../src/lib/quorum_network');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TIP = {
    block_index: 500, block_hash: 'c0'.repeat(32), network: 'regtest',
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

// In-memory hub DB that mirrors the WIDENED capability_snapshots uniqueness
// (snapshot_block, capability, signing_pubkey, source) and the source-aware
// select-back, so a key delegated by two sources keeps BOTH rows.
function memDb() {
    let checkpoints = [];
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
                if (!checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq))
                    checkpoints.push({ id: checkpoints.length + 1, chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures });
                return [];
            }
            if (sql.startsWith('SELECT * FROM state_checkpoints')) {
                return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1);
            }
            if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                let [snapshot_block, capability, signing_pubkey, amount, source] = params;
                source = source != null ? source : '';
                // Widened key: dedupe on all four columns, so two source rows persist.
                if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey && r.source === source))
                    snapshots.push({ id: snapshots.length + 1, snapshot_block, capability, signing_pubkey, amount, source });
                return [];
            }
            if (sql.startsWith('SELECT * FROM capability_snapshots')) {
                // Source-aware select-back (params: block, capability, pubkey, source).
                return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] &&
                                             r.signing_pubkey === params[2] && r.source === params[3]).slice(0, 1);
            }
            return [];
        }
    };
}

// Single scoped (network='regtest') hub engine: always weighted (regtest SWQ = 0).
// weightSnapshot is the { validators, truncated? } object getWeightSnapshot returns.
function buildEngine(weightSnapshot, opts) {
    opts = opts || {};
    let identity = new ValidatorIdentity(opts.privkey || '11'.repeat(32));
    let broadcasts = [];
    let peerManager = { on() {}, removeListener() {}, broadcast() {} };
    let db = memDb();
    let hub = {
        db,
        network: 'regtest',
        p2pConfig: {
            CHECKPOINT_CHAINS: 'BTC',
            CHECKPOINT_CONFIRMATIONS: '0',
            BTC_INDEXER_URL: 'http://stub', LTC_INDEXER_URL: 'http://stub', DOGE_INDEXER_URL: 'http://stub'
        },
        hubDbBroadcaster: { rows: broadcasts, broadcastRow(ev) { this.rows.push(ev); } },
        capabilitySnapshot: {
            async getWeightSnapshot() { return weightSnapshot; },
            async getSnapshot() { return { validators: (weightSnapshot.validators || []).map(v => ({ pubkey: v.pubkey, amount: v.weight })) }; }
        },
        getPeerManager: () => peerManager,
        getIdentity: () => identity,
        _resolveBtcLatestBlock: async () => (opts.btcBlock != null ? opts.btcBlock : 100)
    };
    let engine = new StateCheckpointEngine(hub);
    engine._indexerCall = async () => Object.assign({}, TIP);
    let finalized = [];
    engine.on('checkpoint:finalized', (ev) => finalized.push(ev));
    return { engine, identity, db, hub, broadcasts, finalized, pubkey: identity.getPubkeyHex().toLowerCase() };
}

describe(' multi-source pubkey (checkpoint/anchor family)', function () {

    let engines = [];
    afterEach(async function () { for (let e of engines) { try { await e.stop(); } catch (_) {} } engines = []; });

    // 2651 + 2647: a single-validator federation whose one key is delegated by TWO
    // sources self-signs and finalizes a checkpoint at an ODD cadence block. Pre-fix the
    // raw (non-deduped) election list had length 2, so `btcBlock % 2` at an odd block
    // landed on the duplicate's slot and NO hub elected itself leader (2647 skipped
    // round); and even as leader the snapCount<=1 self-sign fast path was lost, stalling
    // on a stake quorum one key can never reach across two sources (2651).
    it('single-validator two-source federation self-signs at an odd block (2647 + 2651)', async function () {
        let PK = new ValidatorIdentity('22'.repeat(32)).getPubkeyHex().toLowerCase();
        // Build with THIS pubkey as the sole validator, two sources.
        let ctx = buildEngine({ validators: [
            { pubkey: PK, source: 'srcA', weight: '100' },
            { pubkey: PK, source: 'srcB', weight: '100' }
        ], truncated: false }, { privkey: '22'.repeat(32), btcBlock: 101 });   // 101 is odd
        engines.push(ctx.engine);

        await ctx.engine.start();
        await ctx.engine._tick();
        await sleep(30);

        expect(ctx.db.checkpoints.length, 'checkpoint produced (round not skipped, no stall)').to.equal(1);
        let sigs = JSON.parse(ctx.db.checkpoints[0].validator_signatures);
        expect(sigs.length, 'self-signed').to.equal(1);
        expect(sigs[0].pubkey).to.equal(PK);
        let canon = StateCheckpointEngine.canonicalCheckpoint(ctx.finalized[0].checkpoint);
        expect(ValidatorIdentity.verify(canon, sigs[0].sig, sigs[0].pubkey)).to.be.true;
        expect(ctx.engine.pending.size, 'no pending round left hanging (no stall/timeout)').to.equal(0);
    });

    // 2650: _persistCapabilitySnapshot writes BOTH (source, pubkey) rows AND streams
    // BOTH to the mirror. Pre-fix the pubkey-only select-back (LIMIT 1) surfaced only one
    // source to the downstream indexer.
    it('both source rows persist and survive the mirror (2650)', async function () {
        let PK = new ValidatorIdentity('33'.repeat(32)).getPubkeyHex().toLowerCase();
        let ctx = buildEngine({ validators: [
            { pubkey: PK, source: 'srcA', weight: '100' },
            { pubkey: PK, source: 'srcB', weight: '250' }
        ], truncated: false });
        engines.push(ctx.engine);

        await ctx.engine._persistCapabilitySnapshot('oracle_publish', 970000);

        let rows = ctx.db.snapshots.filter(r => r.capability === 'oracle_publish' && r.snapshot_block === 970000);
        expect(rows.length, 'both source rows persisted').to.equal(2);
        expect(rows.map(r => r.source).sort()).to.deep.equal(['srcA', 'srcB']);

        let mirrored = ctx.broadcasts.filter(b => b.table === 'capability_snapshots');
        expect(mirrored.length, 'both rows streamed to the mirror').to.equal(2);
        expect(mirrored.map(b => b.row.source).sort()).to.deep.equal(['srcA', 'srcB']);
    });

    // 2648: the archive verifier accepts an archive whose capability_snapshots group
    // holds a multi-source key. Pre-fix it keyed the group map on pubkey alone, so two
    // source rows collapsed to one, archived.size (1) != resolved.length (2), and every
    // such archive was rejected (the co-sign stall).
    it('an archive containing a multi-source key co-signs (2648)', async function () {
        let PK = new ValidatorIdentity('44'.repeat(32)).getPubkeyHex().toLowerCase();
        let hub = {
            db: { async doQuery() { return []; } },
            network: 'regtest',
            capabilitySnapshot: { async getSnapshot() { return null; }, async getWeightSnapshot() { return null; } },
            getIdentity: () => null, getPeerManager: () => null, p2pConfig: {},
            rewardTracker: null
        };
        let pub = new StateAnchorPublisher(hub);
        // Both the archived rows and our own resolution carry the two source rows.
        pub._resolveCapabilitySet = async () => [
            { pubkey: PK, amount: '100', source: 'srcA' },
            { pubkey: PK, amount: '100', source: 'srcB' }
        ];
        let archive = {
            matches: [], calls: [], rewards: [],
            capability_snapshots: [
                { snapshot_block: 970000, capability: 'oracle_publish', signing_pubkey: PK, amount: '100', source: 'srcA' },
                { snapshot_block: 970000, capability: 'oracle_publish', signing_pubkey: PK, amount: '100', source: 'srcB' }
            ]
        };
        let ok = await pub._verifyArchiveAgainstLocal(archive);
        expect(ok, 'multi-source archive snapshot group verifies').to.be.true;

        // Control: a genuinely divergent archived set (a source we did not resolve) is
        // still rejected, proving the widened key did not weaken the check.
        archive.capability_snapshots[1].source = 'srcWRONG';
        let bad = await pub._verifyArchiveAgainstLocal(archive);
        expect(bad, 'a mismatched source is still rejected').to.be.false;
    });

    // 2649: an unscoped-network hub (this.network === '') routed through
    // resolveQuorumNetwork reaches the SAME weighted-vs-count verdict as the indexer,
    // which gates on the record's NETWORK (anchor.js: data['NETWORK']). Pre-fix the hub
    // gated on this.network (''), so it declared count quorum where the indexer applied
    // the stake predicate: a live-vs-recovered reward fork.
    it('an unscoped hub reaches the same quorum verdict as the indexer (2649)', function () {
        const DEPLOY = '';   // unscoped hub
        for (const cp of [ { network: 'mainnet', snapshot_block: 961000 },   // at activation -> weighted
                           { network: 'mainnet', snapshot_block: 960999 },   // one below      -> count
                           { network: 'regtest', snapshot_block: 5 } ]) {    // regtest active 0 -> weighted
            // Indexer's record-scoped decision (anchor.js gates on the record NETWORK).
            let indexerVerdict = swq.isStakeWeightedQuorumActive(cp.snapshot_block, cp.network);
            // Hub, routed: gate on resolveQuorumNetwork(record, deployment).
            let hubVerdict = swq.isStakeWeightedQuorumActive(cp.snapshot_block, resolveQuorumNetwork(cp, DEPLOY));
            expect(hubVerdict, 'hub matches indexer for ' + cp.network + '@' + cp.snapshot_block).to.equal(indexerVerdict);
        }
        // And the fix is load-bearing: the OLD gate (deployment network '') diverges from
        // the indexer for a mainnet record above SWQ.
        let old = swq.isStakeWeightedQuorumActive(961000, DEPLOY);
        expect(old, 'the unrouted deployment-network gate is the bug').to.equal(false);
        expect(swq.isStakeWeightedQuorumActive(961000, 'mainnet'), 'indexer says weighted').to.equal(true);
    });
});
