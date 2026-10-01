/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Bridge policy column codec.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const {
    parsePolicyColumn,
    policyColumnText
} = require('../../../../../src/cross_chain/bridge/policy_column.js');

describe('parsePolicyColumn', function(){
    it('keeps absent columns detached', function(){
        expect(parsePolicyColumn(null, true)).to.equal(null);
        expect(parsePolicyColumn(undefined, false)).to.equal(null);
    });

    it('reads array members as strings', function(){
        expect(parsePolicyColumn(JSON.stringify(['a', 5, false]), false)).to.deep.equal([
            'a',
            '5',
            'false'
        ]);
    });

    it('reads valid references only when explicitly allowed', function(){
        const raw = JSON.stringify('DOGE:2701');
        expect(parsePolicyColumn(raw, true)).to.deep.equal({ ref: 'DOGE:2701' });
        expect(parsePolicyColumn(raw, false)).to.equal(undefined);
        expect(parsePolicyColumn(raw, 1)).to.equal(undefined);
    });

    it('refuses malformed and unsupported references', function(){
        expect(parsePolicyColumn(JSON.stringify('DOGE:012'), true)).to.equal(undefined);
        expect(parsePolicyColumn(JSON.stringify('ETH:5'), true)).to.equal(undefined);
    });

    it('refuses invalid JSON and unsupported JSON shapes', function(){
        expect(parsePolicyColumn('[', true)).to.equal(undefined);
        expect(parsePolicyColumn(JSON.stringify({ a: 1 }), true)).to.equal(undefined);
        expect(parsePolicyColumn(JSON.stringify(5), true)).to.equal(undefined);
        expect(parsePolicyColumn(JSON.stringify(null), true)).to.equal(undefined);
    });
});

describe('policyColumnText', function(){
    it('writes null and arrays', function(){
        expect(policyColumnText(null)).to.equal(null);
        expect(policyColumnText(['a', 5])).to.equal(JSON.stringify(['a', 5]));
    });

    it('writes accepted reference objects', function(){
        expect(policyColumnText({ ref: 'BTC:7' })).to.equal(JSON.stringify('BTC:7'));
    });

    it('rejects every other value', function(){
        const invalid = [
            undefined,
            'BTC:7',
            { ref: 'BTC:07' },
            { ref: 'ETH:5' },
            {},
            5
        ];
        for(const value of invalid){
            expect(() => policyColumnText(value)).to.throw(TypeError);
        }
    });
});

describe('bridge policy column round trips', function(){
    it('round trips arrays and references', function(){
        const members = ['a', '5'];
        expect(parsePolicyColumn(policyColumnText(members), true)).to.deep.equal(members);

        const reference = { ref: 'LTC:9' };
        expect(parsePolicyColumn(policyColumnText(reference), true)).to.deep.equal(reference);
    });
});
