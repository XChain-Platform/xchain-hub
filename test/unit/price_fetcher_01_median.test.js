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

// _median()
// _median returns an 8-decimal bignumber string (mathjs/bcmath mandate)
const hook1 = function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
        };

const testCase2 = function () {
            expect(pf._median([42])).to.equal('42.00000000');
        };

const testCase3 = function () {
            expect(pf._median([10, 20])).to.equal('15.00000000');
        };

const testCase4 = function () {
            expect(pf._median([1, 3, 2])).to.equal('2.00000000');
        };

const testCase5 = function () {
            expect(pf._median([1, 2, 3, 4])).to.equal('2.50000000');
        };

const testCase6 = function () {
            expect(pf._median([])).to.equal('0.00000000');
        };

const testCase7 = function () {
            let arr = [3, 1, 2];
            pf._median(arr);
            expect(arr).to.deep.equal([3, 1, 2]);
        };

function registerSuite1() {
    beforeEach(hook1);
    it('single value returns that value', testCase2);
    it('two values returns average', testCase3);
    it('odd count returns middle value', testCase4);
    it('even count returns average of two middle values', testCase5);
    it('empty array returns 0', testCase6);
    it('does not mutate input array', testCase7);
}

function registerOuterSuite1() {
    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('_median()', registerSuite1);
}

describe('PriceFetcher', registerOuterSuite1);
