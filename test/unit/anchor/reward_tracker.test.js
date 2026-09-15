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
const sinon = require('sinon');
const axios = require('axios');
const {
  expect
} = require('chai');
const RewardTracker = require('../../../src/anchor/reward_tracker');
const {
  createMockHub
} = require('../../helpers/mockHub');

// Generate valid unique 64-hex-char pubkeys for testing
function hexPk(n) {
  return n.toString(16).padStart(64, '0');
}
let hub, rt;
function registerSplitSuitePart1() {
  it('equal split: 10 / 5 = 2.00000000 each', async function () {
    let participants = [hexPk(1), hexPk(2), hexPk(3), hexPk(4), hexPk(5)];
    await rt.distributeRewards(1, participants);
    expect(hub.db.doQuery.callCount).to.equal(5);
    for (let i = 0; i < 5; i++) {
      let args = hub.db.doQuery.getCall(i).args;
      expect(args[1][0]).to.equal(hexPk(i + 1));
      expect(args[1][1]).to.equal(1); // round
      expect(args[1][2]).to.equal('2.00000000');
    }
  });
  it('single participant gets full reward', async function () {
    await rt.distributeRewards(1, [hexPk(1)]);
    let args = hub.db.doQuery.getCall(0).args;
    expect(args[1][2]).to.equal('10.00000000');
  });
  it('odd division: 10 / 3 = 3.33333333 each', async function () {
    await rt.distributeRewards(1, [hexPk(1), hexPk(2), hexPk(3)]);
    let args = hub.db.doQuery.getCall(0).args;
    expect(args[1][2]).to.equal('3.33333333');
  });

  // The discriminating case: 10 / 3 truncates and rounds alike, so only a
  // split whose 9th decimal is >= 5 separates floor from half-up. Floor is
  // what the indexer's bcmulfloor derivation credits, and it is the only
  // one whose rows sum at or below the budget (6 x 1.66666667 = 10.00000002).
  it('inexact split floors like the indexer: 10 / 6 = 1.66666666 each', async function () {
    let six = [1, 2, 3, 4, 5, 6].map(hexPk);
    await rt.distributeRewards(1, six);
    expect(hub.db.doQuery.callCount).to.equal(6);
    for (let i = 0; i < 6; i++) expect(hub.db.doQuery.getCall(i).args[1][2]).to.equal('1.66666666');
  });
  it('zero participants: no DB calls', async function () {
    await rt.distributeRewards(1, []);
    expect(hub.db.doQuery.called).to.be.false;
  });
  it('null participants: no DB calls', async function () {
    await rt.distributeRewards(1, null);
    expect(hub.db.doQuery.called).to.be.false;
  });
  it('continues if one INSERT fails', async function () {
    hub.db.doQuery.onFirstCall().rejects(new Error('dup'));
    hub.db.doQuery.onSecondCall().resolves();
    await rt.distributeRewards(1, [hexPk(1), hexPk(2)]);
    expect(hub.db.doQuery.callCount).to.equal(2); // both attempted
  });
}
function registerSplitSuitePart2() {
  it('throws on a non-positive / non-finite reward amount', async function () {
    let rt2 = new RewardTracker(createMockHub({
      p2pConfig: {
        ORACLE_REWARD_PER_ROUND: '0'
      }
    }));
    try {
      await rt2.distributeRewards(1, [hexPk(1)]);
      expect.fail('should throw');
    } catch (e) {
      expect(e.message).to.include('Invalid reward amount');
    }
  });
  it('returns without DB writes when no participant has a valid pubkey', async function () {
    await rt.distributeRewards(1, ['not-hex', 123, null]);
    expect(hub.db.doQuery.called).to.be.false;
  });
  it('is hub-local only (never pushes to the BTC indexer)', async function () {
    // The consensus oracle_round rows are derived by the indexer from the
    // PRICE v0 signer set; a hub push would credit the (unverifiable) PBFT
    // prepare set and could race the indexer's own derivation.
    rt.btcIndexerApiUrl = 'http://indexer:3000';
    let post = sinon.stub(axios, 'post').resolves({
      data: {}
    });
    await rt.distributeRewards(1, [hexPk(1), hexPk(2)]);
    await new Promise(r => setImmediate(r));
    expect(post.called).to.be.false;
  });
}
function registerSplitSuitePart3() {
  it('reads existing rows for (round, type, qualifier) before inserting', async function () {
    await rt.recordAnchorReward('anchor_DOGE', 8, hexPk(1), 953190);
    let sel = hub.db.doQuery.getCall(0).args;
    expect(sel[0]).to.match(/SELECT[\s\S]*validator_rewards[\s\S]*round_number = \?[\s\S]*reward_type = \?[\s\S]*round_qualifier = \?/);
    // Qualifier 0 for a per-chain leg: its key is byte-identical to the pre-column key.
    expect(sel[1]).to.deep.equal([8, 'anchor_DOGE', 0]);
  });
  it('qualifies the archive leg dedup read by its snapshot block', async function () {
    await rt.recordAnchorReward('anchor_archive', 8, hexPk(1), 953190);
    expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal([8, 'anchor_archive', 953190]);
  });
  it('records a per-chain anchor reward for the publisher', async function () {
    await rt.recordAnchorReward('anchor_DOGE', 8, hexPk(1), 953190);
    // getCall(0) is the cross-pubkey dedup SELECT; the INSERT follows it.
    let args = hub.db.doQuery.getCall(1).args;
    expect(args[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(args[0]).to.include('block_index');
    expect(args[0]).to.include('round_qualifier');
    expect(args[1]).to.deep.equal([hexPk(1), 8, 'anchor_DOGE', '10.00000000', 953190, 0]);
  });
  it('stores block_index 0 when no blockIndex given', async function () {
    await rt.recordAnchorReward('anchor_BTC', 2, hexPk(1));
    let args = hub.db.doQuery.getCall(1).args;
    expect(args[1][4]).to.equal(0);
  });
  it('skips the INSERT when a lower-or-equal pubkey already holds the (round, type)', async function () {
    // A failover race: an incumbent row already exists for this logical
    // anchor under a smaller pubkey. Our (larger) pubkey is the duplicate.
    hub.db.doQuery.onFirstCall().resolves([{
      validator_pubkey: hexPk(1),
      batch_seq: null
    }]);
    await rt.recordAnchorReward('anchor_BTC', 5, hexPk(2), 100);
    // Only the SELECT ran: no INSERT, no DELETE.
    expect(hub.db.doQuery.callCount).to.equal(1);
  });
  it('does not push the loser to the BTC indexer', async function () {
    hub.db.doQuery.onFirstCall().resolves([{
      validator_pubkey: hexPk(1),
      batch_seq: null
    }]);
    rt.btcIndexerApiUrl = 'http://indexer:3000';
    let post = sinon.stub(axios, 'post').resolves({
      data: {}
    });
    await rt.recordAnchorReward('anchor_BTC', 5, hexPk(2), 100);
    await new Promise(r => setImmediate(r));
    expect(post.called).to.be.false;
  });
}
function registerSplitSuitePart4() {
  it('is idempotent when our exact pubkey already holds the (round, type)', async function () {
    hub.db.doQuery.onFirstCall().resolves([{
      validator_pubkey: hexPk(2),
      batch_seq: null
    }]);
    await rt.recordAnchorReward('anchor_BTC', 5, hexPk(2), 100);
    expect(hub.db.doQuery.callCount).to.equal(1); // SELECT only
  });
  it('supersedes a local-only incumbent when our pubkey sorts strictly lower', async function () {
    // Incumbent pubkey is larger and not yet archived → our smaller pubkey
    // wins: DELETE the local incumbent(s) then INSERT ours.
    hub.db.doQuery.onFirstCall().resolves([{
      validator_pubkey: hexPk(9),
      batch_seq: null
    }]);
    await rt.recordAnchorReward('anchor_BTC', 5, hexPk(1), 100);
    expect(hub.db.doQuery.getCall(1).args[0]).to.include('DELETE FROM validator_rewards');
    let ins = hub.db.doQuery.getCall(2).args;
    expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(ins[1]).to.deep.equal([hexPk(1), 5, 'anchor_BTC', '10.00000000', 100, 0]);
  });
  it('never displaces a row that has already ridden an on-chain archive', async function () {
    // An archived incumbent (batch_seq set) is immutable, even if ours sorts
    // lower: leave it untouched and drop ours.
    hub.db.doQuery.onFirstCall().resolves([{
      validator_pubkey: hexPk(9),
      batch_seq: 42
    }]);
    await rt.recordAnchorReward('anchor_BTC', 5, hexPk(1), 100);
    expect(hub.db.doQuery.callCount).to.equal(1); // SELECT only: no DELETE, no INSERT
  });
  it('records the reward hub-locally and pushes NOTHING to the BTC indexer', async function () {
    // The push rail is retired: every anchor reward is derived on-chain by each
    // indexer, so the hub's only job here is its own row.
    rt.btcIndexerApiUrl = 'http://indexer:3000';
    let post = sinon.stub(axios, 'post').resolves({
      data: {}
    });
    await rt.recordAnchorReward('anchor_archive', 3, hexPk(2), 953200);
    await new Promise(r => setImmediate(r));
    expect(post.called, 'no reward may leave the hub over the retired rail').to.be.false;
    let ins = hub.db.doQuery.getCall(1).args; // getCall(0) is the dedup SELECT
    expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(ins[1]).to.deep.equal([hexPk(2), 3, 'anchor_archive', '10.00000000', 953200, 953200]);
  });
}
function registerSplitSuitePart5() {
  it('honors ANCHOR_REWARD_PER_PUBLISH config', async function () {
    let rt2 = new RewardTracker(createMockHub({
      p2pConfig: {
        ANCHOR_REWARD_PER_PUBLISH: '2.5'
      }
    }));
    await rt2.recordAnchorReward('anchor_BTC', 1, hexPk(1), 100);
    let args = rt2.db.doQuery.getCall(1).args; // getCall(0) is the dedup SELECT
    expect(args[1][3]).to.equal('2.50000000');
  });
  it('rejects an invalid pubkey without DB writes', async function () {
    await rt.recordAnchorReward('anchor_BTC', 1, 'not-a-pubkey', 100);
    expect(hub.db.doQuery.called).to.be.false;
  });
  it('skips a non-positive reward amount without DB writes', async function () {
    let rt2 = new RewardTracker(createMockHub({
      p2pConfig: {
        ANCHOR_REWARD_PER_PUBLISH: '0'
      }
    }));
    await rt2.recordAnchorReward('anchor_BTC', 1, hexPk(1), 100);
    expect(rt2.db.doQuery.called).to.be.false;
  });
  it('swallows an INSERT failure (idempotent retries)', async function () {
    hub.db.doQuery.rejects(new Error('dup'));
    await rt.recordAnchorReward('anchor_LTC', 4, hexPk(3), 100); // must not throw
  });
}
function registerSplitSuitePart6() {
  beforeEach(function () {
    hub = createMockHub({
      p2pConfig: {
        ORACLE_REWARD_PER_ROUND: '10.00000000'
      }
    });
    rt = new RewardTracker(hub);
  });
  afterEach(function () {
    sinon.restore();
  });

  // -----------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------

  describe('configuration', function () {
    it('uses configured reward per round', function () {
      expect(rt.rewardPerRound).to.equal('10.00000000');
    });
    it('defaults to 10.00000000', function () {
      let rt2 = new RewardTracker(createMockHub({
        p2pConfig: {}
      }));
      expect(rt2.rewardPerRound).to.equal('10.00000000');
    });
  });

  // -----------------------------------------------------------------
  // distributeRewards()
  // -----------------------------------------------------------------

  describe('distributeRewards()', function () {
    registerSplitSuitePart1();
    registerSplitSuitePart2();
  });

  // -----------------------------------------------------------------
  // recordAnchorReward()
  // -----------------------------------------------------------------
}
function registerSplitSuitePart7() {
  describe('recordAnchorReward()', function () {
    registerSplitSuitePart3();
    registerSplitSuitePart4();
    registerSplitSuitePart5();
  });
}
describe('RewardTracker', function () {
  registerSplitSuitePart6();
  registerSplitSuitePart7();
});
