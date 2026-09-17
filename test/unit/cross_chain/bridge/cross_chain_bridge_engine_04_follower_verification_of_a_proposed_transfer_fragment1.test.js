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

function feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, over) {
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
function feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, leg) {
  engine.indexerCall = sinon.stub().resolves({
    latest_block_index: 200,
    network: 'regtest',
    transfers: [leg === null ? pendingLeg({
      src_action_index: 999
    }) : pendingLeg(leg)]
  });
}
function registerFeature6followerVerificationOfAProposedTransferFragment1Part1() {
  it('co-signs a record its own indexer confirms field for field', async function () {
    const {
      engine
    } = makeEngine();
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine))).to.equal(true);
  });

  // DEFECT 1's follower half (row 15 drive 11): validateTransfer had NO
  // source-uniqueness test, so a mesh that already finalized one transfer for a source
  // leg would co-sign a SECOND one for the same leg under another id without
  // hesitation, which is how BTC action 95 minted twice on the destination. An honest
  // hub can no longer derive a second id for a leg, so the shape is a persisted record
  // under an id the proposed row does not carry: refused before the leg is even read.
  // DEFECT 1's follower half (row 15 drive 11): validateTransfer had NO
  // source-uniqueness test, so a mesh that already finalized one transfer for a source
  // leg would co-sign a SECOND one for the same leg under another id without
  // hesitation, which is how BTC action 95 minted twice on the destination. An honest
  // hub can no longer derive a second id for a leg, so the shape is a persisted record
  // under an id the proposed row does not carry: refused before the leg is even read.
  it('refuses to co-sign a duplicate transfer for a leg it already holds a persisted record for (DEFECT 1, drive 11)', async function () {
    const {
      engine,
      db
    } = makeEngine();
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    db.state.sourceTransferId = 'e'.repeat(64);
    expect(await engine.validateTransfer(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, {
      snapshot_block: 1018
    }))).to.equal(false);
    expect(engine.indexerCall.called, 'the persisted-record refusal comes before the leg read').to.equal(false);
  });

  // Negative control for the check above: re-validating the SAME row this hub already
  // holds as its persisted record (a retried FINAL_SYNC, say) must still go through.
  // Without this, the fix would trade DEFECT 1 for refusing every legitimate row.
  // Negative control for the check above: re-validating the SAME row this hub already
  // holds as its persisted record (a retried FINAL_SYNC, say) must still go through.
  // Without this, the fix would trade DEFECT 1 for refusing every legitimate row.
  it('still validates a re-check of the SAME already-persisted transfer_id', async function () {
    const {
      engine,
      db
    } = makeEngine();
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    const row = feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine);
    db.state.sourceTransferId = row.transfer_id;
    expect(await engine.validateTransfer(row)).to.equal(true);
  });

  // The two-hub race DEFECT 1 also opens, which the persisted-row read alone cannot
  // close: hub A has a round OPEN for source leg 41 (nothing written yet, so
  // getBridgeTransferIdForSource is null) and a leader proposes the SAME leg under a
  // transfer_id that is not the one A opened. If A consults only the database it
  // co-signs, and the mesh finalizes two transfers for one lock inside the window.
}
function registerFeature6followerVerificationOfAProposedTransferFragment1Part2() {
  // The two-hub race DEFECT 1 also opens, which the persisted-row read alone cannot
  // close: hub A has a round OPEN for source leg 41 (nothing written yet, so
  // getBridgeTransferIdForSource is null) and a leader proposes the SAME leg under a
  // transfer_id that is not the one A opened. If A consults only the database it
  // co-signs, and the mesh finalizes two transfers for one lock inside the window.
  it('refuses to co-sign a duplicate for a source leg its OWN round still has in flight', async function () {
    const {
      engine,
      db
    } = makeEngine();
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      src_action_index: 41
    }));
    expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
    expect(engine._inflightSourceLegs.has('regtest|BTC:41')).to.equal(true);
    expect(db.state.sourceTransferId).to.equal(null); // nothing persisted: the DB read cannot refuse
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    const peerRow = feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, {
      snapshot_block: 151,
      transfer_id: 'e'.repeat(64)
    });
    expect(await engine.validateTransfer(peerRow), 'must not co-sign a second transfer for a leg this hub already has a round open for').to.equal(false);
    expect(engine.indexerCall.called, 'the in-flight refusal comes before the leg read').to.equal(false);
  });

  // Row 41, the follower half of the one-id-per-leg rule and the exact drive-15 shape:
  // this hub opened its round for leg 41 at ITS tip (150), the leader read the tip one
  // block later (151) and proposed the same leg with snapshot_block 151. The ids agree,
  // so the in-flight exemption applies, the leader's height is adopted as a
  // leader-choice field, and the row is co-signed instead of buffered to death.
}
function registerFeature6followerVerificationOfAProposedTransferFragment1Part3() {
  // Row 41, the follower half of the one-id-per-leg rule and the exact drive-15 shape:
  // this hub opened its round for leg 41 at ITS tip (150), the leader read the tip one
  // block later (151) and proposed the same leg with snapshot_block 151. The ids agree,
  // so the in-flight exemption applies, the leader's height is adopted as a
  // leader-choice field, and the row is co-signed instead of buffered to death.
  it('co-signs the leader\'s row for a leg it has in flight when the snapshot heights differ by a block (row 41)', async function () {
    const follower = makeEngine({
      btcBlock: 150
    });
    const leader = makeEngine({
      btcBlock: 151
    });
    await follower.engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      src_action_index: 41
    }));
    await leader.engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 151, pendingLeg({
      src_action_index: 41
    }));
    const leaderRow = leader.engine.transferConsensus.propose.firstCall.args[1].row;
    expect(leaderRow.snapshot_block).to.equal(151);
    expect(leaderRow.transfer_id).to.equal(follower.engine.transferConsensus.propose.firstCall.args[0]);
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(follower.engine, {
      src_action_index: 41
    });
    expect(await follower.engine.validateProposedMatch(leaderRow), 'a follower must co-sign the leader\'s row for its own in-flight leg at the leader\'s height').to.equal(true);
  });

  // snapshot_block is adopted from the leader, so the window is the only bound on it:
  // the XCALL rail's 144 blocks either side of this hub's own tip view. Both edges,
  // both directions, against a tip of 150.
  // snapshot_block is adopted from the leader, so the window is the only bound on it:
  // the XCALL rail's 144 blocks either side of this hub's own tip view. Both edges,
  // both directions, against a tip of 150.
  it('bounds the leader\'s snapshot_block to 144 blocks of its own tip, either side', async function () {
    const {
      engine
    } = makeEngine({
      btcBlock: 150
    });
    for (const [block, ok] of [[294, true], [295, false], [6, true], [5, false]]) {
      // The lock sits at block 5 so the lower edge is the window alone, not the rule that a
      // BTC leg is never anchored below its own block (snapshotCoversLeg).
      feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, { block_index: 5 });
      // eslint-disable-next-line no-await-in-loop
      expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, {
        snapshot_block: block
      })), 'snapshot_block ' + block + ' against tip 150').to.equal(ok);
    }
  });

  // Negative control for the in-flight refusal: the row of the hub's OWN open round
  // (the identical transfer_id it proposed) must still validate, or a leader that
  // self-validates would refuse its own proposal and no transfer would ever finalize.
}
function registerFeature6followerVerificationOfAProposedTransferFragment1Part4() {
  // Negative control for the in-flight refusal: the row of the hub's OWN open round
  // (the identical transfer_id it proposed) must still validate, or a leader that
  // self-validates would refuse its own proposal and no transfer would ever finalize.
  it('still validates the row of its own in-flight round', async function () {
    const {
      engine
    } = makeEngine();
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      src_action_index: 41
    }));
    const ownRow = engine.transferConsensus.propose.firstCall.args[1].row;
    expect(engine._inflightSourceLegs.has('regtest|BTC:41')).to.equal(true);
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    expect(await engine.validateTransfer(ownRow)).to.equal(true);
  });
  it('refuses a record whose signed fields do not match its own view', async function () {
    const {
      engine
    } = makeEngine();
    for (const over of [{
      amount: '6.00000000'
    }, {
      dest_address: 'nOther'
    }, {
      tick: 'FUFU'
    }, {
      decimals: 2
    }, {
      src_address: 'mOther'
    }]) {
      feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
      // eslint-disable-next-line no-await-in-loop
      expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, over)), 'must refuse ' + JSON.stringify(over)).to.equal(false);
    }
  });
  it('pins push_generation to its own indexer view, so an inflated fence cannot be signed', async function () {
    const {
      engine
    } = makeEngine();
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {
      push_generation: 0
    });
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, {
      push_generation: 9
    }))).to.equal(false);
  });
}
function registerFeature6followerVerificationOfAProposedTransferFragment1Part5() {
  it('refuses a leader-chosen effective_time outside the propagation window', async function () {
    const {
      engine
    } = makeEngine();
    const now = Math.floor(Date.now() / 1000);
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, {
      effective_time: now + 5
    }))).to.equal(false);
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, {
      effective_time: now + 7200
    }))).to.equal(false);
  });
  it('refuses a non-canonical integer spelling before any numeric comparison', async function () {
    const {
      engine
    } = makeEngine();
    feature6followerVerificationOfAProposedTransferFragment1WithLeg(engine, {});
    expect(await engine.validateProposedMatch(feature6followerVerificationOfAProposedTransferFragment1ProposedRow(engine, {
      src_action_index: '041'
    }))).to.equal(false);
  });
}
function registerFeature6followerVerificationOfAProposedTransferFragment1() {
  describe('follower verification of a proposed transfer', function () {
    registerFeature6followerVerificationOfAProposedTransferFragment1Part1();
    registerFeature6followerVerificationOfAProposedTransferFragment1Part2();
    registerFeature6followerVerificationOfAProposedTransferFragment1Part3();
    registerFeature6followerVerificationOfAProposedTransferFragment1Part4();
    registerFeature6followerVerificationOfAProposedTransferFragment1Part5();
  });
}
describe('CrossChainBridgeEngine', function () {
  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------
  registerFeature6followerVerificationOfAProposedTransferFragment1();
});
