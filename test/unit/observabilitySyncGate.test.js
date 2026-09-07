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

// The vendored observability shim has a gate, and the gate has teeth.
//
// src/observability/ is CANONICAL here and bin/sync-observability.sh copies it
// verbatim into six consumer repos. For months the only thing enforcing that
// parity was the sentence claiming it was enforced: no npm script, no workflow
// and no gate ran the script, four ported suite headers told readers a CI check
// existed, and the indexer's copy sat drifted with every suite green.
//
// This suite proves the two halves that were missing:
//
//   1. BEHAVIOUR. Run the real script against a throwaway platform root and
//      confirm a one-byte edit to a vendored copy exits non-zero, that a missing
//      file does, and that an ABSENT consumer does too rather than skipping into
//      a green result that compared nothing.
//   2. WIRING. Confirm the script is reachable from something that actually
//      runs: the check:observability-sync npm script, the drift tier in
//      bin/ci-full.sh (the pre-push venue gate), the drift-guards job of
//      .github/workflows/ci.yml, and the .ci-siblings roster that puts the
//      consumers beside this repo on the venue. Behaviour without wiring is
//      what the ledger entry was about, so a test for one without the other
//      would re-open the same hole.
//
// The ported suite headers in the consumer repos are checked too, against the
// sibling checkout when it is there: a header that describes a mechanism which
// does not exist is how this started.

const { expect } = require('chai');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'bin', 'sync-observability.sh');
const CANONICAL_DIR = path.join(REPO_ROOT, 'src', 'observability');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(REPO_ROOT, '..');

// The file list and the consumer roster are read out of the script rather than
// restated, so adding a consumer or a file there cannot leave this suite
// asserting against a stale copy of the truth.
const SCRIPT_TEXT = fs.readFileSync(SCRIPT, 'utf8');

function bashArray(name) {
    const match = SCRIPT_TEXT.match(new RegExp(`^${name}=\\((.*)\\)$`, 'm'));
    return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

const CONSUMERS = bashArray('CONSUMERS');
const FILES = bashArray('FILES');

/** A throwaway platform root holding an in-sync vendored copy per consumer. */
function makeFixture(consumers) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-sync-gate-'));
    for (const consumer of consumers) {
        const dir = path.join(root, consumer, 'src', 'observability');
        fs.mkdirSync(dir, { recursive: true });
        for (const file of FILES) {
            fs.copyFileSync(path.join(CANONICAL_DIR, file), path.join(dir, file));
        }
    }
    return root;
}

function runCheck(root, extraArgs = []) {
    return spawnSync('bash', [SCRIPT, '--check', ...extraArgs], {
        env: Object.assign({}, process.env, { XCHAIN_PLATFORM_ROOT: root }),
        encoding: 'utf8'
    });
}

describe('observability shim: the vendored-copy parity gate', function () {
    this.timeout(20000);

    const roots = [];
    function fixture(consumers = CONSUMERS) {
        const root = makeFixture(consumers);
        roots.push(root);
        return root;
    }

    after(function () {
        for (const root of roots) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('reads a non-empty consumer roster and file list from the script', function () {
        // Everything below is asserted against these two lists; empty lists would
        // make the whole suite vacuously green.
        expect(CONSUMERS).to.have.length.of.at.least(1);
        expect(FILES).to.have.length.of.at.least(1);
        for (const consumer of CONSUMERS) expect(consumer).to.match(/^xchain-[a-z-]+$/);
    });

    describe('behaviour', function () {

        it('passes when every vendored copy is byte-identical', function () {
            const res = runCheck(fixture());
            expect(res.status, res.stdout + res.stderr).to.equal(0);
            expect(res.stdout).to.contain('OK:');
            expect(res.stdout).to.not.contain('DRIFT');
        });

        it('fails on a deliberate one-byte edit to a vendored copy', function () {
            const root = fixture();
            const victim = path.join(root, CONSUMERS[0], 'src', 'observability', FILES[0]);
            fs.appendFileSync(victim, '\n');

            const res = runCheck(root);
            expect(res.status, 'a drifted copy must exit non-zero').to.equal(1);
            expect(res.stdout).to.contain(`DRIFT  ${CONSUMERS[0]}/src/observability/${FILES[0]}`);
            expect(res.stderr).to.contain('drifted from xchain-hub/src/observability');
        });

        it('fails when a vendored file has been deleted outright', function () {
            const root = fixture();
            fs.rmSync(path.join(root, CONSUMERS[0], 'src', 'observability', FILES[0]));

            const res = runCheck(root);
            expect(res.status).to.equal(1);
            expect(res.stdout).to.contain('DRIFT');
        });

        it('fails when a consumer checkout is absent, instead of skipping green', function () {
            // The failure mode this replaces: a venue missing one consumer
            // compared five of six and printed OK, so the sixth could drift for
            // as long as the layout stayed broken.
            const absent = CONSUMERS[CONSUMERS.length - 1];
            const root = fixture(CONSUMERS.filter((c) => c !== absent));

            const res = runCheck(root);
            expect(res.status, 'an absent consumer must be red').to.equal(1);
            expect(res.stdout).to.contain(`MISSING ${absent}`);
            expect(res.stderr).to.contain('proved nothing');
        });

        it('accepts an absent consumer only when --allow-missing is passed', function () {
            const absent = CONSUMERS[CONSUMERS.length - 1];
            const root = fixture(CONSUMERS.filter((c) => c !== absent));

            const res = runCheck(root, ['--allow-missing']);
            expect(res.status, res.stdout + res.stderr).to.equal(0);
            expect(res.stdout).to.contain(`skip   ${absent}`);
        });

        it('rejects an unknown flag rather than silently checking nothing', function () {
            const res = runCheck(fixture(), ['--not-a-flag']);
            expect(res.status).to.equal(2);
        });
    });

    describe('wiring: the check is reachable from something that runs', function () {

        it('is exposed as the check:observability-sync npm script', function () {
            const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
            const script = pkg.scripts['check:observability-sync'];
            expect(script, 'package.json must expose the check as a script').to.be.a('string');
            expect(script).to.contain('bin/sync-observability.sh');
            expect(script).to.contain('--check');
            expect(script, 'the gate must not opt out of the missing-consumer failure')
                .to.not.contain('--allow-missing');
        });

        it('runs as a drift tier of bin/ci-full.sh, the pre-push venue gate', function () {
            const ciFull = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'ci-full.sh'), 'utf8');
            expect(ciFull).to.contain('check:observability-sync');
            expect(ciFull, 'the tier must be declared with run_tier so a failure is reported')
                .to.match(/run_tier "drift: vendored observability shim[^"]*"/);
        });

        it('requires every consumer checkout in bin/ci-full.sh, so the tier cannot skip', function () {
            const ciFull = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'ci-full.sh'), 'utf8');
            const needSib = ciFull.match(/^need_sib [\s\S]*?(?=\n\n)/m);
            expect(needSib, 'bin/ci-full.sh must call need_sib').to.not.equal(null);
            const required = needSib[0].replace(/\\\n/g, ' ').split(/\s+/);
            for (const consumer of CONSUMERS) {
                expect(required, `${consumer} must be required by ci-full.sh`).to.contain(consumer);
            }
        });

        it('runs in the drift-guards job of .github/workflows/ci.yml', function () {
            const ci = fs.readFileSync(
                path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
            const driftJob = ci.slice(ci.indexOf('\n  drift-guards:'));
            expect(driftJob, 'ci.yml must have a drift-guards job').to.not.equal('');
            expect(driftJob).to.contain('check:observability-sync');
            expect(driftJob, 'the job must clone the consumers it compares against')
                .to.contain('sync-observability.sh');
        });

        it('declares every consumer in .ci-siblings, so the venue ships them', function () {
            const declared = fs.readFileSync(path.join(REPO_ROOT, '.ci-siblings'), 'utf8')
                .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
            for (const consumer of CONSUMERS) {
                expect(declared, `${consumer} is compared by the gate but never checked out`)
                    .to.contain(consumer);
            }
        });
    });

    describe('the ported suite headers describe the mechanism that exists', function () {

        // Skips per consumer when the sibling is absent, the same way every other
        // cross-repo guard here does; test/unit/sibling-coverage.test.js is what
        // reports which of them could not run.
        for (const consumer of CONSUMERS) {
            it(`${consumer}: its ported observability suite names the real gate`, function () {
                const suite = path.join(SIBLING_ROOT, consumer, 'test', 'unit', 'observability.test.js');
                if (!fs.existsSync(suite)) return this.skip();

                const header = fs.readFileSync(suite, 'utf8').split('\nconst ')[0];
                expect(header, 'the header must name the script that enforces parity')
                    .to.contain('sync-observability.sh');
                expect(header, 'a header claiming a check "in CI" without naming it is what drifted')
                    .to.not.match(/parity is gated by a\s*\n\/\/ check across the vendored copies in CI/);
            });
        }
    });
});
