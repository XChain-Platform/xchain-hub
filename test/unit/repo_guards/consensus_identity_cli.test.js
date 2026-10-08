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
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN  = path.resolve(__dirname, '../../../bin/consensus-identity.js');
const REPO = path.resolve(__dirname, '../../..');
const SUITE_TITLE_PIN = path.join(REPO, 'bin/pins/at1-suite-titles.json');
const PIN  = path.join(REPO, 'bin/pins/at1-consensus-identity.json');

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

    it('matches the committed identity pin on the healthy path', function () {
        const res = run(['--compare', PIN]);
        expect(res.status, res.stdout + res.stderr).to.equal(0);
    });

    it('exits 2 with one clean stderr line, not a raw stack, on a thrown error', function () {
        const res = run(['--compare', path.join(REPO, 'no-such-consensus-pin.json')]);
        expect(res.status).to.equal(2);
        expect(res.stderr).to.match(/^consensus-identity: /);
        // A raw Node stack carries the module's own frames; the clean handler's
        // one-liner carries none, so this is the line that tells the two apart.
        expect(res.stderr).to.not.match(/^\s+at /m);
    });

    it('exits 2 naming an unknown flag instead of ignoring it', function () {
        const res = run(['--assert-no-absnet']);
        expect(res.status).to.equal(2);
        expect(res.stderr).to.match(/^consensus-identity: unknown flag --assert-no-absnet/);
        expect(res.stdout).to.equal('');
    });

    it('exits 2 naming a value flag whose value is missing', function () {
        const res = run(['--out']);
        expect(res.status).to.equal(2);
        expect(res.stderr).to.equal('consensus-identity: --out requires a value\n');
        expect(res.stdout).to.equal('');
    });

    it('refuses a flag in the value position instead of consuming it as the path', function () {
        // Consumed as a path, the flag would write a file of that name and drop the assertion.
        const res = run(['--out', '--assert-no-absent']);
        expect(res.status).to.equal(2);
        expect(res.stderr).to.equal('consensus-identity: --out requires a value\n');
        expect(res.stdout).to.equal('');
        expect(fs.existsSync(path.join(REPO, '--assert-no-absent'))).to.equal(false);
    });
});

describe('at1 suite-title pin metadata', function () {
    it('matches each script file map and referenced title sets', function () {
        const pin = JSON.parse(fs.readFileSync(SUITE_TITLE_PIN, 'utf8'));

        for (const [name, script] of Object.entries(pin.scripts)) {
            if (!script.files) continue;
            const references = Object.values(script.files);
            expect(script.fileCount, `${name} fileCount`).to.equal(references.length);
            expect(script.titleCount, `${name} titleCount`).to.equal(references.reduce((sum, key) => {
                expect(pin.titleSets, `${name} title set ${key}`).to.have.property(key);
                return sum + pin.titleSets[key].length;
            }, 0));
        }
    });
});
