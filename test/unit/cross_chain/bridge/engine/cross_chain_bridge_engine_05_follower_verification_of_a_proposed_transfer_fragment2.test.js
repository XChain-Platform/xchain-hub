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
const eq                     = require('../../../../src/consensus/equivocation_header.js');

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
        resolveBtcLatestBlock: async () => (opts.btcBlock === undefined ? 150 : opts.btcBlock)
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

function feature6followerVerificationOfAProposedTransferFragment2ProposedRow(engine, over) {
  const now = Math.floor(Date.now() / 1000);
  const row = Object.assign({
    snapshot_block: 150,
    network: 'regtest',
    src_chain: 'BTC',
    src_action_index: 41,
    src_address: 'mSrcAddress',
    dest_chain: 'DOGE',
    dest_address: 'nDestAddress',
    tick: 'XCHAIN',
    decimals: 8,
    amount: '5.00000000',
    effective_time: now + 240,
    push_generation: 0
  }, over);
  row.transfer_id = over && over.transfer_id ? over.transfer_id : engine.deriveTransferId(row.network, row.src_chain, row.src_action_index, row.dest_chain, row.dest_address);
  return row;
}
function feature6followerVerificationOfAProposedTransferFragment2WithLeg(engine, leg) {
  engine.indexerCall = sinon.stub().resolves({
    latest_block_index: 200,
    network: 'regtest',
    transfers: [leg === null ? pendingLeg({
      src_action_index: 999
    }) : pendingLeg(leg)]
  });
}
function registerFeature6followerVerificationOfAProposedTransferFragment2Part1() {
  it('refuses a transfer_id that does not re-derive, and a leg it cannot see', async function () {
    const {
      engine
    } = makeEngine();
    feature6followerVerificationOfAProposedTransferFragment2WithLeg(engine, {});
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment2ProposedRow(engine, {
      transfer_id: 'f'.repeat(64)
    }))).to.equal(false);
    feature6followerVerificationOfAProposedTransferFragment2WithLeg(engine, null);
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment2ProposedRow(engine))).to.equal(false);
  });
  it('refuses a record anchored far from its own BTC tip view', async function () {
    const {
      engine
    } = makeEngine();
    feature6followerVerificationOfAProposedTransferFragment2WithLeg(engine, {});
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment2ProposedRow(engine, {
      snapshot_block: 9000
    }))).to.equal(false);
  });
  it('refuses a leg its own indexer does not yet hold at the effective depth', async function () {
    const {
      engine
    } = makeEngine();
    engine.indexerCall = sinon.stub().resolves({
      latest_block_index: 103,
      network: 'regtest',
      transfers: [pendingLeg()]
    });
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment2ProposedRow(engine))).to.equal(false);
  });
}
function registerFeature6followerVerificationOfAProposedTransferFragment2() {
  describe('follower verification of a proposed transfer', function () {
    registerFeature6followerVerificationOfAProposedTransferFragment2Part1();
  });
}
describe('CrossChainBridgeEngine', function () {
  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------
  registerFeature6followerVerificationOfAProposedTransferFragment2();
});
