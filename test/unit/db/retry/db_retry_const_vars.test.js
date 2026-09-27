'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '../../../../src/db/index.js');

describe('database connection retry declarations', function () {
    const source = fs.readFileSync(SOURCE_FILE, 'utf8');
    const methodMatch = source.match(/async getConnection\(\)\{([\s\S]*?)^    \}/m);

    assert.ok(methodMatch, 'getConnection method body is present');
    const methodBody = methodMatch[1];

    for (const name of ['maxAttempts', 'baseDelay', 'maxDelay', 'delay', 'jitter']) {
        it('declares ' + name + ' with const', function () {
            assert.match(methodBody, new RegExp('\\bconst\\s+' + name + '\\b'));
            assert.doesNotMatch(methodBody, new RegExp('\\blet\\s+' + name + '\\b'));
        });
    }
});
