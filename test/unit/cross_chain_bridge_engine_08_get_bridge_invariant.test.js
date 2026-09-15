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

const CrossChainBridgeEngine = require('../../src/cross_chain/bridge_engine.js');
const Database               = require('../../src/db');
const eq                     = require('../../src/equivocation_header.js');

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

function registerFeature10getBridgeInvariantPart1() {
  it('always carries XCHAIN and sums in-flight from both halves', async function () {
    const {
      engine,
      db
    } = makeEngine();
    db.state.inflight = [{
      tick: 'XCHAIN',
      dest_chain: 'DOGE',
      amount: '2.00000000'
    }];
    engine._pendingInFlight = new Map([['XCHAIN|DOGE', ['1.50000000']]]);
    // No indexer answers getbridgebalances (the read lands on the same train), which
    // is the state a hub rolled ahead of its fleet is in. A unit test must not dial
    // out, so the failure is staged here instead of being left to DNS.
    sinon.stub(console, 'warn');
    engine._indexerCall = async () => {
      throw new Error('indexer RPC error: {"code":-32601}');
    };
    const inv = await engine.getBridgeInvariant(null);
    expect(Object.keys(inv)).to.include('XCHAIN');
    expect(Object.keys(inv.XCHAIN).sort()).to.deep.equal(['BTC', 'DOGE', 'LTC']);
    // Signed-but-not-yet-applyable plus mined-but-not-yet-finalized.
    expect(Number(inv.XCHAIN.DOGE.in_flight)).to.equal(3.5);
    expect(Number(inv.XCHAIN.LTC.in_flight)).to.equal(0);
    // No chain reader: the chain half is UNKNOWN, never a fabricated zero.
    expect(inv.XCHAIN.DOGE.escrow).to.equal(null);
    expect(inv.XCHAIN.DOGE.delta).to.equal(null);
  });
}
function registerFeature10getBridgeInvariantPart2() {
  it('signs the delta: a surplus is positive and a deficit negative', async function () {
    const {
      engine
    } = makeEngine();
    // The escrow backing a copy sits on the ORIGIN chain at ADDRESS.BRIDGE_<copy>,
    // never on the copy itself (base spec section 3).
    engine.chainStateReader = async coin => {
      if (coin === 'BTC') return {
        XCHAIN: {
          supply: '10',
          escrow: {
            DOGE: '6',
            LTC: '4'
          }
        }
      };
      if (coin === 'DOGE') return {
        XCHAIN: {
          supply: '5',
          escrow: {}
        }
      };
      return {
        XCHAIN: {
          supply: '5',
          escrow: {}
        }
      };
    };
    const inv = await engine.getBridgeInvariant('XCHAIN');
    // DOGE: 6 held on BTC against 5 minted on DOGE, nothing in flight. A stray SEND
    // to the escrow is the only way this goes positive, and it is a surplus (D65).
    expect(inv.XCHAIN.DOGE.escrow).to.equal('6');
    expect(inv.XCHAIN.DOGE.supply).to.equal('5');
    expect(inv.XCHAIN.DOGE.delta).to.equal('1');
    // LTC: 4 held against 5 minted. Somebody else's unit has nothing behind it.
    expect(inv.XCHAIN.LTC.delta).to.equal('-1');
    // BTC is the origin: it holds the asset, nothing escrows it there.
    expect(inv.XCHAIN.BTC.supply).to.equal('10');
    expect(inv.XCHAIN.BTC.escrow).to.equal(null);
    expect(inv.XCHAIN.BTC.delta).to.equal(null);
  });
}
function registerFeature10getBridgeInvariantPart3() {
  it('subtracts in-flight before judging the delta, so the confirmation window is not a surplus', async function () {
    const {
      engine
    } = makeEngine();
    engine._pendingInFlight = new Map([['XCHAIN|DOGE', ['5']]]);
    engine.chainStateReader = async coin => coin === 'BTC' ? {
      XCHAIN: {
        supply: '5',
        escrow: {
          DOGE: '5'
        }
      }
    } : {
      XCHAIN: {
        supply: '0',
        escrow: {}
      }
    };
    const inv = await engine.getBridgeInvariant('XCHAIN');
    expect(inv.XCHAIN.DOGE.delta).to.equal('0');
  });
  it('reports the highest FINALIZED policy seq the hub holds', async function () {
    const {
      engine,
      db
    } = makeEngine();
    db.state.pairs = [{
      tick: 'FUFU',
      src_chain: 'BTC',
      dest_chain: 'DOGE'
    }];
    db.state.seq = 7;
    engine._tickOrigin.set('regtest|FUFU', 'BTC');
    // The policy seq is hub-ledger state; the chain read is irrelevant here and must
    // not dial an indexer that does not exist.
    engine.chainStateReader = async () => null;
    const inv = await engine.getBridgeInvariant('FUFU');
    expect(inv.FUFU.DOGE.finalized_policy_seq).to.equal(7);
    expect(inv.FUFU.BTC.finalized_policy_seq).to.equal(7);
  });
  it('survives a chain reader that throws, rather than failing the whole read', async function () {
    const {
      engine
    } = makeEngine();
    engine.chainStateReader = async () => {
      throw new Error('indexer down');
    };
    const inv = await engine.getBridgeInvariant('XCHAIN');
    expect(inv.XCHAIN.BTC.escrow).to.equal(null);
  });
}
function registerFeature10getBridgeInvariant() {
  describe('getBridgeInvariant', function () {
    registerFeature10getBridgeInvariantPart1();
    registerFeature10getBridgeInvariantPart2();
    registerFeature10getBridgeInvariantPart3();
  });
}
describe('CrossChainBridgeEngine', function () {
  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------
  registerFeature10getBridgeInvariant();
});
