'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon          = require('sinon');
const axios          = require('axios');
const { expect }     = require('chai');
const RewardTracker  = require('../../src/RewardTracker');
const { createMockHub }     = require('../helpers/mockHub');

// Generate valid unique 64-hex-char pubkeys for testing
function hexPk(n) { return n.toString(16).padStart(64, '0'); }

describe('RewardTracker', function () {

    let hub, rt;

    beforeEach(function () {
        hub = createMockHub({
            p2pConfig: { ORACLE_REWARD_PER_ROUND: '10.00000000' }
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
            let rt2 = new RewardTracker(createMockHub({ p2pConfig: {} }));
            expect(rt2.rewardPerRound).to.equal('10.00000000');
        });
    });

    // -----------------------------------------------------------------
    // distributeRewards()
    // -----------------------------------------------------------------

    describe('distributeRewards()', function () {

        it('equal split — 10 / 5 = 2.00000000 each', async function () {
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

        it('odd division — 10 / 3 = 3.33333333 each', async function () {
            await rt.distributeRewards(1, [hexPk(1), hexPk(2), hexPk(3)]);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][2]).to.equal('3.33333333');
        });

        it('zero participants — no DB calls', async function () {
            await rt.distributeRewards(1, []);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('null participants — no DB calls', async function () {
            await rt.distributeRewards(1, null);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('continues if one INSERT fails', async function () {
            hub.db.doQuery.onFirstCall().rejects(new Error('dup'));
            hub.db.doQuery.onSecondCall().resolves();

            await rt.distributeRewards(1, [hexPk(1), hexPk(2)]);
            expect(hub.db.doQuery.callCount).to.equal(2); // both attempted
        });

        it('throws on a non-positive / non-finite reward amount', async function () {
            let rt2 = new RewardTracker(createMockHub({ p2pConfig: { ORACLE_REWARD_PER_ROUND: '0' } }));
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
    });

    // -----------------------------------------------------------------
    // getUnclaimedRewards()
    // -----------------------------------------------------------------

    describe('getUnclaimedRewards()', function () {
        it('returns total as string', async function () {
            hub.db.doQuery.resolves([{ total: 25.5 }]);
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

    describe('getTotalDistributed()', function () {
        it('returns total as string', async function () {
            hub.db.doQuery.resolves([{ total: 1000 }]);
            let result = await rt.getTotalDistributed();
            expect(result).to.equal('1000');
        });

        it('returns 0 when no rows', async function () {
            hub.db.doQuery.resolves([]);
            let result = await rt.getTotalDistributed();
            expect(result).to.equal('0');
        });
    });

    // -----------------------------------------------------------------
    // _pushRewardsToBtcIndexer()
    // -----------------------------------------------------------------

    describe('_pushRewardsToBtcIndexer()', function () {
        it('returns early (no POST) when no BTC indexer URL is configured', async function () {
            let post = sinon.stub(axios, 'post').resolves({});
            rt.btcIndexerApiUrl = '';
            await rt._pushRewardsToBtcIndexer(1, [hexPk(1)], '2.00000000', 800000);
            expect(post.called).to.be.false;
        });

        it('POSTs a pushvalidatorrewards JSON-RPC body to the indexer', async function () {
            let post = sinon.stub(axios, 'post').resolves({});
            rt.btcIndexerApiUrl = 'http://btc-indexer/api';
            await rt._pushRewardsToBtcIndexer(7, [hexPk(1), hexPk(2)], '5.00000000', 800000);

            expect(post.calledOnce).to.be.true;
            let [url, body, opts] = post.getCall(0).args;
            expect(url).to.equal('http://btc-indexer/api');
            expect(body.jsonrpc).to.equal('2.0');
            expect(body.method).to.equal('pushvalidatorrewards');
            expect(body.params.round).to.equal(7);
            expect(body.params.reward_type).to.equal('oracle_round');
            expect(body.params.block_index).to.equal(800000);
            expect(body.params.rewards).to.deep.equal([
                { pubkey: hexPk(1), amount: '5.00000000' },
                { pubkey: hexPk(2), amount: '5.00000000' }
            ]);
            expect(opts.headers['Content-Type']).to.equal('application/json');
            expect(opts.headers).to.not.have.property('x-api-key');
        });

        it('includes the x-api-key header when an API key is configured', async function () {
            let post = sinon.stub(axios, 'post').resolves({});
            rt.btcIndexerApiUrl = 'http://btc-indexer/api';
            rt.btcIndexerApiKey = 'test-fixture-key';
            await rt._pushRewardsToBtcIndexer(1, [hexPk(1)], '1.00000000', 1);
            expect(post.getCall(0).args[2].headers['x-api-key']).to.equal('test-fixture-key');
        });

        it('swallows a POST failure without throwing', async function () {
            let post = sinon.stub(axios, 'post').rejects(new Error('econnrefused'));
            rt.btcIndexerApiUrl = 'http://btc-indexer/api';
            await rt._pushRewardsToBtcIndexer(1, [hexPk(1)], '1.00000000', 1);
            expect(post.calledOnce).to.be.true;
        });
    });
});
