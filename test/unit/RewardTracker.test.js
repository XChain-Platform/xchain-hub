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

        it('is hub-local only (never pushes to the BTC indexer)', async function () {
            // The consensus oracle_round rows are derived by the indexer from the
            // PRICE v0 signer set; a hub push would credit the (unverifiable) PBFT
            // prepare set and could race the indexer's own derivation.
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            let post = sinon.stub(axios, 'post').resolves({ data: {} });
            await rt.distributeRewards(1, [hexPk(1), hexPk(2)]);
            await new Promise(r => setImmediate(r));
            expect(post.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // recordAnchorReward()
    // -----------------------------------------------------------------

    describe('recordAnchorReward()', function () {

        it('reads existing rows for (round, type) before inserting', async function () {
            await rt.recordAnchorReward('anchor_DOGE', 8, hexPk(1), 953190);
            let sel = hub.db.doQuery.getCall(0).args;
            expect(sel[0]).to.match(/SELECT[\s\S]*validator_rewards[\s\S]*round_number = \?[\s\S]*reward_type = \?/);
            expect(sel[1]).to.deep.equal([8, 'anchor_DOGE']);
        });

        it('records a per-chain anchor reward for the publisher', async function () {
            await rt.recordAnchorReward('anchor_DOGE', 8, hexPk(1), 953190);
            // getCall(0) is the cross-pubkey dedup SELECT; the INSERT follows it.
            let args = hub.db.doQuery.getCall(1).args;
            expect(args[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(args[0]).to.include('block_index');
            expect(args[1]).to.deep.equal([hexPk(1), 8, 'anchor_DOGE', '10.00000000', 953190]);
        });

        it('stores block_index 0 when no blockIndex given', async function () {
            await rt.recordAnchorReward('anchor_BTC', 2, hexPk(1));
            let args = hub.db.doQuery.getCall(1).args;
            expect(args[1][4]).to.equal(0);
        });

        it('skips the INSERT when a lower-or-equal pubkey already holds the (round, type)', async function () {
            // A failover race: an incumbent row already exists for this logical
            // anchor under a smaller pubkey. Our (larger) pubkey is the duplicate.
            hub.db.doQuery.onFirstCall().resolves([{ validator_pubkey: hexPk(1), batch_seq: null }]);
            await rt.recordAnchorReward('anchor_BTC', 5, hexPk(2), 100);
            // Only the SELECT ran: no INSERT, no DELETE.
            expect(hub.db.doQuery.callCount).to.equal(1);
        });

        it('does not push the loser to the BTC indexer', async function () {
            hub.db.doQuery.onFirstCall().resolves([{ validator_pubkey: hexPk(1), batch_seq: null }]);
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            let post = sinon.stub(axios, 'post').resolves({ data: {} });
            await rt.recordAnchorReward('anchor_BTC', 5, hexPk(2), 100);
            await new Promise(r => setImmediate(r));
            expect(post.called).to.be.false;
        });

        it('is idempotent when our exact pubkey already holds the (round, type)', async function () {
            hub.db.doQuery.onFirstCall().resolves([{ validator_pubkey: hexPk(2), batch_seq: null }]);
            await rt.recordAnchorReward('anchor_BTC', 5, hexPk(2), 100);
            expect(hub.db.doQuery.callCount).to.equal(1);   // SELECT only
        });

        it('supersedes a local-only incumbent when our pubkey sorts strictly lower', async function () {
            // Incumbent pubkey is larger and not yet archived → our smaller pubkey
            // wins: DELETE the local incumbent(s) then INSERT ours.
            hub.db.doQuery.onFirstCall().resolves([{ validator_pubkey: hexPk(9), batch_seq: null }]);
            await rt.recordAnchorReward('anchor_BTC', 5, hexPk(1), 100);
            expect(hub.db.doQuery.getCall(1).args[0]).to.include('DELETE FROM validator_rewards');
            let ins = hub.db.doQuery.getCall(2).args;
            expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(ins[1]).to.deep.equal([hexPk(1), 5, 'anchor_BTC', '10.00000000', 100]);
        });

        it('never displaces a row that has already ridden an on-chain archive', async function () {
            // An archived incumbent (batch_seq set) is immutable, even if ours sorts
            // lower: leave it untouched and drop ours.
            hub.db.doQuery.onFirstCall().resolves([{ validator_pubkey: hexPk(9), batch_seq: 42 }]);
            await rt.recordAnchorReward('anchor_BTC', 5, hexPk(1), 100);
            expect(hub.db.doQuery.callCount).to.equal(1);   // SELECT only: no DELETE, no INSERT
        });

        it('pushes the reward to the BTC indexer with its own reward_type', async function () {
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            let post = sinon.stub(axios, 'post').resolves({ data: {} });
            await rt.recordAnchorReward('anchor_archive', 3, hexPk(2), 953200);
            await new Promise(r => setImmediate(r));
            expect(post.calledOnce).to.be.true;
            let body = post.getCall(0).args[1];
            expect(body.params.reward_type).to.equal('anchor_archive');
            expect(body.params.round).to.equal(3);
            expect(body.params.block_index).to.equal(953200);
            expect(body.params.rewards).to.deep.equal([{ pubkey: hexPk(2), amount: '10.00000000' }]);
        });

        it('honors ANCHOR_REWARD_PER_PUBLISH config', async function () {
            let rt2 = new RewardTracker(createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } }));
            await rt2.recordAnchorReward('anchor_BTC', 1, hexPk(1), 100);
            let args = rt2.db.doQuery.getCall(1).args;   // getCall(0) is the dedup SELECT
            expect(args[1][3]).to.equal('2.50000000');
        });

        it('rejects an invalid pubkey without DB writes', async function () {
            await rt.recordAnchorReward('anchor_BTC', 1, 'not-a-pubkey', 100);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('skips a non-positive reward amount without DB writes', async function () {
            let rt2 = new RewardTracker(createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '0' } }));
            await rt2.recordAnchorReward('anchor_BTC', 1, hexPk(1), 100);
            expect(rt2.db.doQuery.called).to.be.false;
        });

        it('swallows an INSERT failure (idempotent retries)', async function () {
            hub.db.doQuery.rejects(new Error('dup'));
            await rt.recordAnchorReward('anchor_LTC', 4, hexPk(3), 100);   // must not throw
        });
    });

    // -----------------------------------------------------------------
    // Anchor-reward flag-day push gating (#5311)
    // -----------------------------------------------------------------

    describe('push gating at/above the anchor-reward flag-day', function () {
        // At/above the flag-day the indexer DERIVES the per-chain anchor reward from the
        // on-chain ANCHOR v4/v5 publisher attestation, so the forgeable push is retired for
        // anchor_<chain>. The hub still RECORDS the reward locally and still pushes
        // anchor_archive (which the indexer does not derive) and pre-flag-day rewards.
        let post;
        beforeEach(function () {
            post = sinon.stub(axios, 'post').resolves({ data: {} });
        });

        it('does NOT push anchor_<chain> once the flag-day is active (indexer derives it)', async function () {
            hub.network = 'regtest';                                       // flag-day = genesis
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            await rt.recordAnchorReward('anchor_DOGE', 8, hexPk(1), 100);
            await new Promise(r => setImmediate(r));
            expect(post.called, 'derived reward is not pushed').to.be.false;
        });

        it('STILL pushes anchor_archive post-flag-day (the indexer cannot derive it from v4/v5)', async function () {
            hub.network = 'regtest';
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            await rt.recordAnchorReward('anchor_archive', 3, hexPk(1), 100);
            await new Promise(r => setImmediate(r));
            expect(post.calledOnce, 'archive reward still pushed').to.be.true;
            expect(post.getCall(0).args[1].params.reward_type).to.equal('anchor_archive');
        });

        it('STILL pushes anchor_<chain> below the flag-day (legacy push path stands)', async function () {
            hub.network = 'mainnet';                                       // flag-day = 999999999 (dormant)
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            await rt.recordAnchorReward('anchor_BTC', 5, hexPk(1), 100);   // 100 < flag-day
            await new Promise(r => setImmediate(r));
            expect(post.calledOnce, 'pre-flag-day reward still pushed').to.be.true;
        });

        it('records the FROZEN amount for a derived anchor_<chain> reward, ignoring an env override', async function () {
            // A non-default ANCHOR_REWARD_PER_PUBLISH must NOT reach the recorded/archived amount
            // for a derived reward: the indexer credits the frozen constant, so the archive (and
            // thus recovery) has to match it or a recovered node forks the COLLECT rail.
            let h = createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } });
            h.network = 'regtest';                                         // flag-day = genesis
            let rt2 = new RewardTracker(h);
            await rt2.recordAnchorReward('anchor_DOGE', 9, hexPk(1), 100);
            let ins = h.db.doQuery.getCall(1).args;                        // getCall(0) is the dedup SELECT
            expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(ins[1][3], 'frozen amount, not the 2.5 env override').to.equal('10.00000000');
        });

        it('still honors the env amount below the flag-day and for anchor_archive', async function () {
            let h = createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } });
            h.network = 'mainnet';                                         // per-chain dormant @ block 100
            let rt2 = new RewardTracker(h);
            await rt2.recordAnchorReward('anchor_BTC', 1, hexPk(1), 100);  // below flag-day
            expect(h.db.doQuery.getCall(1).args[1][3]).to.equal('2.50000000');
            // anchor_archive is never derived from v4/v5, so it keeps the env amount even on regtest.
            let h2 = createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } });
            h2.network = 'regtest';
            let rt3 = new RewardTracker(h2);
            await rt3.recordAnchorReward('anchor_archive', 2, hexPk(1), 100);
            expect(h2.db.doQuery.getCall(1).args[1][3]).to.equal('2.50000000');
        });
    });

    // -----------------------------------------------------------------
    // resolveSourceByPubkey()
    // -----------------------------------------------------------------

    describe('resolveSourceByPubkey()', function () {

        it('returns null without a request when no BTC indexer URL is configured', async function () {
            let post = sinon.stub(axios, 'post').resolves({ data: {} });
            let result = await rt.resolveSourceByPubkey(hexPk(1), 100);
            expect(result).to.equal(null);
            expect(post.called).to.be.false;
        });

        it('queries getstakesourcebypubkey block-scoped and lowercased', async function () {
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            let post = sinon.stub(axios, 'post').resolves({ data: { result: { source: 'bc1qsource' } } });
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
            let post = sinon.stub(axios, 'post').resolves({ data: { result: { source: 's' } } });
            await rt.resolveSourceByPubkey(hexPk(1), 1);
            expect(post.getCall(0).args[2].headers['x-api-key']).to.equal('k');
        });

        it('returns null for an unknown pubkey (result.source null)', async function () {
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            sinon.stub(axios, 'post').resolves({ data: { result: { source: null } } });
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
