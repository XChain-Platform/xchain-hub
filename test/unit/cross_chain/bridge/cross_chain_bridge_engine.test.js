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

function registerFeature1signedCanonicalsAndIdPreimagesPart1() {
  it('builds the XBRIDGE transfer canonical exactly as the spec spells it', function () {
    const {
      engine
    } = makeEngine();
    const row = {
      transfer_id: 'b'.repeat(64),
      snapshot_block: 150,
      tick: 'XCHAIN',
      decimals: 8,
      src_chain: 'BTC',
      src_action_index: 41,
      src_address: 'mSrc',
      dest_chain: 'DOGE',
      dest_address: 'nDest',
      amount: '5.00000000',
      effective_time: 1757000000,
      network: 'regtest'
    };
    const raw = 'XBRIDGE|' + 'b'.repeat(64) + '|150|XCHAIN|8|BTC|41|mSrc|DOGE|nDest|5.00000000|1757000000|regtest';
    // regtest EQUIV activation is 0, so the wrap is unconditional on this venue.
    expect(eq.isEquivHeaderActive(150, 'regtest')).to.equal(true);
    expect(engine.canonicalMatch(row, 3)).to.equal('EQUIV|XBRIDGE|' + 'b'.repeat(64) + '|3||' + raw);
  });
  it('builds the XPOLICY snapshot canonical exactly as the spec spells it', function () {
    const {
      engine
    } = makeEngine();
    const row = {
      snapshot_id: 'c'.repeat(64),
      snapshot_block: 150,
      origin_chain: 'BTC',
      tick: 'FUFU',
      policy_seq: 2,
      origin_block: 900,
      policy_hash: 'e'.repeat(64),
      effective_time: 1757000000,
      network: 'regtest'
    };
    const raw = 'XPOLICY|' + 'c'.repeat(64) + '|150|BTC|FUFU|2|900|' + 'e'.repeat(64) + '|1757000000|regtest';
    expect(engine.canonicalMatch(row, 0)).to.equal('EQUIV|XPOLICY|' + 'c'.repeat(64) + '|0||' + raw);
  });
}
function registerFeature1signedCanonicalsAndIdPreimagesPart2() {
  it('refuses a row that carries both ids or neither, rather than guessing a family', function () {
    const {
      engine
    } = makeEngine();
    expect(() => engine.canonicalMatch({
      transfer_id: 'a',
      snapshot_id: 'b'
    }, 0)).to.throw(/exactly one/);
    expect(() => engine.canonicalMatch({
      snapshot_block: 1
    }, 0)).to.throw(/exactly one/);
  });

  // transfer_id is tagged and SNAPSHOT-FREE, the XCALL round-id shape: one id per
  // source leg however many BTC heights the hubs read it at. snapshot_id keeps the
  // height, because a policy snapshot is a reading AT a height and a later reading is
  // a new row by design.
  it('derives transfer_id from the leg alone and snapshot_id from the spec preimage', function () {
    const {
      engine
    } = makeEngine();
    expect(engine.deriveTransferId('regtest', 'BTC', 41, 'DOGE', 'nDest')).to.equal(sha256('XBRIDGE|regtest|BTC:41|DOGE:nDest'));
    expect(engine.deriveSnapshotId('regtest', 'BTC', 'FUFU', 2, 150)).to.equal(sha256('regtest|BTC:FUFU|2|150'));
  });
  it('hashes a policy membership, telling "no list" apart from "an empty list"', function () {
    const {
      engine
    } = makeEngine();
    expect(engine.policyHash(null, null, false)).to.equal(sha256('ALLOW|-|BLOCK|-|SLEEP|0'));
    expect(engine.policyHash([], null, false)).to.equal(sha256('ALLOW|0|BLOCK|-|SLEEP|0'));
    // The two must differ: an empty ALLOW list denies everyone under isActionAllowed,
    // while no list at all denies nobody, and a copy has to be able to tell them apart.
    expect(engine.policyHash([], null, false)).to.not.equal(engine.policyHash(null, null, false));
    expect(engine.policyHash(['mA', 'mB'], ['nC'], true)).to.equal(sha256('ALLOW|2|mA|mB|BLOCK|1|nC|SLEEP|1'));
  });
  it('reads canonical membership order as BYTES, not UTF-16 code units', function () {
    const {
      engine
    } = makeEngine();
    expect(engine.isCanonicalOrder(['a', 'b', 'c'])).to.equal(true);
    expect(engine.isCanonicalOrder(['b', 'a'])).to.equal(false);
    expect(engine.isCanonicalOrder(['a', 'a'])).to.equal(false); // strictly ascending
    expect(engine.isCanonicalOrder(null)).to.equal(true);
  });
}
function registerFeature1signedCanonicalsAndIdPreimages() {
  describe('signed canonicals and id preimages', function () {
    registerFeature1signedCanonicalsAndIdPreimagesPart1();
    registerFeature1signedCanonicalsAndIdPreimagesPart2();
  });
}
function registerFeature2activationGatesPart1() {
  it('idles with no flag-day module readable, rather than signing ungated', async function () {
    const {
      engine
    } = makeEngine({
      gates: false
    });
    engine.indexerCall = sinon.stub().resolves({
      latest_block_index: 200,
      network: 'regtest',
      transfers: [pendingLeg()]
    });
    await engine.poll();
    expect(engine.indexerCall.called).to.equal(false);
    expect(engine.transferConsensus.propose.called).to.equal(false);
  });
  it('polls once the bridge gate is armed', async function () {
    const {
      engine
    } = makeEngine();
    engine.indexerCall = sinon.stub().resolves({
      latest_block_index: 200,
      network: 'regtest',
      transfers: []
    });
    await engine.poll();
    expect(engine.indexerCall.called).to.equal(true);
  });

  // Row 28: XCHAIN_BRIDGE_ACTIVATION is keyed '<COIN>:<network>', because BTC, LTC and
  // DOGE reach the flag day at three heights that are not comparable. The poll's own
  // gate reads the BTC-anchored snapshot block, so without a per-leg gate the hub would
  // start signing LTC and DOGE legs the instant BTC crossed. The predicate is replaced
  // with a coin-aware stand-in (the vendored twin answers the same for every coin on
  // regtest, which no coin-blind call could be told apart from), and the leg's OWN
  // height and chain are what it must be handed.
}
function registerFeature2activationGatesPart2() {
  // Row 28: XCHAIN_BRIDGE_ACTIVATION is keyed '<COIN>:<network>', because BTC, LTC and
  // DOGE reach the flag day at three heights that are not comparable. The poll's own
  // gate reads the BTC-anchored snapshot block, so without a per-leg gate the hub would
  // start signing LTC and DOGE legs the instant BTC crossed. The predicate is replaced
  // with a coin-aware stand-in (the vendored twin answers the same for every coin on
  // regtest, which no coin-blind call could be told apart from), and the leg's OWN
  // height and chain are what it must be handed.
  it('gates a leg on the source chain\'s own flag day, not on BTC\'s', async function () {
    const {
      engine
    } = makeEngine();
    const seen = [];
    engine.activation.bridge = (block, network, coin) => {
      seen.push(String(coin) + '@' + String(block));
      return coin === 'DOGE' ? Number(block) >= 500 : true;
    };

    // DOGE below its own instant: refused, even though BTC (the snapshot anchor) is armed.
    await engine.maybeFinalizeTransfer('DOGE', 'regtest', 200, 150, pendingLeg({
      transfer_kind: 'burn',
      src_chain: 'DOGE',
      dest_chain: 'BTC',
      block_index: 100
    }));
    expect(engine.transferConsensus.propose.called).to.equal(false);
    expect(seen).to.include('DOGE@100');

    // A BTC leg at the very same height is signed: the refusal above was the CHAIN,
    // not the height.
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      block_index: 100
    }));
    expect(engine.transferConsensus.propose.calledOnce).to.equal(true);

    // And DOGE at its own instant goes through.
    await engine.maybeFinalizeTransfer('DOGE', 'regtest', 700, 150, pendingLeg({
      transfer_kind: 'burn',
      src_chain: 'DOGE',
      dest_chain: 'BTC',
      block_index: 600,
      src_action_index: 43
    }));
    expect(engine.transferConsensus.propose.callCount).to.equal(2);
  });

  // The follower half of the same rule. A proposer that gated per chain and a validator
  // that did not would disagree across the boundary, which is the one place a bridge
  // cannot afford to: the validator must refuse a leg from a chain still below its own
  // instant rather than accept it because the BTC anchor is past.
}
function registerFeature2activationGatesPart3() {
  // The follower half of the same rule. A proposer that gated per chain and a validator
  // that did not would disagree across the boundary, which is the one place a bridge
  // cannot afford to: the validator must refuse a leg from a chain still below its own
  // instant rather than accept it because the BTC anchor is past.
  it('refuses to validate a proposed row whose source chain is below its own flag day', async function () {
    const {
      engine
    } = makeEngine();
    engine.activation.bridge = (block, network, coin) => coin === 'DOGE' ? Number(block) >= 500 : true;
    engine.indexerCall = sinon.stub().resolves({
      latest_block_index: 200,
      network: 'regtest',
      transfers: [pendingLeg({
        transfer_kind: 'burn',
        src_chain: 'DOGE',
        dest_chain: 'BTC',
        block_index: 100
      })]
    });
    const row = {
      transfer_id: engine.deriveTransferId('regtest', 'DOGE', 41, 'BTC', 'nDestAddress'),
      snapshot_block: 150,
      tick: 'XCHAIN',
      decimals: 8,
      src_chain: 'DOGE',
      src_action_index: 41,
      src_address: 'mSrcAddress',
      dest_chain: 'BTC',
      dest_address: 'nDestAddress',
      amount: '5.00000000',
      effective_time: 1757000000,
      network: 'regtest',
      push_generation: 0
    };
    expect(await engine.validateTransfer(row)).to.equal(false);

    // The positive control, without which the refusal above would pass against a
    // row rejected for some entirely different reason: arm DOGE at its own height
    // and the identical row validates.
    engine.activation.bridge = () => true;
    expect(await engine.validateTransfer(row)).to.equal(true);
  });
  it('holds a non-XCHAIN leg behind the token gate while XCHAIN rides the bridge gate', async function () {
    const {
      engine
    } = makeEngine({
      tokenActive: false
    });
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg({
      tick: 'FUFU'
    }));
    expect(engine.transferConsensus.propose.called).to.equal(false);
    await engine.maybeFinalizeTransfer('BTC', 'regtest', 200, 150, pendingLeg());
    expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
  });
}
function registerFeature2activationGates() {
  describe('activation gates', function () {
    registerFeature2activationGatesPart1();
    registerFeature2activationGatesPart2();
    registerFeature2activationGatesPart3();
  });
}
describe('CrossChainBridgeEngine', function () {
  afterEach(function () {
    sinon.restore();
  });

  // ---------------------------------------------------------------------
  registerFeature1signedCanonicalsAndIdPreimages();
  registerFeature2activationGates();
});
