/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * One exact acorn version across the carrier-pin twin repos. The pin module
 * hashes acorn's token stream, so a tokenizer difference between twins reads
 * as a twin mismatch; xchain-indexer is held at xchain-vm's consensus parser
 * pin, so hub and sync follow it. Sibling checks skip when the sibling is not
 * checked out unless XCHAIN_REQUIRE_SIBLINGS=1, as in carrier_logic_pin.test.js.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const pinModule = require('../../../bin/lib/carrier_logic_pin.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Read the acorn spec a checkout declares, runtime dependency first.
function declaredAcorn(dir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return (pkg.dependencies || {}).acorn || (pkg.devDependencies || {}).acorn;
}

describe('acorn pin across the carrier-pin twin repos', function () {
    it('declares acorn at one exact version, and the lockfile resolves that version', function () {
        const spec = declaredAcorn(REPO_ROOT);
        // Refuse a range: two installs of one range can resolve two tokenizers.
        assert.match(String(spec), /^\d+\.\d+\.\d+$/, `acorn must be an exact version, got ${spec}`);
        const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
        assert.strictEqual(lock.packages[''].dependencies.acorn, spec, 'lockfile root disagrees with package.json');
        assert.strictEqual(lock.packages['node_modules/acorn'].version, spec, 'lockfile resolves a different acorn');
    });

    it('declares the same acorn version as every sibling twin repo', function () {
        const self = pinModule.repoName(REPO_ROOT);
        const spec = declaredAcorn(REPO_ROOT);
        const siblings = pinModule.MODULE_TWINS.filter((repo) => repo !== self);
        assert.ok(siblings.length >= 2, 'the twin list must name the other carrier-pin repos');
        const missing = [];
        for (const repo of siblings) {
            const dir = pinModule.siblingDir(repo, REPO_ROOT);
            if (!fs.existsSync(path.join(dir, 'package.json'))) { missing.push(repo); continue; }
            assert.strictEqual(declaredAcorn(dir), spec, `${self} pins acorn ${spec} but ${repo} pins `
                + `${declaredAcorn(dir)}; the twins move together, and xchain-indexer is held by xchain-vm's consensus pin`);
        }
        if (!missing.length) return;
        if (REQUIRE_SIBLINGS) assert.fail(`${missing.join(', ')} not checked out beside this repo and XCHAIN_REQUIRE_SIBLINGS=1`);
        this.skip();
    });
});
