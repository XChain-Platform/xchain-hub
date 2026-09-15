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
function registerSplitSuitePart1() {
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
  // Indexer URL resolution via the hub resolver (#2652)
  // -----------------------------------------------------------------
}
function registerSplitSuitePart2() {
  describe('BTC indexer URL resolution (#2652)', function () {
    it('resolves the endpoint through hub._resolveBtcIndexerUrl when the env field is empty (configs-table hub)', async function () {
      // No BTC_INDEXER_API_URL exported: the constructor field is ''.
      rt.btcIndexerApiUrl = '';
      hub._resolveBtcIndexerUrl = sinon.stub().resolves('http://configs-table-indexer:3000');
      let post = sinon.stub(axios, 'post').resolves({
        data: {
          result: {
            source: 'bc1qsrc'
          }
        }
      });
      let result = await rt.resolveSourceByPubkey(hexPk(1), 953190);
      expect(hub._resolveBtcIndexerUrl.calledOnce).to.be.true;
      expect(result).to.equal('bc1qsrc');
      expect(post.getCall(0).args[0]).to.equal('http://configs-table-indexer:3000');
    });
    it('still fails closed (null, no call) when neither env nor the hub resolver yields a URL', async function () {
      rt.btcIndexerApiUrl = '';
      hub._resolveBtcIndexerUrl = sinon.stub().resolves('');
      let post = sinon.stub(axios, 'post').resolves({});
      let result = await rt.resolveSourceByPubkey(hexPk(1), 1);
      expect(result).to.equal(null);
      expect(post.called).to.be.false;
    });
    it('falls back to the env-captured field when the hub exposes no resolver', async function () {
      rt.btcIndexerApiUrl = 'http://env-indexer:3000';
      expect(typeof hub._resolveBtcIndexerUrl).to.not.equal('function');
      let post = sinon.stub(axios, 'post').resolves({
        data: {
          result: {
            source: 's'
          }
        }
      });
      await rt.resolveSourceByPubkey(hexPk(1), 1);
      expect(post.getCall(0).args[0]).to.equal('http://env-indexer:3000');
    });
  });

  // -----------------------------------------------------------------
  // getUnclaimedRewards()
  // -----------------------------------------------------------------
}
function registerSplitSuitePart3() {
  describe('getUnclaimedRewards()', function () {
    it('returns total as string', async function () {
      hub.db.doQuery.resolves([{
        total: 25.5
      }]);
      let result = await rt.getUnclaimedRewards('pk1');
      expect(result).to.equal('25.5');
    });
    it('returns 0 when no rows', async function () {
      hub.db.doQuery.resolves([]);
      let result = await rt.getUnclaimedRewards('pk1');
      expect(result).to.equal('0');
    });
  });

  // -----------------------------------------------------------------
  // getRewardHistory()
  // -----------------------------------------------------------------

  describe('getRewardHistory()', function () {
    it('passes pubkey and limit', async function () {
      hub.db.doQuery.resolves([]);
      await rt.getRewardHistory('pk1', 10);
      let args = hub.db.doQuery.getCall(0).args;
      expect(args[1]).to.deep.equal(['pk1', 10]);
    });
    it('defaults limit to 50', async function () {
      hub.db.doQuery.resolves([]);
      await rt.getRewardHistory('pk1');
      let args = hub.db.doQuery.getCall(0).args;
      expect(args[1][1]).to.equal(50);
    });
  });

  // -----------------------------------------------------------------
  // getTotalDistributed()
  // -----------------------------------------------------------------
}
function registerSplitSuitePart4() {
  describe('getTotalDistributed()', function () {
    it('returns total as string', async function () {
      hub.db.doQuery.resolves([{
        total: 1000
      }]);
      let result = await rt.getTotalDistributed();
      expect(result).to.equal('1000');
    });
    it('returns 0 when no rows', async function () {
      hub.db.doQuery.resolves([]);
      let result = await rt.getTotalDistributed();
      expect(result).to.equal('0');
    });
  });
}
describe('RewardTracker', function () {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
  registerSplitSuitePart3();
  registerSplitSuitePart4();
});
