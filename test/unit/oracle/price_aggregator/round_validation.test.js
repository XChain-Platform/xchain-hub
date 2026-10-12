'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    validateRoundFields,
    validateRoundSigs
} = require('../../../../src/oracle/price_aggregator/round_validation.js');

const PUBKEY = 'AB'.repeat(32);
const SIG = 'CD'.repeat(64);

function makeCtx(bandReason) {
    return { refuseOutOfBandRound: () => bandReason || null };
}

function makeRound(overrides) {
    return Object.assign({
        round: 5,
        timestamp: 9,
        block_index: 3,
        btc_block_height: 7,
        pairs: [{ pair: 'BTC/USD', price: '1' }]
    }, overrides);
}

function fields(data, ctx) {
    return validateRoundFields.call(ctx || makeCtx(), 'BTC', data);
}

describe('round_validation validateRoundFields', function () {
    it('returns the parsed header values', function () {
        expect(fields(makeRound())).to.deep.equal({ round: 5, timestamp: 9, referenceBlock: 3, btcBlockHeight: 7 });
    });

    it('refuses null data and an empty pairs array', function () {
        expect(fields(null)).to.deep.equal({ reason: 'invalid roundData' });
        expect(fields(makeRound({ pairs: [] }))).to.deep.equal({ reason: 'invalid roundData' });
    });

    for (const [label, overrides, reason] of [
        ['a negative round', { round: -1 }, 'invalid round'],
        ['a non-numeric timestamp', { timestamp: 'abc' }, 'invalid timestamp'],
        ['a negative block_index', { block_index: -1 }, 'invalid block_index'],
        ['a missing btc_block_height', { btc_block_height: undefined }, 'invalid btc_block_height']
    ]) {
        it('refuses ' + label, function () {
            expect(fields(makeRound(overrides))).to.deep.equal({ reason });
        });
    }

    it('returns the out of band reason from the context', function () {
        expect(fields(makeRound(), makeCtx('out of band'))).to.deep.equal({ reason: 'out of band' });
    });
});

describe('round_validation validateRoundSigs', function () {
    const bad = [
        ['no sigs', {}],
        ['an empty list', { sigs: [] }],
        ['a short pubkey', { sigs: [{ pubkey: 'ab', sig: SIG }] }],
        ['a short sig', { sigs: [{ pubkey: PUBKEY, sig: 'cd' }] }],
        ['a non-hex pubkey', { sigs: [{ pubkey: 'GG'.repeat(32), sig: SIG }] }],
        ['a non-hex sig', { sigs: [{ pubkey: PUBKEY, sig: 'ZZ'.repeat(64) }] }]
    ];
    for (const [label, data] of bad) {
        it('refuses ' + label, function () {
            expect(validateRoundSigs.call({}, data)).to.deep.equal({ reason: 'invalid sigs' });
        });
    }

    it('lower-cases valid entries in order', function () {
        const other = 'EF'.repeat(32);
        const result = validateRoundSigs.call({}, {
            sigs: [{ pubkey: PUBKEY, sig: SIG }, { pubkey: other, sig: SIG }]
        });
        expect(result).to.deep.equal({
            sigs: [
                { pubkey: PUBKEY.toLowerCase(), sig: SIG.toLowerCase() },
                { pubkey: other.toLowerCase(), sig: SIG.toLowerCase() }
            ]
        });
    });
});
