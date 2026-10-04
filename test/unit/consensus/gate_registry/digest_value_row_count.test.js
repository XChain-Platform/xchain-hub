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

const { SHARED_GATES } = require('../../../../src/consensus_rules_digest.js');
const registry = require('../../../../src/consensus/gate_registry.js');

const REGISTRY_FILE = path.join(__dirname, '../../../../src/consensus/gate_registry.js');

describe('gate_registry: digest value-row count @regression @tier1', function () {
    it('keeps the registry comment and shared digest counts pinned together', function () {
        const keys = SHARED_GATES.flatMap(([mod, names]) => names.map(name => mod + '.' + name));
        const valueRows = keys.filter(key => registry.has(key)).length;
        const functionKeys = keys.length - valueRows;
        const copiedValueRows = keys.filter(key =>
            key === 'oracle_round_time_activation.ORACLE_ROUND_TIME_ACTIVATION' && registry.has(key)).length;
        const source = fs.readFileSync(REGISTRY_FILE, 'utf8');
        const valueMatch = source.match(/all (\d+) of the digest's value rows/);
        const functionMatch = source.match(/its other (\d+) keys/);

        assert.ok(valueMatch, 'registry comment states the digest value-row count');
        assert.ok(functionMatch, 'registry comment states the digest function-key count');
        assert.strictEqual(copiedValueRows, 1);
        assert.strictEqual(Number(valueMatch[1]), valueRows - copiedValueRows);
        assert.strictEqual(Number(functionMatch[1]), functionKeys);
        assert.strictEqual(valueRows, 39);
        assert.strictEqual(functionKeys, 4);
        assert.strictEqual(keys.length, 43);
    });
});
