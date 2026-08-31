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

const sinon            = require('sinon');
const { expect }       = require('chai');
const proxyquire       = require('proxyquire');
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub }       = require('../helpers/mockHub');
const { waitUntil }           = require('../helpers/waitUntil');
const { VALIDATORS_4, buildSubmissions } = require('../helpers/fixtures');

// Match a stubbed request by parsed hostname rather than a raw substring, so a
// lookalike host (e.g. api.coingecko.com.evil.example) cannot pass the check.
function hostIs(url, host) {
    try { return new URL(url).hostname === host; } catch (e) { return false; }
}

describe('Regression: Oracle Pipeline', function () {

    // =================================================================
    // PriceFetcher
    // =================================================================

    describe('PriceFetcher', function () {

        let axiosStub, PriceFetcher, pf;

        beforeEach(function () {
            axiosStub = { get: sinon.stub() };
            PriceFetcher = proxyquire('../../src/PriceFetcher', { axios: axiosStub });
        });

        afterEach(function () { sinon.restore(); });

        // REG-ORA-001
        describe('REG-ORA-001: Local median from CoinGecko + CoinMarketCap', function () {
            it('returns median of two sources @regression-p0', async function () {
                pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });

                // Stub by URL, not call order: CoinGecko fetches carry a random
                // jitter delay and additional keyless upstreams (Kraken) exist,
                // so positional stubs no longer line up.
                axiosStub.get.callsFake(function (url) {
                    if (hostIs(url, 'api.coingecko.com')) {
                        return Promise.resolve({
                            data: { bitcoin: { usd: 100000 }, litecoin: { usd: 80 }, dogecoin: { usd: 0.14 } }
                        });
                    }
                    if (hostIs(url, 'pro-api.coinmarketcap.com')) {
                        return Promise.resolve({
                            data: { data: {
                                BTC: { quote: { USD: { price: 100010 } } },
                                LTC: { quote: { USD: { price: 82 } } },
                                DOGE: { quote: { USD: { price: 0.16 } } }
                            }}
                        });
                    }
                    return Promise.reject(new Error('unexpected URL: ' + url));
                });

                let prices = await pf.fetchPrices();
                expect(prices).to.have.lengthOf(3);

                let btc = prices.find(p => p.coinPair === 'BTC/USD');
                expect(btc.price).to.equal('100005.00000000');
                expect(btc.sources).to.equal(2);
            });
        });

        // REG-ORA-002
        describe('REG-ORA-002: Price range validation (0 < price < 10M)', function () {
            it('returns empty array when all sources fail @regression-p0', async function () {
                pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });
                axiosStub.get.rejects(new Error('fail'));

                let prices = await pf.fetchPrices();
                expect(prices).to.deep.equal([]);
            });
        });

        // REG-ORA-003
        describe('REG-ORA-003: Single source failure handled gracefully', function () {
            it('returns prices from remaining source @regression-p1', async function () {
                pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });

                axiosStub.get.callsFake(function (url) {
                    if (hostIs(url, 'api.coingecko.com')) {
                        return Promise.resolve({
                            data: { bitcoin: { usd: 99000 }, litecoin: { usd: 78 }, dogecoin: { usd: 0.13 } }
                        });
                    }
                    return Promise.reject(new Error('CMC down'));
                });

                let prices = await pf.fetchPrices();
                expect(prices).to.have.lengthOf(3);
                let btc = prices.find(p => p.coinPair === 'BTC/USD');
                expect(btc.price).to.equal('99000.00000000');
                expect(btc.sources).to.equal(1);
            });
        });

        // REG-ORA-004
        describe('REG-ORA-004: Timeout configuration', function () {
            it('defaults to 10000ms @regression-p2', function () {
                pf = new PriceFetcher({});
                expect(pf.timeout).to.equal(10000);
            });

            it('uses configured timeout @regression-p2', function () {
                pf = new PriceFetcher({ PRICE_FETCH_TIMEOUT: 5000 });
                expect(pf.timeout).to.equal(5000);
            });
        });

        // REG-ORA-013
        describe('REG-ORA-013: 8-decimal fixed-point prices', function () {
            it('all prices are 8-decimal strings @regression-p2', async function () {
                pf = new PriceFetcher({});
                axiosStub.get.resolves({
                    data: { bitcoin: { usd: 1.5 }, litecoin: { usd: 2 }, dogecoin: { usd: 3 } }
                });

                let prices = await pf.fetchPrices();
                for (let p of prices) {
                    expect(p.price).to.match(/^\d+\.\d{8}$/);
                }
            });
        });
    });

    // =================================================================
    // OracleConsensus: trimmed median
    // =================================================================

    describe('OracleConsensus: Trimmed Median', function () {

        let hub, pm, oc, oracleRound;

        beforeEach(function () {
            hub = createMockHub();
            pm  = hub._peerManager;
            oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
            oc = new OracleConsensus(hub, oracleRound);
        });

        afterEach(function () { sinon.restore(); });

        function submissionsForPair(prices) {
            let entries = prices.map((p, i) => ({
                sender: 'validator-' + i,
                prices: [{ coinPair: 'BTC/USD', price: String(p) }]
            }));
            return buildSubmissions(entries);
        }

        // REG-ORA-007
        describe('REG-ORA-007: Trimmed median discards top/bottom 15%', function () {
            it('7 submissions → trims 1 from each end @regression-p0', function () {
                let prices = [90000, 99000, 100000, 100100, 100200, 101000, 110000];
                let subs = submissionsForPair(prices);
                expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100100.00000000');
            });

            it('10 submissions → trims 1 from each end @regression-p0', function () {
                let prices = [1, 100, 101, 102, 103, 104, 105, 106, 107, 999];
                let subs = submissionsForPair(prices);
                expect(oc._aggregate(subs, 'BTC/USD')).to.equal('103.50000000');
            });

            it('outlier resistance: extreme value trimmed @regression-p0', function () {
                let prices = [100000, 100001, 100002, 100003, 100004, 100005, 999999];
                let subs = submissionsForPair(prices);
                expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100003.00000000');
            });

            it('all identical values → returns that value @regression-p0', function () {
                let subs = submissionsForPair([50000, 50000, 50000, 50000, 50000]);
                expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
            });
        });

        // REG-ORA-008
        describe('REG-ORA-008: Minimum submission count enforcement', function () {
            it('returns null for no submissions @regression-p0', function () {
                expect(oc._aggregate(new Map(), 'BTC/USD')).to.be.null;
            });

            it('single submission returns that value @regression-p0', function () {
                let subs = submissionsForPair([100000]);
                expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100000.00000000');
            });

            it('ignores zero and negative prices @regression-p0', function () {
                let entries = [
                    { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] },
                    { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '-100' }] },
                    { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: '50000' }] }
                ];
                let subs = buildSubmissions(entries);
                expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
            });

            it('ignores NaN prices @regression-p0', function () {
                let entries = [
                    { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: 'not-a-number' }] },
                    { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '42000' }] }
                ];
                let subs = buildSubmissions(entries);
                expect(oc._aggregate(subs, 'BTC/USD')).to.equal('42000.00000000');
            });
        });

        // REG-ORA-009
        describe('REG-ORA-009: OracleConsensus PBFT flow', function () {

            beforeEach(function () {
                oc.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });

            afterEach(function () {
                for (let [, pending] of oc.pendingRounds) {
                    if (pending.timer) clearTimeout(pending.timer);
                }
            });

            it('PREPARE quorum triggers COMMIT broadcast @regression-p0', function () {
                let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
                let digest = oc._digest(1, prices);

                oc.pendingRounds.set(1, {
                    prices, digest,
                    prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                    commits: new Set(),
                    finalized: false, timer: null,
                    signatures: new Map()
                });

                oc._handlePrepare({
                    sender: VALIDATORS_4[2].addr,
                    sig_pubkey: VALIDATORS_4[2].pubkey,
                    data: { round: 1, digest }
                });

                expect(pm.broadcast.called).to.be.true;
                expect(pm.broadcast.getCall(0).args[0]).to.equal('ORACLE_COMMIT');
            });

            it('COMMIT quorum stores snapshot and emits event @regression-p0', async function () {
                let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
                let digest = oc._digest(1, prices);

                oracleRound.getSubmissions.returns(new Map());

                oc.pendingRounds.set(1, {
                    prices, digest,
                    prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                    commits:  new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                    finalized: false, timer: null, _commitSent: true,
                    signatures: new Map()
                });

                let emitted = null;
                oc.on('round:finalized', (data) => { emitted = data; });

                oc._handleCommit({
                    sender: VALIDATORS_4[2].addr,
                    sig_pubkey: VALIDATORS_4[2].pubkey,
                    data: { round: 1, digest }
                });

                await waitUntil(() => oc.finalized.has(1), { label: 'the commit quorum to finalize the round' });

                expect(hub.db.doQuery.called).to.be.true;
                expect(emitted).to.not.be.null;
                expect(emitted.round).to.equal(1);
                expect(oc.finalized.has(1)).to.be.true;
            });

            it('PREPARE with wrong digest is rejected @regression-p0', function () {
                let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
                let digest = oc._digest(1, prices);

                oc.pendingRounds.set(1, {
                    prices, digest, prepares: new Set(), commits: new Set(),
                    finalized: false, timer: null,
                    signatures: new Map()
                });

                oc._handlePrepare({
                    sender: VALIDATORS_4[1].addr,
                    sig_pubkey: VALIDATORS_4[1].pubkey,
                    data: { round: 1, digest: 'wrong-digest' }
                });

                expect(oc.pendingRounds.get(1).prepares.size).to.equal(0);
            });

            it('duplicate votes counted once @regression-p0', function () {
                let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
                let digest = oc._digest(1, prices);

                oc.pendingRounds.set(1, {
                    prices, digest, prepares: new Set(), commits: new Set(),
                    finalized: false, timer: null,
                    signatures: new Map()
                });

                oc._handlePrepare({ sender: VALIDATORS_4[1].addr, sig_pubkey: VALIDATORS_4[1].pubkey, data: { round: 1, digest } });
                oc._handlePrepare({ sender: VALIDATORS_4[1].addr, sig_pubkey: VALIDATORS_4[1].pubkey, data: { round: 1, digest } });

                expect(oc.pendingRounds.get(1).prepares.size).to.equal(1);
            });
        });

        // REG-ORA-010
        describe('REG-ORA-010: Finalized prices stored with correct validator count', function () {
            it('single-node stores snapshot and emits event @regression-p1', async function () {
                oc.setValidatorSet([]);
                pm.getPeerStatus.returns([]);
                // minSubmissions defaults to a 2-hub diversity floor; a true
                // single-node deployment runs with ORACLE_MIN_SUBMISSIONS=1.
                oc.minSubmissions = 1;

                let entries = [
                    { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
                ];
                oracleRound.getSubmissions.returns(buildSubmissions(entries));

                let emitted = null;
                oc.on('round:finalized', (data) => { emitted = data; });

                await oc.finalizeRound(1);

                expect(hub.db.doQuery.called).to.be.true;
                expect(emitted).to.not.be.null;
                expect(emitted.round).to.equal(1);
                expect(emitted.prices[0].coinPair).to.equal('BTC/USD');
            });
        });

        // REG-ORA-011
        describe('REG-ORA-011: round:finalized event emitted', function () {
            it('skips already-finalized rounds @regression-p1', async function () {
                oc.finalized.add(5);
                await oc.finalizeRound(5);
                expect(hub.db.doQuery.callCount).to.equal(0);
            });
        });

        // REG-ORA-012
        describe('REG-ORA-012: Single-node oracle aggregates directly', function () {
            it('stores directly without consensus @regression-p1', async function () {
                oc.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let entries = [
                    { sender: pm.validatorAddr, prices: [
                        { coinPair: 'BTC/USD', price: '100000' },
                        { coinPair: 'LTC/USD', price: '85' }
                    ]}
                ];
                oracleRound.getSubmissions.returns(buildSubmissions(entries));

                await oc.finalizeRound(1);

                expect(hub.db.doQuery.called).to.be.true;
                expect(pm.broadcast.called).to.be.false;
            });
        });

        // REG-ORA digest determinism
        describe('Oracle digest determinism', function () {
            it('same round+prices → same digest @regression-p0', function () {
                let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
                expect(oc._digest(1, prices)).to.equal(oc._digest(1, prices));
            });

            it('different round → different digest @regression-p0', function () {
                let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
                expect(oc._digest(1, prices)).to.not.equal(oc._digest(2, prices));
            });
        });

        // Quorum math
        describe('Oracle quorum math', function () {
            // Formula: max(2f+1, ceil((N+1)/2)); the majority floor keeps N=3
            // from degenerating to quorum=1 (single validator finalizing alone).
            let cases = [
                { N: 1,  expected: 0 },
                { N: 3,  expected: 2 },
                { N: 4,  expected: 3 },
                { N: 7,  expected: 5 },
                { N: 10, expected: 7 },
                { N: 13, expected: 9 }
            ];

            for (let c of cases) {
                it('N=' + c.N + ' → quorum=' + c.expected + ' @regression-p0', function () {
                    let validators = Array.from({ length: c.N }, (_, i) => ({
                        pubkey: String(i).padStart(2, '0').repeat(32),
                        addr: 'ws://v-' + i + ':10001'
                    }));
                    oc.setValidatorSet(validators);
                    expect(oc._getQuorum()).to.equal(c.expected);
                });
            }
        });

        // AggregateAll
        describe('_aggregateAll regression', function () {
            it('aggregates all coin pairs from submissions @regression-p1', function () {
                let entries = [
                    { sender: 'v1', prices: [
                        { coinPair: 'BTC/USD', price: '100000' },
                        { coinPair: 'LTC/USD', price: '80' }
                    ]},
                    { sender: 'v2', prices: [
                        { coinPair: 'BTC/USD', price: '100002' },
                        { coinPair: 'LTC/USD', price: '82' }
                    ]}
                ];
                let subs = buildSubmissions(entries);
                let result = oc._aggregateAll(subs);
                expect(result).to.have.lengthOf(2);
                let btc = result.find(r => r.coinPair === 'BTC/USD');
                let ltc = result.find(r => r.coinPair === 'LTC/USD');
                expect(btc.price).to.equal('100001.00000000');
                expect(ltc.price).to.equal('81.00000000');
            });
        });
    });
});
