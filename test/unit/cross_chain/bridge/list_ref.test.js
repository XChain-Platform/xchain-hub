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
 * Bridge policy list reference parsing.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const { parseListRef, formatListRef, sideKind } = require('../../../../src/cross_chain/bridge/list_ref.js');

describe('bridge policy list references', function(){
    describe('parseListRef', function(){
        it('parses an allowed chain and preserves the decimal index string', function(){
            expect(parseListRef('DOGE:2701')).to.deep.equal({ chain: 'DOGE', index: '2701' });
            expect(parseListRef('BTC:999999999999999')).to.deep.equal({
                chain: 'BTC',
                index: '999999999999999'
            });
        });

        it('rejects malformed, non-positive, oversized, and unknown references', function(){
            const invalid = [
                'DOGE:0',
                'DOGE:012',
                'doge:5',
                'ETH:5',
                'DOGE:',
                'DOGE:5:6',
                'DOGE:1000000000000000',
                5,
                null
            ];
            for(const value of invalid) expect(parseListRef(value)).to.equal(null);
        });

        it('uses a caller-supplied allowed chain set', function(){
            expect(parseListRef('ETH:5', ['ETH'])).to.deep.equal({ chain: 'ETH', index: '5' });
            expect(parseListRef('DOGE:5', ['ETH'])).to.equal(null);
            expect(parseListRef('eth:5', ['ETH'])).to.equal(null);
        });
    });

    it('formats references that round trip through the parser', function(){
        const formatted = formatListRef('BTC', '7');
        expect(formatted).to.equal('BTC:7');
        expect(parseListRef(formatted)).to.deep.equal({ chain: 'BTC', index: '7' });
    });

    describe('sideKind', function(){
        it('distinguishes members, references, and absent sides', function(){
            expect(sideKind([])).to.equal('members');
            expect(sideKind(['member'])).to.equal('members');
            expect(sideKind('BTC:7')).to.equal('ref');
            expect(sideKind(null)).to.equal('none');
            expect(sideKind(undefined)).to.equal('none');
        });

        it('marks every other shape as bad', function(){
            expect(sideKind('BTC:07')).to.equal('bad');
            expect(sideKind({})).to.equal('bad');
            expect(sideKind(7)).to.equal('bad');
        });
    });
});
