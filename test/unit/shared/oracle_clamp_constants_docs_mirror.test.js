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
//
// The per-round move clamp bounds every published oracle price, so the published
// protocol constants carry its values beside PRICE_MAX and ORACLE_DEVIATION_THRESHOLD.
// Only the documentation mirrors these two; the other constant mirrors do not, which is
// why they are checked here rather than in the six-mirror band-constants gate.

const fs   = require('fs');
const path = require('path');
const { expect }   = require('chai');
const constants    = require('../../../src/constants');
const { maxChangeForPair } = require('../../../src/oracle/consensus/constants.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const MIRRORED = ['ORACLE_MAX_CHANGE_PER_ROUND', 'XCHAIN_PRICE_MAX_CHANGE_PER_ROUND'];

// Walk up to the nearest package.json, as the band-constants gate does.
function findRepoRoot() {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        let up = path.dirname(dir);
        if (up === dir) throw new Error('no package.json above ' + __dirname);
        dir = up;
    }
    return dir;
}

describe('oracle clamp constants agree with the published documentation constants', function () {
    it('the hub clamp table applies the two mirrored values', function () {
        expect(maxChangeForPair('XCHAIN/USD')).to.equal(constants.XCHAIN_PRICE_MAX_CHANGE_PER_ROUND);
        expect(maxChangeForPair('BTC/USD')).to.equal(constants.ORACLE_MAX_CHANGE_PER_ROUND);
    });

    it('xchain-documentation protocol/constants.js declares the canonical clamp values', function () {
        let abs = path.join(path.dirname(findRepoRoot()), 'xchain-documentation', 'protocol', 'constants.js');
        if (!skipOrFail(this, siblingCheckout(__dirname, abs), 'the oracle clamp constants mirror')) return;
        let resolved = require.resolve(abs);
        delete require.cache[resolved];
        let theirs = require(resolved);
        for (let name of MIRRORED) {
            expect(theirs[name], 'xchain-documentation/protocol/constants.js: ' + name + ' = ' + theirs[name] +
                ', but xchain-hub/src/constants.js says ' + constants[name]).to.equal(constants[name]);
        }
    });
});
