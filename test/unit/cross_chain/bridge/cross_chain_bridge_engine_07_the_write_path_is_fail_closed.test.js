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

function feature8theWritePathIsFailClosedFinalized(engine, over) {
  return Object.assign({
    transfer_id: 'b'.repeat(64),
    snapshot_block: 150,
    network: 'regtest',
    src_chain: 'BTC',
    src_action_index: 41,
    src_address: 'mSrc',
    dest_chain: 'DOGE',
    dest_address: 'nDest',
    tick: 'XCHAIN',
    decimals: 8,
    amount: '5.00000000',
    effective_time: 1757000000,
    push_generation: 0
  }, over);
}
function registerFeature8theWritePathIsFailClosedPart1() {
  it('writes and mirrors a finalized transfer once the capability snapshot is persisted', async function () {
    const {
      engine,
      db,
      broadcaster
    } = makeEngine();
    engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
    const row = feature8theWritePathIsFailClosedFinalized(engine);
    engine._inflight.add(row.transfer_id);
    await engine.writeFinalizedTransfer({
      row,
      signatures: [{
        pubkey: 'a',
        sig: 'b'
      }],
      view: 2
    });
    const insert = db.calls.find(c => c.sql.startsWith('INSERT IGNORE INTO bridge_transfers'));
    expect(insert, 'the record must be written').to.not.equal(undefined);
    // The signed content plus the two fences and the transport chain id.
    expect(insert.sql).to.contain('tick, decimals, amount');
    expect(insert.params[insert.params.length - 1]).to.equal('f'.repeat(64)); // btc_chain_id
    expect(row.finalizing_view).to.equal(2);
    expect(broadcaster.broadcastRow.calledWithMatch({
      table: 'bridge_transfers'
    })).to.equal(true);
    expect(engine._inflight.has(row.transfer_id)).to.equal(false);
  });
  it('writes NOTHING when the capability snapshot degrades to zero rows', async function () {
    const {
      engine,
      db,
      broadcaster
    } = makeEngine();
    engine._persistCapabilitySnapshot = sinon.stub().resolves(0);
    const row = feature8theWritePathIsFailClosedFinalized(engine);
    engine._inflight.add(row.transfer_id);
    await engine.writeFinalizedTransfer({
      row,
      signatures: [],
      view: 0
    });
    expect(db.calls.some(c => c.sql.startsWith('INSERT IGNORE INTO bridge_transfers'))).to.equal(false);
    expect(broadcaster.broadcastRow.called).to.equal(false);
    // Deferred, not retired: the next poll must be able to re-propose it.
    expect(engine._inflight.has(row.transfer_id)).to.equal(false);
    expect(engine.transferConsensus.forgetFinalized.calledWith(row.transfer_id)).to.equal(true);
  });
}
function registerFeature8theWritePathIsFailClosedPart2() {
  it('revives a retracted record rather than stranding a re-formed transfer', async function () {
    const {
      engine,
      db,
      broadcaster
    } = makeEngine();
    engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
    db.state.insertAffected = 0; // INSERT IGNORE no-ops against the retracted row
    db.state.reviveAffected = 1;
    await engine.writeFinalizedTransfer({
      row: feature8theWritePathIsFailClosedFinalized(engine),
      signatures: [],
      view: 0
    });
    const revive = db.calls.find(c => c.sql.startsWith("UPDATE bridge_transfers SET status = 'finalized'"));
    expect(revive, 'a retracted row must be revived').to.not.equal(undefined);
    expect(revive.sql).to.contain("status = 'retracted'");
    expect(broadcaster.broadcastRow.calledWithMatch({
      table: 'bridge_transfers'
    })).to.equal(true);
  });
  it('mirrors nothing on a duplicate finalize', async function () {
    const {
      engine,
      db,
      broadcaster
    } = makeEngine();
    engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
    db.state.insertAffected = 0;
    db.state.reviveAffected = 0; // the row is already 'finalized'
    await engine.writeFinalizedTransfer({
      row: feature8theWritePathIsFailClosedFinalized(engine),
      signatures: [],
      view: 0
    });
    expect(broadcaster.broadcastRow.called).to.equal(false);
  });
}
function registerFeature8theWritePathIsFailClosedPart3() {
  it('writes a finalized policy snapshot append-only, with no revive path', async function () {
    const {
      engine,
      db,
      broadcaster
    } = makeEngine();
    engine._persistCapabilitySnapshot = sinon.stub().resolves(1);
    const row = {
      snapshot_id: 'c'.repeat(64),
      snapshot_block: 150,
      origin_chain: 'BTC',
      tick: 'FUFU',
      policy_seq: 1,
      origin_block: 900,
      policy_hash: 'e'.repeat(64),
      allow_list: null,
      block_list: '["nA"]',
      sleeping: 0,
      effective_time: 1757000000,
      network: 'regtest',
      push_generation: 0
    };
    await engine.writeFinalizedPolicy({
      row,
      signatures: [],
      view: 0
    });
    expect(db.calls.some(c => c.sql.startsWith('INSERT IGNORE INTO policy_snapshots'))).to.equal(true);
    expect(db.calls.some(c => c.sql.startsWith("UPDATE policy_snapshots"))).to.equal(false);
    expect(broadcaster.broadcastRow.calledWithMatch({
      table: 'policy_snapshots'
    })).to.equal(true);
  });
}
function registerFeature8theWritePathIsFailClosed() {
  describe('the write path is fail-closed', function () {
    registerFeature8theWritePathIsFailClosedPart1();
    registerFeature8theWritePathIsFailClosedPart2();
    registerFeature8theWritePathIsFailClosedPart3();
  });
}
function registerFeature9fencedRetractionPart1() {
  it('retracts only the fenced, bounded source range and broadcasts the deletion', async function () {
    const {
      engine,
      db,
      broadcaster
    } = makeEngine();
    db.state.rows = [{
      transfer_id: 'b'.repeat(64)
    }];
    const n = await engine.retractTransfersForReorg('BTC', 40, 50, 3);
    expect(n).to.equal(1);
    const select = db.calls.find(c => c.sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE'));
    expect(select.sql).to.contain('src_action_index >= ?');
    expect(select.sql).to.contain('src_action_index <= ?');
    expect(select.sql).to.contain('push_generation <= ?');
    expect(select.params).to.deep.equal(['BTC', 40, 50, 3]);
    expect(broadcaster.broadcastDeletion.calledWithMatch({
      table: 'bridge_transfers',
      source_chain: 'BTC',
      from_action_index: 40,
      to_action_index: 50,
      retraction_generation: 3
    })).to.equal(true);
    expect(engine.transferConsensus.forgetFinalized.calledWith('b'.repeat(64))).to.equal(true);
  });
  it('omits the bound and the fence when the indexer sent neither', async function () {
    const {
      engine,
      db
    } = makeEngine();
    db.state.rows = [];
    await engine.retractTransfersForReorg('DOGE', 7);
    const select = db.calls.find(c => c.sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE'));
    expect(select.sql).to.not.contain('<=');
    expect(select.params).to.deep.equal(['DOGE', 7]);
  });
  it('fails closed on a supplied-but-invalid bound instead of widening the range', async function () {
    const {
      engine
    } = makeEngine();
    let threw = false;
    try {
      await engine.retractTransfersForReorg('BTC', 40, 10);
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
}
function registerFeature9fencedRetraction() {
  describe('fenced retraction', function () {
    registerFeature9fencedRetractionPart1();
  });
}
describe('CrossChainBridgeEngine', function () {
  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------
  registerFeature8theWritePathIsFailClosed();
  registerFeature9fencedRetraction();
});
