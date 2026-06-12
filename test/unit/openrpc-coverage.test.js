/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Drift guard: docs/openrpc.json must list exactly the methods exposed by
 * the jsonRpcController in src/api.js, and its x-auth flags must match the
 * WRITE_METHODS set. Regenerate with: node docs/openrpc.build.js
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

describe('openrpc.json method coverage', () => {

    const src  = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/openrpc.json'), 'utf8'));

    const block = src.slice(src.indexOf('jsonRpcController = {'), src.indexOf('jsonRouter('));
    const controllerMethods = [...block.matchAll(/^\s{8}async\s+([a-z][a-z0-9_]*)\s*\(/gm)].map((m) => m[1]);

    const writeBlock = src.slice(src.indexOf('WRITE_METHODS'), src.indexOf(']', src.indexOf('WRITE_METHODS')));
    const writeMethods = [...writeBlock.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);

    it('extracts sane method lists', () => {
        assert.ok(controllerMethods.includes('ping') && controllerMethods.includes('getallconfigs'),
            `controller extraction broken: ${controllerMethods.join(', ')}`);
        assert.ok(writeMethods.includes('updateconfig'), 'WRITE_METHODS extraction broken');
    });

    it('spec methods === controller methods', () => {
        assert.deepStrictEqual(spec.methods.map((m) => m.name).sort(), [...controllerMethods].sort());
    });

    it('spec x-auth flags === WRITE_METHODS', () => {
        const flagged = spec.methods.filter((m) => m['x-auth']).map((m) => m.name).sort();
        assert.deepStrictEqual(flagged, [...writeMethods].sort());
    });

    it('every method has a summary and by-name params', () => {
        for (const m of spec.methods) {
            assert.ok(m.summary && m.summary.length, `${m.name} summary`);
            assert.strictEqual(m.paramStructure, 'by-name', `${m.name} paramStructure`);
        }
    });
});
