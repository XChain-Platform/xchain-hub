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

// bin/consensus-identity.js's top-level error handling. main() is synchronous and
// throws on a bad --compare target and on the gate-carrier refusal, so without a
// catch at the entry point that exception reaches Node's default uncaught-exception
// handler: exit 1 with a raw stack, where the indexer's copy of this same tool exits
// 2 with one clean line. Driven as a real child process, because the behaviour under
// test is what Node does with an uncaught throw, which an in-process stub cannot show.

const { expect } = require('chai');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN  = path.resolve(__dirname, '../../../bin/consensus-identity.js');
const REPO = path.resolve(__dirname, '../../..');

function run(args) {
    return spawnSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8' });
}

describe('bin/consensus-identity.js: top-level error handling', function () {
    this.timeout(20000);

    it('exits 0 and still prints the identity on the healthy path', function () {
        const res = run(['--json']);
        expect(res.status, res.stderr).to.equal(0);
        expect(() => JSON.parse(res.stdout)).to.not.throw();
    });

    it('exits 2 with one clean stderr line, not a raw stack, on a thrown error', function () {
        const res = run(['--compare', path.join(REPO, 'no-such-consensus-pin.json')]);
        expect(res.status).to.equal(2);
        expect(res.stderr).to.match(/^consensus-identity: /);
        // A raw Node stack carries the module's own frames; the clean handler's
        // one-liner carries none, so this is the line that tells the two apart.
        expect(res.stderr).to.not.match(/^\s+at /m);
    });

    it('refuses an unknown flag before measuring the checkout', function () {
        const res = run(['--out', 'ignored.json']);
        expect(res.status).to.equal(2);
        expect(res.stdout).to.equal('');
        expect(res.stderr).to.include('REFUSING: unknown flag --out');
        expect(res.stderr).to.include('Usage: node bin/consensus-identity.js [--json] [--compare <pin>]');
    });

    it('refuses a bare positional argument the same way', function () {
        const res = run(['pin.json']);
        expect(res.status).to.equal(2);
        expect(res.stderr).to.include('REFUSING: unknown flag pin.json');
    });

    it('keeps JSON output and committed-pin comparison working', function () {
        const json = run(['--json']);
        const comparison = run(['--compare', path.join(REPO, 'bin/pins/at1-consensus-identity.json')]);
        expect(json.status, json.stderr).to.equal(0);
        expect(() => JSON.parse(json.stdout)).to.not.throw();
        expect(comparison.status, comparison.stdout + comparison.stderr).to.equal(0);
        expect(comparison.stdout).to.match(/^consensus identity holds against /);
    });

    it('documents only the JSON and compare pin workflows', function () {
        const res = run(['--help']);
        expect(res.status, res.stderr).to.equal(0);
        expect(res.stdout).to.include('node bin/consensus-identity.js --json');
        expect(res.stdout).to.include('node bin/consensus-identity.js --compare <pin>');
        expect(res.stdout).to.not.include('--out');
    });
});
