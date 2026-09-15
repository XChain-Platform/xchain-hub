/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * CrossChainBridgeEngine: the XBRIDGE transfer record and the XPOLICY token
 * policy snapshot. Covers the two signed canonicals and their id preimages, the
 * activation gates, the issuer-raised confirmation depth, independent follower
 * re-verification, the fail-closed write path, the fenced retraction and the
 * invariant read.
 *
 * The canonicals and the id preimages are CONSENSUS: an indexer rebuilds them
 * byte for byte from the mirrored row to verify the quorum's signatures, so the
 * assertions here spell the strings out in full rather than re-deriving them
 * from the code under test (a test that calls the same builder proves only that
 * the builder is deterministic).
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const crypto     = require('crypto');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const Database               = require('../../../../src/db');
const eq                     = require('../../../../src/equivocation_header.js');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// A Database carrying the REAL bridge methods over a recording driver, so the
// column lists, the INSERT IGNORE and the retracted-row revive are exercised as
// written instead of being stubbed away.
function memDb(){
    const calls = [];
    const state = { insertAffected: 1, reviveAffected: 0, pairs: [], inflight: [], seq: 0, atSeq: null,
                    exists: false, rows: [], sourceTransferId: null, persistedIndexes: [] };
    const db = Object.create(Database.prototype);
    db.calls = calls;
    db.state = state;
    db.doQuery = async function(sql, params){
        calls.push({ sql, params: params || [] });
        if(sql.startsWith('INSERT IGNORE INTO bridge_transfers')) return { affectedRows: state.insertAffected };
        if(sql.startsWith("UPDATE bridge_transfers SET status = 'finalized'")) return { affectedRows: state.reviveAffected };
        if(sql.startsWith('INSERT IGNORE INTO policy_snapshots')) return { affectedRows: state.insertAffected };
        if(sql.startsWith('SELECT MAX(policy_seq)')) return [{ seq: state.seq }];
        if(sql.startsWith('SELECT snapshot_id, policy_hash')) return state.atSeq ? [state.atSeq] : [];
        if(sql.startsWith('SELECT DISTINCT tick, src_chain, dest_chain')) return state.pairs;
        if(sql.startsWith('SELECT tick, dest_chain, amount FROM bridge_transfers')) return state.inflight;
        if(sql.startsWith('SELECT 1 FROM bridge_transfers')) return state.exists ? [{ 1: 1 }] : [];
        // The per-poll persisted-leg read answers with the intersection of what was asked
        // for and what the test says is held, the way the IN (...) does.
        if(sql.startsWith('SELECT src_action_index FROM bridge_transfers'))
            return state.persistedIndexes.filter(i => params.slice(2).includes(i)).map(i => ({ src_action_index: i }));
        // Both getBridgeTransferIdForSource and retractTransfersForReorg's SELECT share the
        // 'SELECT transfer_id FROM bridge_transfers WHERE' prefix; distinguish by the clause
        // each one actually builds (network = ? is the source-leg reader, status = 'finalized'
        // is the retraction scan) rather than by the shared prefix alone.
        if(sql.startsWith("SELECT transfer_id FROM bridge_transfers WHERE network = ?"))
            return state.sourceTransferId ? [{ transfer_id: state.sourceTransferId }] : [];
        if(sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE')) return state.rows;
        if(sql.startsWith("UPDATE bridge_transfers SET status = 'retracted'")) return { affectedRows: 1 };
        if(sql.startsWith('SELECT * FROM bridge_transfers WHERE transfer_id')) return [{ transfer_id: params[0] }];
        if(sql.startsWith('SELECT * FROM policy_snapshots WHERE snapshot_id')) return [{ snapshot_id: params[0] }];
        return [];
    };
    db.getChainTip = async () => ({ chainId: 'f'.repeat(64) });
    return db;
}

function makeEngine(opts){
    opts = opts || {};
    const db = memDb();
    const broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub(), dropAllForResync: sinon.stub() };
    const hub = {
        db,
        network: opts.network || 'regtest',
        p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge', LTC_INDEXER_URL: 'http://ltc' },
        hubDbBroadcaster: broadcaster,
        capabilitySnapshot: {
            async getSnapshot(){ return { validators: [{ pubkey: 'a'.repeat(64), amount: '1' }] }; },
            async getWeightSnapshot(){
                return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }], count: 1, sourceCount: 1 };
            }
        },
        getPeerManager: () => null,
        getIdentity:    () => null,
        _resolveBtcLatestBlock: async () => (opts.btcBlock === undefined ? 150 : opts.btcBlock)
    };
    const engine = new CrossChainBridgeEngine(hub);
    // Never gossip or run a real round in a unit test.
    const stubConsensus = () => ({ propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(),
                                   on: () => {}, forgetFinalized: sinon.stub() });
    engine.transferConsensus = stubConsensus();
    engine.policyConsensus   = stubConsensus();
    // The flag-day twins ARE vendored beside the engine, so the real predicates load and a
    // regtest hub is armed at every height. Replace them anyway: a unit test that wants an
    // armed gate must say so, and `gates: false` must mean the twin is UNREADABLE (both
    // predicates null), which is the fail-closed case, not merely "not yet reached".
    engine.activation = (opts.gates === false)
        ? { bridge: null, token: null, policy: null }
        : {
            bridge: () => opts.bridgeActive !== false,
            token:  () => opts.tokenActive  !== false,
            policy: () => opts.policyActive !== false
        };
    return { engine, db, broadcaster, hub };
}

// A getpendingbridgetransfers leg, the seam's PendingBridgeTransfer shape.
function pendingLeg(over){
    return Object.assign({
        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: 41,
        src_address: 'mSrcAddress', dest_chain: 'DOGE', dest_address: 'nDestAddress',
        tick: 'XCHAIN', decimals: 8, amount: '5.00000000', min_depth: 0,
        block_index: 100, confirmations: 6, tx_hash: 'd'.repeat(64), push_generation: 0
    }, over);
}

const feature7policySnapshotsALLOW = null;
const feature7policySnapshotsBLOCK = ['nBlockedOne', 'nBlockedTwo'];
function feature7policySnapshotsWithPolicy(engine, over) {
  const policy = Object.assign({
    allow_list: feature7policySnapshotsALLOW,
    block_list: feature7policySnapshotsBLOCK,
    sleeping: false,
    bridged: true,
    origin_block: 900
  }, over || {});
  if (policy.policy_hash === undefined) policy.policy_hash = engine.policyHash(policy.allow_list, policy.block_list, policy.sleeping);
  engine._indexerCall = sinon.stub().callsFake(async (coin, method) => {
    if (method === 'getlatestblock') return {
      block_index: 906
    };
    if (method === 'gettokenpolicy') return policy;
    return null;
  });
  return policy;
}
function registerFeature7policySnapshotsPart1() {
  it('signs the first snapshot of a token at seq 1 with the membership as transport', async function () {
    const {
      engine
    } = makeEngine();
    const policy = feature7policySnapshotsWithPolicy(engine);
    engine._tickOrigin.set('regtest|FUFU', 'BTC');
    await engine.maybeSnapshotPolicy({
      origin_chain: 'BTC',
      tick: 'FUFU',
      copies: new Set(['DOGE'])
    }, 'regtest', 150);
    const [roundId, ctx] = engine.policyConsensus.propose.firstCall.args;
    expect(ctx.row.policy_seq).to.equal(1);
    expect(ctx.row.origin_block).to.equal(900); // 906 tip minus BTC depth 6
    expect(ctx.row.policy_hash).to.equal(policy.policy_hash);
    expect(ctx.row.allow_list).to.equal(null);
    expect(JSON.parse(ctx.row.block_list)).to.deep.equal(feature7policySnapshotsBLOCK);
    expect(roundId).to.equal(sha256('regtest|BTC:FUFU|1|150'));
  });
  it('signs nothing when the policy has not changed, and seq+1 when it has', async function () {
    const {
      engine,
      db
    } = makeEngine();
    const policy = feature7policySnapshotsWithPolicy(engine);
    db.state.seq = 4;
    db.state.atSeq = {
      policy_hash: policy.policy_hash
    };
    await engine.maybeSnapshotPolicy({
      origin_chain: 'BTC',
      tick: 'FUFU',
      copies: new Set()
    }, 'regtest', 150);
    expect(engine.policyConsensus.propose.called).to.equal(false);
    db.state.atSeq = {
      policy_hash: 'a'.repeat(64)
    };
    await engine.maybeSnapshotPolicy({
      origin_chain: 'BTC',
      tick: 'FUFU',
      copies: new Set()
    }, 'regtest', 150);
    expect(engine.policyConsensus.propose.firstCall.args[1].row.policy_seq).to.equal(5);
  });
}
function registerFeature7policySnapshotsPart2() {
  it('declines to sign a membership over XPOLICY_MAX_MEMBERS', async function () {
    const {
      engine
    } = makeEngine();
    const big = [];
    for (let i = 0; i < 10001; i++) big.push('addr' + String(i).padStart(6, '0'));
    feature7policySnapshotsWithPolicy(engine, {
      block_list: big
    });
    await engine.maybeSnapshotPolicy({
      origin_chain: 'BTC',
      tick: 'FUFU',
      copies: new Set()
    }, 'regtest', 150);
    expect(engine.policyConsensus.propose.called).to.equal(false);
  });
  it('declines to sign when the indexer answer does not hash to its own policy_hash', async function () {
    const {
      engine
    } = makeEngine();
    feature7policySnapshotsWithPolicy(engine, {
      policy_hash: 'b'.repeat(64)
    });
    await engine.maybeSnapshotPolicy({
      origin_chain: 'BTC',
      tick: 'FUFU',
      copies: new Set()
    }, 'regtest', 150);
    expect(engine.policyConsensus.propose.called).to.equal(false);
  });
  it('declines to sign an out-of-canonical-order membership rather than re-sorting it', async function () {
    const {
      engine
    } = makeEngine();
    feature7policySnapshotsWithPolicy(engine, {
      block_list: ['nZ', 'nA'],
      policy_hash: undefined
    });
    await engine.maybeSnapshotPolicy({
      origin_chain: 'BTC',
      tick: 'FUFU',
      copies: new Set()
    }, 'regtest', 150);
    expect(engine.policyConsensus.propose.called).to.equal(false);
  });
}
function registerFeature7policySnapshotsPart3() {
  it('abstains, never refuses, when its origin indexer read fails', async function () {
    const {
      engine
    } = makeEngine();
    engine._indexerCall = sinon.stub().rejects(new Error('ECONNREFUSED'));
    await engine.maybeSnapshotPolicy({
      origin_chain: 'BTC',
      tick: 'FUFU',
      copies: new Set()
    }, 'regtest', 150);
    expect(engine.policyConsensus.propose.called).to.equal(false);
  });
}
function feature7policySnapshotsNested7ProposedPolicy(engine, over) {
  const now = Math.floor(Date.now() / 1000);
  const hash = engine.policyHash(feature7policySnapshotsALLOW, feature7policySnapshotsBLOCK, false);
  const row = Object.assign({
    snapshot_block: 150,
    network: 'regtest',
    origin_chain: 'BTC',
    tick: 'FUFU',
    policy_seq: 1,
    origin_block: 900,
    policy_hash: hash,
    allow_list: null,
    block_list: JSON.stringify(feature7policySnapshotsBLOCK),
    sleeping: 0,
    effective_time: now + 2400
  }, over);
  row.snapshot_id = over && over.snapshot_id ? over.snapshot_id : engine.deriveSnapshotId(row.network, row.origin_chain, row.tick, row.policy_seq, row.snapshot_block);
  return row;
}
function registerFeature7policySnapshotsNested7Part1() {
  it('co-signs a snapshot its own read at the same origin_block reproduces', async function () {
    const {
      engine
    } = makeEngine();
    feature7policySnapshotsWithPolicy(engine);
    expect(await engine.validateProposedMatch(feature7policySnapshotsNested7ProposedPolicy(engine))).to.equal(true);
  });
  it('refuses when its own read at the same origin_block yields a different hash', async function () {
    const {
      engine
    } = makeEngine();
    feature7policySnapshotsWithPolicy(engine, {
      block_list: ['nOther'],
      policy_hash: undefined
    });
    expect(await engine.validateProposedMatch(feature7policySnapshotsNested7ProposedPolicy(engine))).to.equal(false);
  });
  it('refuses transport arrays that do not hash to the agreed policy_hash', async function () {
    const {
      engine
    } = makeEngine();
    feature7policySnapshotsWithPolicy(engine);
    expect(await engine.validateProposedMatch(feature7policySnapshotsNested7ProposedPolicy(engine, {
      block_list: JSON.stringify(['nBlockedOne'])
    }))).to.equal(false);
    feature7policySnapshotsWithPolicy(engine);
    expect(await engine.validateProposedMatch(feature7policySnapshotsNested7ProposedPolicy(engine, {
      block_list: 'not json'
    }))).to.equal(false);
  });
  it('refuses a second content at a seq it already finalized (that is equivocation)', async function () {
    const {
      engine,
      db
    } = makeEngine();
    feature7policySnapshotsWithPolicy(engine);
    db.state.atSeq = {
      policy_hash: 'd'.repeat(64)
    };
    expect(await engine.validateProposedMatch(feature7policySnapshotsNested7ProposedPolicy(engine))).to.equal(false);
  });
  it('refuses a snapshot_id that does not re-derive', async function () {
    const {
      engine
    } = makeEngine();
    feature7policySnapshotsWithPolicy(engine);
    expect(await engine.validateProposedMatch(feature7policySnapshotsNested7ProposedPolicy(engine, {
      snapshot_id: 'e'.repeat(64)
    }))).to.equal(false);
  });
}
function registerFeature7policySnapshotsNested7Part2() {
  it('refuses every policy round while the inheritance gate is closed', async function () {
    const {
      engine
    } = makeEngine({
      policyActive: false
    });
    feature7policySnapshotsWithPolicy(engine);
    expect(await engine.validateProposedMatch(feature7policySnapshotsNested7ProposedPolicy(engine))).to.equal(false);
  });
}
function registerFeature7policySnapshotsNested7() {
  describe('follower verification', function () {
    registerFeature7policySnapshotsNested7Part1();
    registerFeature7policySnapshotsNested7Part2();
  });
}
function registerFeature7policySnapshots() {
  describe('policy snapshots', function () {
    registerFeature7policySnapshotsPart1();
    registerFeature7policySnapshotsPart2();
    registerFeature7policySnapshotsPart3();
    registerFeature7policySnapshotsNested7();
  });
}
describe('CrossChainBridgeEngine', function () {
  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------
  registerFeature7policySnapshots();
});
