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

const { expect } = require('chai');
const boundsMixin = require('../../../../src/validators/governance/bounds.js');
const {
    MAX_INCREASE, MAX_DECREASE, MAX_SLASH_INCREASE, MAX_SLASH_DECREASE, SLASHING_PARAMS
} = require('../../../../src/validators/governance/rules.js');
const { ORACLE_DEVIATION_THRESHOLD } = require('../../../../src/constants.js');

const CURRENT_CENTS = 10000n;
const CURRENT_VALUE = '100.00';
const NON_SLASH_PARAMETER = 'ORDINARY_PARAMETER';
const SLASH_PARAMETER = SLASHING_PARAMS.find((parameter) => parameter !== 'SLASH_DEVIATION_THRESHOLD');

function decimalFromScaled(value, scale) {
    let negative = value < 0n;
    let digits = String(negative ? -value : value).padStart(scale + 1, '0');
    let decimal = scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits;
    return (negative ? '-' : '') + decimal;
}

function rateHundredths(rate) {
    let parts = String(rate).split('.');
    return BigInt(parts[0]) * 100n + BigInt((parts[1] || '').padEnd(2, '0'));
}

function proposedAt(rate, direction, offsetCents) {
    let change = CURRENT_CENTS * rateHundredths(rate) / 100n;
    let boundary = direction === 'increase' ? CURRENT_CENTS + change : CURRENT_CENTS - change;
    return decimalFromScaled(boundary + BigInt(offsetCents), 2);
}

function adjacentDecimal(value, offsetUnits) {
    let parts = String(value).split('.');
    let scale = (parts[1] || '').length;
    let scaled = BigInt(parts[0] + (parts[1] || '')) + BigInt(offsetUnits);
    return decimalFromScaled(scaled, scale);
}

const RATIO_CASES = [
    { parameter: NON_SLASH_PARAMETER, direction: 'increase', rate: MAX_INCREASE, inside: -1, past: 1 },
    { parameter: NON_SLASH_PARAMETER, direction: 'decrease', rate: MAX_DECREASE, inside: 1, past: -1 },
    { parameter: SLASH_PARAMETER, direction: 'increase', rate: MAX_SLASH_INCREASE, inside: -1, past: 1 },
    { parameter: SLASH_PARAMETER, direction: 'decrease', rate: MAX_SLASH_DECREASE, inside: 1, past: -1 }
];

function registerRatioBoundTests(bounds) {
    for (const scenario of RATIO_CASES) {
        it('enforces the ' + scenario.direction + ' bound for ' + scenario.parameter, function () {
            let inside = proposedAt(scenario.rate, scenario.direction, scenario.inside);
            let past = proposedAt(scenario.rate, scenario.direction, scenario.past);
            expect(() => bounds.validateChangeRatio(scenario.parameter, CURRENT_VALUE, inside)).to.not.throw();
            expect(() => bounds.validateChangeRatio(scenario.parameter, CURRENT_VALUE, past))
                .to.throw('Proposed ' + scenario.direction);
        });
    }
}

describe('governance bounds mixin', function () {
    let bounds = Object.assign({}, boundsMixin);

    registerRatioBoundTests(bounds);

    it('skips non-slash ratios with zero or unparseable values', function () {
        expect(() => bounds.validateChangeRatio(NON_SLASH_PARAMETER, '0', '999999')).to.not.throw();
        expect(() => bounds.validateChangeRatio(NON_SLASH_PARAMETER, 'not-a-number', '999999')).to.not.throw();
        expect(() => bounds.validateChangeRatio(NON_SLASH_PARAMETER, CURRENT_VALUE, '1e9')).to.not.throw();
    });

    it('rejects non-plain-decimal slash proposals', function () {
        expect(() => bounds.validateChangeRatio(SLASH_PARAMETER, CURRENT_VALUE, '1e2'))
            .to.throw('must be a plain decimal');
        expect(() => bounds.validateChangeRatio(SLASH_PARAMETER, CURRENT_VALUE, '120 trailing'))
            .to.throw('must be a plain decimal');
    });

    it('ignores the slash band floor for other parameters', function () {
        expect(() => bounds.validateSlashBandFloor(NON_SLASH_PARAMETER, 'not-a-number')).to.not.throw();
    });

    it('rejects invalid and sub-floor slash deviation thresholds', function () {
        expect(() => bounds.validateSlashBandFloor('SLASH_DEVIATION_THRESHOLD', 'not-a-number'))
            .to.throw('not a valid number');
        expect(() => bounds.validateSlashBandFloor(
            'SLASH_DEVIATION_THRESHOLD', adjacentDecimal(ORACLE_DEVIATION_THRESHOLD, -1)
        )).to.throw('below the federation-uniform');
    });

    it('accepts slash deviation thresholds at or above the oracle floor', function () {
        expect(() => bounds.validateSlashBandFloor(
            'SLASH_DEVIATION_THRESHOLD', String(ORACLE_DEVIATION_THRESHOLD)
        )).to.not.throw();
        expect(() => bounds.validateSlashBandFloor(
            'SLASH_DEVIATION_THRESHOLD', adjacentDecimal(ORACLE_DEVIATION_THRESHOLD, 1)
        )).to.not.throw();
    });

    it('applies ratio and floor checks through validateChangeBounds', function () {
        let inside = proposedAt(MAX_INCREASE, 'increase', -1);
        let past = proposedAt(MAX_INCREASE, 'increase', 1);
        expect(() => bounds.validateChangeBounds(NON_SLASH_PARAMETER, CURRENT_VALUE, inside)).to.not.throw();
        expect(() => bounds.validateChangeBounds(NON_SLASH_PARAMETER, CURRENT_VALUE, past))
            .to.throw('Proposed increase');
    });
});
