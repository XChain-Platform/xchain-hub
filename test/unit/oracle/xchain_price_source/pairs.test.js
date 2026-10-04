'use strict';

const assert = require('assert');
const pairs = require('../../../../src/oracle/xchain_price_source/pairs.js');
const { DERIVED_PAIRS } = require('../../../../src/constants.js');

describe('xchain price source pairs', function () {
    it('uses the pinned derived consensus pair', function () {
        assert.strictEqual(pairs.XCHAIN_PAIR, DERIVED_PAIRS[0]);
        assert.strictEqual(pairs.XCHAIN_PAIR, 'XCHAIN/USD');
        assert.match(pairs.XCHAIN_PAIR, /^[A-Z][A-Z0-9]*\/[A-Z][A-Z0-9]*$/);
    });

    it('uses BTC/USD as the reference pair', function () {
        assert.strictEqual(pairs.BTC_PAIR, 'BTC/USD');
    });

    it('uses the XCHAIN pair base as the gas ticker', function () {
        assert.strictEqual(pairs.GAS_TICK, 'XCHAIN');
        assert.strictEqual(pairs.GAS_TICK, pairs.XCHAIN_PAIR.split('/')[0]);
    });

    it('exports only the pair and ticker constants', function () {
        assert.deepStrictEqual(Object.keys(pairs).sort(), ['BTC_PAIR', 'GAS_TICK', 'XCHAIN_PAIR']);
    });
});
