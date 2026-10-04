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

const messageTypes = require('../../../../src/anchor/reorg_handler/message_types.js');

const EXPECTED_KEYS = [
    'REORG_ALERT',
    'XCHAIN_REORG_PREPARE',
    'XCHAIN_REORG_COMMIT'
];

describe('reorg message types', function () {
    it('exports exactly the reorg wire names', function () {
        assert.deepStrictEqual(Object.keys(messageTypes).sort(), [...EXPECTED_KEYS].sort());
    });

    it('uses each export key as its wire value', function () {
        for (const key of EXPECTED_KEYS) assert.strictEqual(messageTypes[key], key);
    });

    it('keeps every wire value distinct', function () {
        const values = EXPECTED_KEYS.map(key => messageTypes[key]);
        assert.strictEqual(new Set(values).size, EXPECTED_KEYS.length);
    });
});
