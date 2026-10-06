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

function registerFeature4proposingATransferRecordPart1() {
  it('stamps the record the spec describes and reserves the round', async function () {
    const {
      engine
    } = makeEngine();
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
    const [roundId, ctx] = engine.transferConsensus.propose.firstCall.args;
    expect(roundId).to.equal(sha256('XBRIDGE|regtest|BTC:41|DOGE:nDestAddress'));
    expect(ctx.row.transfer_id).to.equal(roundId);
    expect(ctx.row.tick).to.equal('XCHAIN');
    expect(ctx.row.decimals).to.equal(8);
    expect(ctx.row.snapshot_block).to.equal(150);
    expect(ctx.row.src_chain).to.equal('BTC');
    expect(ctx.row.dest_chain).to.equal('DOGE');
    // Forward margin sized to the gating (destination) chain, DOGE: 4 x 60 s.
    expect(ctx.row.effective_time - Math.floor(Date.now() / 1000)).to.be.closeTo(240, 5);
    expect(engine._inflight.has(roundId)).to.equal(true);
  });
  it('never proposes a same-chain, unknown-chain, zero-amount or already-recorded leg', async function () {
    const {
      engine,
      db
    } = makeEngine();
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      dest_chain: 'BTC'
    }));
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      dest_chain: 'XRP'
    }));
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      amount: '0'
    }));
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      transfer_kind: 'settle'
    }));
    expect(engine.transferConsensus.propose.called).to.equal(false);
    db.state.exists = true;
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
    expect(engine.transferConsensus.propose.called).to.equal(false);
  });

  // DEFECT 1 (row 15 drive 11, 2026-09-12): BTC action 95 finalized at BOTH snapshot
  // blocks 1017 and 1018 when deriveTransferId still folded snapshot_block into the
  // id, so the SAME source leg polled a cycle later derived a DIFFERENT id and slipped
  // past both the plain _inflight set and the persisted-rows-only db check. The id is
  // snapshot-free now, so the two guards name the same round; the shape is kept as the
  // regression: one leg offered at two consecutive heights before the first round has
  // written anything opens exactly one round.
}
function registerFeature4proposingATransferRecordPart2() {
  // DEFECT 1 (row 15 drive 11, 2026-09-12): BTC action 95 finalized at BOTH snapshot
  // blocks 1017 and 1018 when deriveTransferId still folded snapshot_block into the
  // id, so the SAME source leg polled a cycle later derived a DIFFERENT id and slipped
  // past both the plain _inflight set and the persisted-rows-only db check. The id is
  // snapshot-free now, so the two guards name the same round; the shape is kept as the
  // regression: one leg offered at two consecutive heights before the first round has
  // written anything opens exactly one round.
  it('refuses a second round for a source leg still in flight at a new snapshot height (DEFECT 1, drive 11)', async function () {
    const {
      engine,
      db
    } = makeEngine();
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 1017, pendingLeg({
      src_action_index: 95
    }));
    expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
    const firstId = engine.transferConsensus.propose.firstCall.args[0];
    expect(firstId).to.equal(sha256('XBRIDGE|regtest|BTC:95|DOGE:nDestAddress'));
    expect(db.state.exists).to.equal(false); // proves this is NOT the persisted-row check
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 201, 1018, pendingLeg({
      src_action_index: 95
    }));
    expect(engine.transferConsensus.propose.calledOnce, 'must not open a second round for one source leg at a new snapshot height').to.equal(true);
  });

  // Row 41 (drives 15 and 17): three venue hubs whose 15 s polls straddled one 20 s
  // BTC block opened three rounds for AT2's burn under three ids, every PROPOSE was
  // buffered by followers that never opened that id, and each round died at its
  // lifetime. Two engines one BTC block apart must name ONE round for a leg.
  it('derives the SAME transfer_id for one leg from BTC views one block apart (row 41)', async function () {
    const a = makeEngine({
      btcBlock: 150
    });
    const b = makeEngine({
      btcBlock: 151
    });
    await a.engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
    await b.engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 151, pendingLeg());
    const idA = a.engine.transferConsensus.propose.firstCall.args[0];
    const idB = b.engine.transferConsensus.propose.firstCall.args[0];
    expect(idA, 'two hubs one BTC block apart must open the same round for one leg').to.equal(idB);
    // The height each hub read is still the row's leader-choice field.
    expect(a.engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(150);
    expect(b.engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(151);
  });

  // The consensus emits match:abandoned with the LOWERCASED round id when a round
  // outlives its lifetime; the handler must release the leg so the next poll can
  // re-propose it, or the leg is wedged until a restart (the drive-15 signature).
}
function registerFeature4proposingATransferRecordPart3() {
  // The consensus emits match:abandoned with the LOWERCASED round id when a round
  // outlives its lifetime; the handler must release the leg so the next poll can
  // re-propose it, or the leg is wedged until a restart (the drive-15 signature).
  it('releases the source-leg guard on match:abandoned so the next poll re-proposes', async function () {
    const {
      hub
    } = makeEngine();
    // A REAL consensus emitter, with only the network round stubbed out, so the
    // constructor's own handler wiring is what the test drives.
    const engine = new CrossChainBridgeEngine(hub);
    engine.activation = {
      bridge: () => true,
      token: () => true,
      policy: () => true
    };
    engine.transferConsensus.propose = sinon.stub().resolves();
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
    const id = engine.transferConsensus.propose.firstCall.args[0];
    expect(engine._inflightSourceLegs.has('regtest|BTC:41')).to.equal(true);
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 201, 151, pendingLeg());
    expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
    engine.transferConsensus.emit('match:abandoned', {
      matchId: id.toLowerCase()
    });
    expect(engine._inflight.has(id)).to.equal(false);
    expect(engine._inflightSourceLegs.has('regtest|BTC:41'), 'abandon must release the leg').to.equal(false);
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 202, 152, pendingLeg());
    expect(engine.transferConsensus.propose.callCount, 'the leg must be re-proposed after an abandon').to.equal(2);
    expect(engine.transferConsensus.propose.secondCall.args[0]).to.equal(id);
  });

  // A hub that holds a leg is indistinguishable from one that stopped polling unless
  // it says why. Once per (leg, reason) per process: a 15 s poll must not flood.
}
function registerFeature4proposingATransferRecordPart4() {
  // A hub that holds a leg is indistinguishable from one that stopped polling unless
  // it says why. Once per (leg, reason) per process: a 15 s poll must not flood.
  it('logs why a leg is not proposed, once per leg and reason rather than once per poll', async function () {
    const {
      engine
    } = makeEngine();
    const log = sinon.stub(console, 'log');
    // BTC floor is 6: block 100 at latest 104 is depth 4, held.
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 103, 150, pendingLeg());
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 103, 150, pendingLeg());
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 103, 150, pendingLeg());
    // The next block moves the depth to 5 of 6 and must NOT produce a second line.
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 104, 150, pendingLeg());
    const held = log.getCalls().map(c => String(c.args[0])).filter(s => s.includes('not proposing BTC:41'));
    expect(held).to.have.length(1);
    expect(held[0]).to.contain('below depth 6');
    // A different reason for the same leg is a different line, and a different leg
    // with the same reason is too.
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 104, 150, pendingLeg({
      amount: '0',
      block_index: 90
    }));
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 104, 150, pendingLeg({
      src_action_index: 42
    }));
    const all = log.getCalls().map(c => String(c.args[0])).filter(s => s.includes('not proposing'));
    expect(all).to.have.length(3);
    expect(all[1]).to.contain('BTC:41').and.to.contain('amount 0 is not positive');
    expect(all[2]).to.contain('BTC:42').and.to.contain('below depth 6');
  });
  it('releases the source-leg guard once the round writes, so the leg is governed by the persisted check', async function () {
    const {
      engine,
      db
    } = makeEngine();
    engine.persistCapabilitySnapshot = sinon.stub().resolves(1);
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 1017, pendingLeg({
      src_action_index: 95
    }));
    const [, ctx] = engine.transferConsensus.propose.firstCall.args;
    expect(engine._inflightSourceLegs.has('regtest|BTC:95')).to.equal(true);
    await engine.writeFinalizedTransfer({
      row: ctx.row,
      signatures: [],
      view: 0
    });
    expect(engine._inflightSourceLegs.has('regtest|BTC:95'), 'guard must not leak past a finalize write').to.equal(false);
    // Now persisted: db.state.exists is what refuses a THIRD round for the same leg.
    db.state.exists = true;
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 202, 1019, pendingLeg({
      src_action_index: 95
    }));
    expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
  });
}
function registerFeature4proposingATransferRecordPart5() {
  it('learns a tick origin from the leg kind: a lock is mined where the token is native', async function () {
    const {
      engine
    } = makeEngine();
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      tick: 'FUFU'
    }));
    expect(engine._tickOrigin.get('regtest|FUFU')).to.equal('BTC');
    await engine.maybeFinalizeTransfer('DOGE', 'regtest', 200, 150, pendingLeg({
      tick: 'PEPE',
      transfer_kind: 'burn',
      src_chain: 'DOGE',
      dest_chain: 'BTC',
      src_action_index: 7
    }));
    expect(engine._tickOrigin.get('regtest|PEPE')).to.equal('BTC');
  });

  // A throw anywhere between the guard being set and released must not strand the leg:
  // the finalize handler runs from an event .catch that only logs, so a leaked key would
  // silently stop this hub from ever proposing OR co-signing that leg again.
  it('releases the source-leg guard when the finalize write path throws', async function () {
    const {
      engine
    } = makeEngine();
    engine.persistCapabilitySnapshot = sinon.stub().resolves(1);
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 1017, pendingLeg({
      src_action_index: 95
    }));
    const [, ctx] = engine.transferConsensus.propose.firstCall.args;
    expect(engine._inflightSourceLegs.has('regtest|BTC:95')).to.equal(true);
    engine.resolveBtcChainId = sinon.stub().rejects(new Error('btc chain id read failed'));
    await engine.writeFinalizedTransfer({
      row: ctx.row,
      signatures: [],
      view: 0
    });
    expect(engine._inflightSourceLegs.has('regtest|BTC:95'), 'a throw in the write path must not strand the leg under a dead round').to.equal(false);
    expect(engine.transferConsensus.forgetFinalized.calledWith(ctx.row.transfer_id)).to.equal(true);
  });
}
function registerFeature4proposingATransferRecord() {
  describe('proposing a transfer record', function () {
    registerFeature4proposingATransferRecordPart1();
    registerFeature4proposingATransferRecordPart2();
    registerFeature4proposingATransferRecordPart3();
    registerFeature4proposingATransferRecordPart4();
    registerFeature4proposingATransferRecordPart5();
  });
}
describe('CrossChainBridgeEngine', function () {
  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------
  registerFeature4proposingATransferRecord();
});
