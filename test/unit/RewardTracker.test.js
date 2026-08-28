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

        // The discriminating case: 10 / 3 truncates and rounds alike, so only a
        // split whose 9th decimal is >= 5 separates floor from half-up. Floor is
        // what the indexer's bcmulfloor derivation credits, and it is the only
        // one whose rows sum at or below the budget (6 x 1.66666667 = 10.00000002).
        it('inexact split floors like the indexer: 10 / 6 = 1.66666666 each', async function () {
            let six = [1, 2, 3, 4, 5, 6].map(hexPk);
            await rt.distributeRewards(1, six);
            expect(hub.db.doQuery.callCount).to.equal(6);
            for (let i = 0; i < 6; i++)
                expect(hub.db.doQuery.getCall(i).args[1][2]).to.equal('1.66666666');
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

        it('records the reward hub-locally and pushes NOTHING to the BTC indexer', async function () {
            // The push rail is retired: every anchor reward is derived on-chain by each
            // indexer, so the hub's only job here is its own row.
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            let post = sinon.stub(axios, 'post').resolves({ data: {} });
            await rt.recordAnchorReward('anchor_archive', 3, hexPk(2), 953200);
            await new Promise(r => setImmediate(r));
            expect(post.called, 'no reward may leave the hub over the retired rail').to.be.false;
            let ins = hub.db.doQuery.getCall(1).args;   // getCall(0) is the dedup SELECT
            expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(ins[1]).to.deep.equal([hexPk(2), 3, 'anchor_archive', '10.00000000', 953200]);
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
    // The retired reward push rail
    // -----------------------------------------------------------------

    describe('the reward push rail is retired', function () {
        // The hub no longer POSTs any reward to the BTC indexer. Every anchor reward is
        // derived on-chain by each indexer (per-chain from the ANCHOR v4/v5 publisher
        // attestation, archive from v6), and both flag-days are behind mainnet and sit at
        // 0 on testnet and regtest, so the indexer refused every push on every live
        // network. What survives here is the AMOUNT rule, which is a separate question:
        // a derived reward must record the frozen consensus constant so the hub's
        // archived amount matches what every indexer credits.
        let post;
        beforeEach(function () {
            post = sinon.stub(axios, 'post').resolves({ data: {} });
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
            let ins = hub.db.doQuery.getCall(1).args;                      // getCall(0) is the dedup SELECT
            expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(ins[1]).to.deep.equal([hexPk(1), 5, 'anchor_BTC', '10.00000000', 100]);
        });

        it('gates the AMOUNT on the THREADED reward network, not the hub network (#2236)', async function () {
            // The build half (StateAnchorPublisher) gates the v4/v5 payload on the
            // checkpoint ROW's network. An unscoped hub (network='') re-deriving
            // the record-half gate from hub.network saw ''->inactive and credited
            // the legacy amount AND pushed it, while every indexer ALSO derived
            // the frozen on-chain amount: a spendable double-credit.
            hub.network = '';                                              // legacy unscoped hub
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            await rt.recordAnchorReward('anchor_DOGE', 8, hexPk(1), 100, 'regtest');   // row.network past flag-day
            await new Promise(r => setImmediate(r));
            expect(post.called, 'derived reward must not be pushed').to.be.false;
            let ins = hub.db.doQuery.getCall(1).args;                      // getCall(0) is the dedup SELECT
            expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(ins[1][3], 'frozen consensus amount, not the legacy tunable').to.equal('10.00000000');
        });

        it('falls back to the hub network when no reward network is threaded (legacy callers unchanged)', async function () {
            hub.network = 'regtest';                                       // flag-day = genesis
            rt.btcIndexerApiUrl = 'http://indexer:3000';
            await rt.recordAnchorReward('anchor_DOGE', 9, hexPk(1), 100);  // no network arg
            await new Promise(r => setImmediate(r));
            let ins = hub.db.doQuery.getCall(1).args;                      // getCall(0) is the dedup SELECT
            expect(ins[1][3], 'the hub network resolves the reward as derived, so the frozen amount').to.equal('10.00000000');
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

        it('still honors the env amount below each flag-day', async function () {
            let h = createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } });
            h.network = 'mainnet';                                         // per-chain dormant @ block 100
            let rt2 = new RewardTracker(h);
            await rt2.recordAnchorReward('anchor_BTC', 1, hexPk(1), 100);  // below flag-day
            expect(h.db.doQuery.getCall(1).args[1][3]).to.equal('2.50000000');
            // anchor_archive keeps the env amount below ITS flag-day (mainnet placeholder).
            let h2 = createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } });
            h2.network = 'mainnet';
            let rt3 = new RewardTracker(h2);
            await rt3.recordAnchorReward('anchor_archive', 2, hexPk(1), 100);
            expect(h2.db.doQuery.getCall(1).args[1][3]).to.equal('2.50000000');
        });

        it('records the FROZEN anchor amount for a derived anchor_bundle reward, ignoring an env override', async function () {
            // One bundle, one reward: the indexer credits ANCHOR_REWARD_AMOUNT from the
            // on-chain v7 tail, so the hub-recorded amount must be the same frozen constant.
            let h = createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } });
            h.network = 'regtest';
            let rt2 = new RewardTracker(h);
            await rt2.recordAnchorReward('anchor_bundle', 100, hexPk(1), 100);
            let ins = h.db.doQuery.getCall(1).args;
            expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(ins[1][2]).to.equal('anchor_bundle');
            expect(ins[1][3], 'frozen anchor amount, not the 2.5 env override').to.equal('10.00000000');
        });

        it('records the FROZEN archive amount for a derived anchor_archive reward, ignoring an env override', async function () {
            // Same divergence argument as the per-chain frozen amount: the indexer credits
            // the frozen ARCHIVE_REWARD_AMOUNT from the on-chain v6, so the hub's recorded
            // (and therefore archived) amount has to match or recovery forks the COLLECT rail.
            let h = createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '2.5' } });
            h.network = 'regtest';                                         // archive flag-day = genesis
            let rt2 = new RewardTracker(h);
            await rt2.recordAnchorReward('anchor_archive', 9, hexPk(1), 100);
            let ins = h.db.doQuery.getCall(1).args;                        // getCall(0) is the dedup SELECT
            expect(ins[0]).to.include('INSERT IGNORE INTO validator_rewards');
            expect(ins[1][3], 'frozen archive amount, not the 2.5 env override').to.equal('10.00000000');
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
    // Indexer URL resolution via the hub resolver (#2652)
    // -----------------------------------------------------------------

    describe('BTC indexer URL resolution (#2652)', function () {

        it('resolves the endpoint through hub._resolveBtcIndexerUrl when the env field is empty (configs-table hub)', async function () {
            // No BTC_INDEXER_API_URL exported: the constructor field is ''.
            rt.btcIndexerApiUrl = '';
            hub._resolveBtcIndexerUrl = sinon.stub().resolves('http://configs-table-indexer:3000');
            let post = sinon.stub(axios, 'post').resolves({ data: { result: { source: 'bc1qsrc' } } });
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
            let post = sinon.stub(axios, 'post').resolves({ data: { result: { source: 's' } } });
            await rt.resolveSourceByPubkey(hexPk(1), 1);
            expect(post.getCall(0).args[0]).to.equal('http://env-indexer:3000');
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
});
