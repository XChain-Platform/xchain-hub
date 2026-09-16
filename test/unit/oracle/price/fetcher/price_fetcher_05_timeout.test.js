'use strict';

const {
    sinon,
    expect,
    proxyquire,
    hostIs
} = require('./price_fetcher.test.js');

let axiosStub;
let PriceFetcher;
let pf;

// Timeout configuration
const testCase1 = function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
            expect(pf.timeout).to.equal(10000);
        };

const testCase2 = function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_TIMEOUT: 5000 });
            expect(pf.timeout).to.equal(5000);
        };

function registerSuite1() {
    it('uses default 10000ms', testCase1);
    it('uses configured timeout', testCase2);
}

function registerOuterSuite5() {
    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../../../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('timeout', registerSuite1);
}

describe('PriceFetcher', registerOuterSuite5);
