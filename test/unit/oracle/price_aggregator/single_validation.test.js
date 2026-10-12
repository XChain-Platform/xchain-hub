'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { PRICE_MAX, PRICE_V1_COINS, PRICE_V1_FIATS } = require('../../../../src/constants.js');
const {
    validateOraclePriceIdentity,
    validateOraclePriceValue,
    validateOraclePriceWireFields,
    effectiveAtFor
} = require('../../../../src/oracle/price_aggregator/single_validation.js');
const { isPriceV1CanonicalActive } = require('../../../../src/consensus/gates/price_scale_gate.js');

const LEGACY_BLOCK_TIME = 1700000000;
const identity = {
    source_address: 'oracle-address',
    coin: PRICE_V1_COINS[0],
    tick: 'GOLD',
    fiat: PRICE_V1_FIATS[0],
    memo: 'spot price'
};

function registerIdentityTests() {
    it('accepts a well-formed identity', function () {
        expect(validateOraclePriceIdentity(identity)).to.equal(null);
    });

    for (const [field, value, reason] of [
        ['source_address', '', 'invalid source_address'],
        ['coin', 'XCHAIN', 'invalid coin'],
        ['tick', '', 'invalid tick'],
        ['fiat', 'XYZ', 'invalid fiat'],
        ['memo', 42, 'invalid memo']
    ]) {
        it('reports ' + reason, function () {
            const candidate = Object.assign({}, identity, { [field]: value });
            expect(validateOraclePriceIdentity(candidate)).to.equal(reason);
        });
    }
}

function registerValueTests() {
    it('rejects out-of-range and over-precision values', function () {
        for (const value of ['0', '-1', '1.123456789', String(PRICE_MAX + 1)]) {
            expect(validateOraclePriceValue({ value, block_time: LEGACY_BLOCK_TIME }, 'mainnet', 'BTC'))
                .to.equal('invalid value');
        }
    });

    it('rejects fees above one or with more than 18 decimals', function () {
        for (const fee of ['1.01', '0.1234567890123456789']) {
            expect(validateOraclePriceValue({ value: '1', fee, block_time: LEGACY_BLOCK_TIME }, 'mainnet', 'BTC'))
                .to.equal('invalid fee');
        }
    });

    it('accepts an eight-decimal value while the mainnet canonical gate is inactive', function () {
        const price = { value: '1.23456789', block_time: LEGACY_BLOCK_TIME };
        expect(isPriceV1CanonicalActive(LEGACY_BLOCK_TIME, 'mainnet', 'BTC')).to.equal(false);
        expect(validateOraclePriceValue(price, 'mainnet', 'BTC')).to.equal(null);
    });
}

function registerWireFieldTests() {
    it('rejects non-integer action indexes and block times', function () {
        expect(validateOraclePriceWireFields({ action_index: 1.5, block_time: 10 }))
            .to.deep.equal({ reason: 'invalid action_index' });
        expect(validateOraclePriceWireFields({ action_index: 1, block_time: 10.5 }))
            .to.deep.equal({ reason: 'invalid block_time' });
    });

    it('parses the action index and clamps negative or absent push generations', function () {
        for (const price of [
            { action_index: '7', block_time: 10, push_generation: -3 },
            { action_index: '7', block_time: 10 }
        ]) {
            expect(validateOraclePriceWireFields(price)).to.deep.equal({ pushGeneration: 0, actionIndex: 7 });
        }
    });
}

function registerEffectiveAtTests() {
    it('adds one day to the effective time', function () {
        expect(effectiveAtFor(1700000000)).to.equal(1700086400);
    });
}

describe('oracle price single validation helpers', function () {
    registerIdentityTests();
    registerValueTests();
    registerWireFieldTests();
    registerEffectiveAtTests();
});
