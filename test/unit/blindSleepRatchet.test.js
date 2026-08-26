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

// ratchet: the test tree carries no fixed-duration sleep standing in for
// a poll on an observable condition. The 43 that existed were converted to
// test/helpers/waitUntil.js; this keeps the count at zero, because the shape
// re-enters one `await sleep(200)` at a time and only fails on someone else's
// loaded CI box. The predicate's own exemptions (poll intervals, deadlines,
// scheduler yields, helper definitions) are pinned below so a future tightening
// cannot silently start flagging the legitimate shapes.

const { expect } = require('chai');
const { scan, blindSleepSites } = require('../../bin/check-blind-sleeps');

describe('blind-sleep ratchet', function () {

    // Hold a ceiling wide enough for a loaded venue: scan() walks and parses the
    // whole test tree synchronously, so its cost tracks the box, not this diff,
    // and mocha's 5s default made a ratchet against CI flake into one.
    it('the test tree contains no blind-sleep waits', function () {
        this.timeout(60000);
        let findings = scan();
        let detail = findings.map(f =>
            f.file + ': ' + f.sites.map(s => 'line ' + s.line).join(', ')).join('\n');
        expect(findings.length,
            'fixed sleeps standing in for a condition poll (use test/helpers/waitUntil.js):\n' + detail
        ).to.equal(0);
    });

    it('counts a fixed settle between an action and its assertion', function () {
        let sites = blindSleepSites([
            "it('finalizes', async function () {",
            '    await engine.propose();',
            '    await new Promise(r => setTimeout(r, 200));',
            '    expect(engine.finalized).to.be.true;',
            '});'
        ].join('\n'));
        expect(sites.map(s => s.line)).to.deep.equal([3]);
    });

    it('does not count a sleep used as a poll interval inside a bounded loop', function () {
        let sites = blindSleepSites([
            'for (let i = 0; i < 20; i++) {',
            '    if (engine.finalized) break;',
            '    await new Promise(r => setTimeout(r, 10));',
            '}'
        ].join('\n'));
        expect(sites).to.have.lengthOf(0);
    });

    it('does not count a rejecting deadline or a scheduler yield', function () {
        let sites = blindSleepSites([
            'let deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), 500));',
            'await new Promise(r => setTimeout(r, 0));'
        ].join('\n'));
        expect(sites).to.have.lengthOf(0);
    });

    it('does not count a wait helper definition, only its call sites', function () {
        let sites = blindSleepSites([
            "it('waits', async function () {",
            '    const pause = (ms) => new Promise(r => setTimeout(r, ms));',
            '    await pause(50);',
            '});'
        ].join('\n'));
        expect(sites.map(s => s.line)).to.deep.equal([3]);
    });
});
