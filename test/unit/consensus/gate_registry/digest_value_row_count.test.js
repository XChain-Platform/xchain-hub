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
const { SHARED_GATES } = require('../../../../src/consensus_rules_digest.js');
const registry = require('../../../../src/consensus/gate_registry.js');

describe('gate_registry: digest value-row count @regression @tier1', function () {
    it('keeps the shared digest row and function counts pinned', function () {
        const keys = SHARED_GATES.flatMap(([mod, names]) => names.map(name => mod + '.' + name));
        const valueRows = keys.filter(key => registry.has(key)).length;
        const functionKeys = keys.length - valueRows;

        assert.strictEqual(valueRows, 39);
        assert.strictEqual(functionKeys, 4);
        assert.strictEqual(keys.length, 43);
    });
});
