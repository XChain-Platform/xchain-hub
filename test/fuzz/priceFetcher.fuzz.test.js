'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const fc         = require('fast-check');
const proxyquire = require('proxyquire');
const gen        = require('./generators');

describe('Fuzz: PriceFetcher', function () {

    let axiosStub, PriceFetcher, pf;

    beforeEach(function () {
        axiosStub    = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../src/PriceFetcher', { axios: axiosStub });
        pf           = new PriceFetcher({ PRICE_FETCH_TIMEOUT: 5000 });
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _median()
    // -----------------------------------------------------------------

    describe('_median()', function () {

        it('output is always a finite number for non-empty arrays of finite numbers', function () {
            fc.assert(fc.property(gen.fc_priceArray(1, 50), function (values) {
                let result = pf._median(values);
                expect(Number.isFinite(result)).to.be.true;
            }), { numRuns: 300 });
        });

        it('result is within the range [min(input), max(input)]', function () {
            fc.assert(fc.property(gen.fc_priceArray(1, 50), function (values) {
                let result = pf._median(values);
                let sorted = [...values].sort(function (a, b) { return a - b; });
                expect(result).to.be.at.least(sorted[0] - 1e-10);
                expect(result).to.be.at.most(sorted[sorted.length - 1] + 1e-10);
            }), { numRuns: 300 });
        });

        it('does not mutate the input array', function () {
            fc.assert(fc.property(gen.fc_priceArray(1, 20), function (values) {
                let copy = [...values];
                pf._median(values);
                expect(values).to.deep.equal(copy);
            }), { numRuns: 200 });
        });

        it('single-element array always returns that element', function () {
            fc.assert(fc.property(gen.fc_price(), function (v) {
                expect(pf._median([v])).to.equal(v);
            }), { numRuns: 200 });
        });

        it('empty array returns 0', function () {
            expect(pf._median([])).to.equal(0);
        });

        it('two-element array returns the arithmetic mean', function () {
            fc.assert(fc.property(gen.fc_price(), gen.fc_price(), function (a, b) {
                let result = pf._median([a, b]);
                let expected = (a + b) / 2;
                expect(result).to.be.closeTo(expected, Math.abs(expected) * 1e-10 + 1e-15);
            }), { numRuns: 200 });
        });
    });

    // -----------------------------------------------------------------
    // fetchFromCoinGecko() response parsing
    // -----------------------------------------------------------------

    describe('fetchFromCoinGecko() response parsing', function () {

        it('arbitrary response shapes never throw, always return null or valid map', function () {
            return fc.assert(fc.asyncProperty(
                fc.record({
                    bitcoin:  fc.oneof(fc.record({ usd: gen.fc_price() }), fc.constant(null), fc.constant(undefined)),
                    litecoin: fc.oneof(fc.record({ usd: gen.fc_price() }), fc.constant(null), fc.constant(undefined)),
                    dogecoin: fc.oneof(fc.record({ usd: gen.fc_price() }), fc.constant(null), fc.constant(undefined))
                }),
                async function (responseData) {
                    axiosStub.get.resolves({ data: responseData });
                    let result = await pf.fetchFromCoinGecko();
                    expect(result === null || typeof result === 'object').to.be.true;
                    if (result !== null) {
                        for (let key of ['BTC/USD', 'LTC/USD', 'DOGE/USD']) {
                            if (result[key] !== undefined) {
                                expect(typeof result[key]).to.equal('number');
                            }
                        }
                    }
                }
            ), { numRuns: 100 });
        });

        it('deeply nested garbage response never throws', function () {
            return fc.assert(fc.asyncProperty(
                fc.anything({ maxDepth: 3 }),
                async function (responseData) {
                    axiosStub.get.resolves({ data: responseData });
                    let result = await pf.fetchFromCoinGecko();
                    expect(result === null || typeof result === 'object').to.be.true;
                }
            ), { numRuns: 100 });
        });

        it('axios rejection always produces null', function () {
            return fc.assert(fc.asyncProperty(
                fc.string({ maxLength: 100 }),
                async function (errorMessage) {
                    axiosStub.get.rejects(new Error(errorMessage));
                    let result = await pf.fetchFromCoinGecko();
                    expect(result).to.be.null;
                }
            ), { numRuns: 50 });
        });
    });

    // -----------------------------------------------------------------
    // fetchPrices() aggregate output
    // -----------------------------------------------------------------

    describe('fetchPrices() aggregate output', function () {

        it('output prices always have valid numeric format and never contain NaN', function () {
            return fc.assert(fc.asyncProperty(
                fc.record({
                    bitcoin:  fc.record({ usd: gen.fc_price() }),
                    litecoin: fc.record({ usd: gen.fc_price() }),
                    dogecoin: fc.record({ usd: gen.fc_price() })
                }),
                async function (cgData) {
                    axiosStub.get.resolves({ data: cgData });
                    let prices = await pf.fetchPrices();
                    for (let p of prices) {
                        expect(p.price).to.not.equal('NaN');
                        expect(p.price).to.not.include('Infinity');
                        expect(p).to.have.property('coinPair').that.is.a('string');
                        expect(p).to.have.property('sources').that.is.a('number').and.at.least(1);
                    }
                }
            ), { numRuns: 200 });
        });

        it('output prices always have 8-decimal format', function () {
            return fc.assert(fc.asyncProperty(
                fc.record({
                    bitcoin:  fc.record({ usd: gen.fc_price() }),
                    litecoin: fc.record({ usd: gen.fc_price() }),
                    dogecoin: fc.record({ usd: gen.fc_price() })
                }),
                async function (cgData) {
                    axiosStub.get.resolves({ data: cgData });
                    let prices = await pf.fetchPrices();
                    for (let p of prices) {
                        expect(p.price).to.match(/^-?\d+\.\d{8}$/);
                    }
                }
            ), { numRuns: 200 });
        });

        it('when both sources fail, returns empty array (no crash)', function () {
            return fc.assert(fc.asyncProperty(
                fc.string({ maxLength: 50 }),
                async function (errMsg) {
                    axiosStub.get.rejects(new Error(errMsg));
                    let prices = await pf.fetchPrices();
                    expect(prices).to.be.an('array');
                    expect(prices).to.have.lengthOf(0);
                }
            ), { numRuns: 50 });
        });
    });
});
