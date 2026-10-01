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
 * Bridge policy hash.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const {
    policyHash,
    policyHashText
} = require('../../../../../src/cross_chain/bridge/policy_hash.js');
const policyPoll = require('../../../../../src/cross_chain/bridge/policy_poll.js');

describe('bridge policy hash', function(){
    it('matches the current hash when neither side uses a reference', function(){
        const cases = [
            [null, null, false],
            [[], ['a', 'b'], true],
            [['x'], null, false]
        ];
        for(const args of cases){
            expect(policyHash(...args)).to.equal(policyPoll.policyHash(...args));
        }
    });

    it('spells an allow reference beside a one-member block list', function(){
        expect(policyHashText(null, ['a'], false, { allow: 'DOGE:2701' }))
            .to.equal('ALLOW|REF|DOGE:2701|BLOCK|1|a|SLEEP|0');
    });

    it('spells references on both sides', function(){
        expect(policyHashText(['ignored'], null, true, {
            allow: 'LTC:9',
            block: 'BTC:7'
        })).to.equal('ALLOW|REF|LTC:9|BLOCK|REF|BTC:7|SLEEP|1');
    });

    it('falls back to the list for null references', function(){
        expect(policyHashText(['b', 'a'], [], false, {
            allow: null,
            block: undefined
        })).to.equal('ALLOW|2|b|a|BLOCK|0|SLEEP|0');
    });

    it('matches the sibling indexer with and without references', function(){
        const src = path.resolve(__dirname, '../../../../../src');
        const indexerDir = process.env.XCHAIN_INDEXER_DIR || path.join(src, '..', '..', 'xchain-indexer');
        const membershipPath = path.join(indexerDir, 'src', 'consensus', 'bridge_settle', 'policy_membership.js');
        if(!fs.existsSync(membershipPath)){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1'){
                expect.fail('xchain-indexer sibling is absent at ' + membershipPath);
            }
            this.skip();
            return;
        }

        const membership = require(membershipPath);
        const cases = [
            [null, null, false, undefined],
            [[], ['a', 'b'], true, undefined],
            [['x'], null, false, undefined],
            [['a'], ['b'], true, { allow: 'DOGE:2701' }],
            [['a'], ['b'], true, { block: 'BTC:7' }],
            [['a'], ['b'], true, { allow: 'LTC:9', block: 'DOGE:1' }],
            [['a'], ['b'], true, { allow: null, block: undefined }]
        ];
        for(const args of cases){
            expect(policyHash(...args)).to.equal(membership.policyHash(...args));
        }
    });
});
