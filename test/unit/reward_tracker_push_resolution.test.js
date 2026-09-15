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
const RewardTracker = require('../../src/anchor/reward_tracker');
const {
  createMockHub
} = require('../helpers/mockHub');

// Generate valid unique 64-hex-char pubkeys for testing
function hexPk(n) {
  return n.toString(16).padStart(64, '0');
}
let hub, rt;
// The hub no longer POSTs any reward to the BTC indexer. Every anchor reward is
// derived on-chain by each indexer (per-chain from the ANCHOR v4/v5 publisher
// attestation, archive from the v1 tail), and both flag-days are behind mainnet and sit at
// 0 on testnet and regtest, so the indexer refused every push on every live
// network. What survives here is the AMOUNT rule, which is a separate question:
// a derived reward must record the frozen consensus constant so the hub's
// archived amount matches what every indexer credits.
let post;
function registerSplitSuitePart1() {
  beforeEach(function () {
    post = sinon.stub(axios, 'post').resolves({
      data: {}
    });
  });
  it('pushes no per-chain anchor reward, at or below the flag-day, on any network', async function () {
    for (const [network, block] of [['regtest', 100], ['mainnet', 100], ['mainnet', 963000]]) {
      hub.network = network;
      rt.btcIndexerApiUrl = 'http://indexer:3000';
      await rt.recordAnchorReward('anchor_BTC', 5, hexPk(1), block);
      await new Promise(r => setImmediate(r));
      expect(post.called, network + ' @ ' + block).to.be.false;
    }
  });
  it('pushes no archive reward either, including the pre-flag-day mainnet case', async function () {
    // This case is the one the rail existed for last: a mainnet archive reward
    // below block 963000. It is recorded hub-locally and goes no further.
    for (const [network, block] of [['mainnet', 100], ['regtest', 100], ['mainnet', 963000]]) {
      hub.network = network;
      rt.btcIndexerApiUrl = 'http://indexer:3000';
      await rt.recordAnchorReward('anchor_archive', 3, hexPk(1), block);
      await new Promise(r => setImmediate(r));
      expect(post.called, network + ' @ ' + block).to.be.false;
    }
  });
  it('exposes no push method to call, so nothing can re-arm the rail by accident', function () {
    expect(rt._pushRewardsToBtcIndexer, '_pushRewardsToBtcIndexer must be gone').to.equal(undefined);
    expect(RewardTracker.isTerminalPushError, 'its terminal-error predicate goes with it').to.equal(undefined);
  });
  it('still records the reward locally when the push would have fired', async function () {
    hub.network = 'mainnet';
    rt.btcIndexerApiUrl = 'http://indexer:3000';
    await rt.recordAnchorReward('anchor_BTC', 5, hexPk(1), 100);
    let ins = hub.db.doQuery.getCall(1).args; // getCall(0) is the dedup SELECT
    expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(ins[1]).to.deep.equal([hexPk(1), 5, 'anchor_BTC', '10.00000000', 100, 0]);
  });
}
function registerSplitSuitePart2() {
  it('gates the AMOUNT on the THREADED reward network, not the hub network (#2236)', async function () {
    // The build half (StateAnchorPublisher) gates the v4/v5 payload on the
    // checkpoint ROW's network. An unscoped hub (network='') re-deriving
    // the record-half gate from hub.network saw ''->inactive and credited
    // the legacy amount AND pushed it, while every indexer ALSO derived
    // the frozen on-chain amount: a spendable double-credit.
    hub.network = ''; // legacy unscoped hub
    rt.btcIndexerApiUrl = 'http://indexer:3000';
    await rt.recordAnchorReward('anchor_DOGE', 8, hexPk(1), 100, 'regtest'); // row.network past flag-day
    await new Promise(r => setImmediate(r));
    expect(post.called, 'derived reward must not be pushed').to.be.false;
    let ins = hub.db.doQuery.getCall(1).args; // getCall(0) is the dedup SELECT
    expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(ins[1][3], 'frozen consensus amount, not the legacy tunable').to.equal('10.00000000');
  });
  it('falls back to the hub network when no reward network is threaded (legacy callers unchanged)', async function () {
    hub.network = 'regtest'; // flag-day = genesis
    rt.btcIndexerApiUrl = 'http://indexer:3000';
    await rt.recordAnchorReward('anchor_DOGE', 9, hexPk(1), 100); // no network arg
    await new Promise(r => setImmediate(r));
    let ins = hub.db.doQuery.getCall(1).args; // getCall(0) is the dedup SELECT
    expect(ins[1][3], 'the hub network resolves the reward as derived, so the frozen amount').to.equal('10.00000000');
  });
  it('records the FROZEN amount for a derived anchor_<chain> reward, ignoring an env override', async function () {
    // A non-default ANCHOR_REWARD_PER_PUBLISH must NOT reach the recorded/archived amount
    // for a derived reward: the indexer credits the frozen constant, so the archive (and
    // thus recovery) has to match it or a recovered node forks the COLLECT rail.
    let h = createMockHub({
      p2pConfig: {
        ANCHOR_REWARD_PER_PUBLISH: '2.5'
      }
    });
    h.network = 'regtest'; // flag-day = genesis
    let rt2 = new RewardTracker(h);
    await rt2.recordAnchorReward('anchor_DOGE', 9, hexPk(1), 100);
    let ins = h.db.doQuery.getCall(1).args; // getCall(0) is the dedup SELECT
    expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(ins[1][3], 'frozen amount, not the 2.5 env override').to.equal('10.00000000');
  });
}
function registerSplitSuitePart3() {
  it('still honors the env amount below each flag-day', async function () {
    let h = createMockHub({
      p2pConfig: {
        ANCHOR_REWARD_PER_PUBLISH: '2.5'
      }
    });
    h.network = 'mainnet'; // per-chain dormant @ block 100
    let rt2 = new RewardTracker(h);
    await rt2.recordAnchorReward('anchor_BTC', 1, hexPk(1), 100); // below flag-day
    expect(h.db.doQuery.getCall(1).args[1][3]).to.equal('2.50000000');
    // anchor_archive keeps the env amount below ITS flag-day (mainnet placeholder).
    let h2 = createMockHub({
      p2pConfig: {
        ANCHOR_REWARD_PER_PUBLISH: '2.5'
      }
    });
    h2.network = 'mainnet';
    let rt3 = new RewardTracker(h2);
    await rt3.recordAnchorReward('anchor_archive', 2, hexPk(1), 100);
    expect(h2.db.doQuery.getCall(1).args[1][3]).to.equal('2.50000000');
  });
  it('records the FROZEN anchor amount for a derived anchor_bundle reward, ignoring an env override', async function () {
    // One bundle, one reward: the indexer credits ANCHOR_REWARD_AMOUNT from the
    // on-chain v0 tail, so the hub-recorded amount must be the same frozen constant.
    let h = createMockHub({
      p2pConfig: {
        ANCHOR_REWARD_PER_PUBLISH: '2.5'
      }
    });
    h.network = 'regtest';
    let rt2 = new RewardTracker(h);
    await rt2.recordAnchorReward('anchor_bundle', 100, hexPk(1), 100);
    let ins = h.db.doQuery.getCall(1).args;
    expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(ins[1][2]).to.equal('anchor_bundle');
    expect(ins[1][3], 'frozen anchor amount, not the 2.5 env override').to.equal('10.00000000');
  });
}
function registerSplitSuitePart4() {
  it('records the FROZEN archive amount for a derived anchor_archive reward, ignoring an env override', async function () {
    // Same divergence argument as the per-chain frozen amount: the indexer credits
    // the frozen ARCHIVE_REWARD_AMOUNT from the on-chain v1, so the hub's recorded
    // (and therefore archived) amount has to match or recovery forks the COLLECT rail.
    let h = createMockHub({
      p2pConfig: {
        ANCHOR_REWARD_PER_PUBLISH: '2.5'
      }
    });
    h.network = 'regtest'; // archive flag-day = genesis
    let rt2 = new RewardTracker(h);
    await rt2.recordAnchorReward('anchor_archive', 9, hexPk(1), 100);
    let ins = h.db.doQuery.getCall(1).args; // getCall(0) is the dedup SELECT
    expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
    expect(ins[1][3], 'frozen archive amount, not the 2.5 env override').to.equal('10.00000000');
  });
}
function registerSplitSuitePart5() {
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
  // The retired reward push rail
  // -----------------------------------------------------------------

  describe('the reward push rail is retired', function () {
    registerSplitSuitePart1();
    registerSplitSuitePart2();
    registerSplitSuitePart3();
    registerSplitSuitePart4();
  });

  // -----------------------------------------------------------------
  // resolveSourceByPubkey()
  // -----------------------------------------------------------------
}
function registerSplitSuitePart6() {
  describe('resolveSourceByPubkey()', function () {
    it('returns null without a request when no BTC indexer URL is configured', async function () {
      let post = sinon.stub(axios, 'post').resolves({
        data: {}
      });
      let result = await rt.resolveSourceByPubkey(hexPk(1), 100);
      expect(result).to.equal(null);
      expect(post.called).to.be.false;
    });
    it('queries getstakesourcebypubkey block-scoped and lowercased', async function () {
      rt.btcIndexerApiUrl = 'http://indexer:3000';
      let post = sinon.stub(axios, 'post').resolves({
        data: {
          result: {
            source: 'bc1qsource'
          }
        }
      });
      let result = await rt.resolveSourceByPubkey(hexPk(0xAB).toUpperCase(), 953190);
      expect(result).to.equal('bc1qsource');
      let body = post.getCall(0).args[1];
      expect(body.method).to.equal('getstakesourcebypubkey');
      expect(body.params.pubkey).to.equal(hexPk(0xAB).toLowerCase());
      expect(body.params.block_index).to.equal(953190);
    });
    it('includes the x-api-key header when an API key is configured', async function () {
      rt.btcIndexerApiUrl = 'http://indexer:3000';
      rt.btcIndexerApiKey = 'k';
      let post = sinon.stub(axios, 'post').resolves({
        data: {
          result: {
            source: 's'
          }
        }
      });
      await rt.resolveSourceByPubkey(hexPk(1), 1);
      expect(post.getCall(0).args[2].headers['x-api-key']).to.equal('k');
    });
    it('returns null for an unknown pubkey (result.source null)', async function () {
      rt.btcIndexerApiUrl = 'http://indexer:3000';
      sinon.stub(axios, 'post').resolves({
        data: {
          result: {
            source: null
          }
        }
      });
      let result = await rt.resolveSourceByPubkey(hexPk(1), 1);
      expect(result).to.equal(null);
    });
    it('returns null instead of throwing when the indexer is unreachable', async function () {
      rt.btcIndexerApiUrl = 'http://indexer:3000';
      sinon.stub(axios, 'post').rejects(new Error('econnrefused'));
      let result = await rt.resolveSourceByPubkey(hexPk(1), 1);
      expect(result).to.equal(null);
    });
  });
}
describe('RewardTracker', function () {
  registerSplitSuitePart5();
  registerSplitSuitePart6();
});
