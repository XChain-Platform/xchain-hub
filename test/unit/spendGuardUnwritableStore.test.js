/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * An absent spend-state file has two causes and only one of them has earned a
 * fresh allowance.
 *
 * _loadState's own header states that every one of its rules is fail-closed, and
 * the corrupt-file rule beside it seeds the window CONSUMED on the principle that
 * a broken store must never read as a green light. The absent-file rule did not
 * follow it: it returned an empty window, which is right for a genuine first run
 * and wrong for a store that cannot be written at all. On a read-only disk
 * _persist() lands no byte, so the file never appears, every restart reads ENOENT,
 * and the per-window ceiling is unbounded across restarts.
 *
 * These tests hold the distinction by its failure mode: an unwritable store must
 * come back consumed, and a genuine first run must still come back empty. The
 * first fails against a guard that treats every ENOENT as a first run.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

const SpendGuard = require('../../src/lib/spend_guard.js');

// Build a guard with a small, obvious cap so "consumed" is unambiguous.
const CAP_CENTS = 1000;

function makeGuard(statePath) {
    const guard = new SpendGuard('TEST', {
        TEST_MAX_SPEND_USD_CENTS_PER_WINDOW: CAP_CENTS,
        TEST_EST_SPEND_USD_CENTS: 100,
    }, 'test-guard');
    return guard.persistTo(statePath);
}

describe('SpendGuard: an absent state file is not always a first run', function () {
    const made = [];

    afterEach(function () {
        // Restore write permission before cleanup, or the rmdir fails for the same
        // reason the test exists.
        while (made.length) {
            const dir = made.pop();
            try { fs.chmodSync(dir, 0o700); } catch (e) { /* already gone */ }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
        }
    });

    it('seeds the window CONSUMED when the store directory refuses writes', function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spendguard-ro-'));
        made.push(root);
        const store = path.join(root, 'store');
        fs.mkdirSync(store);
        fs.chmodSync(store, 0o500);                       // r-x, no write

        // The probe must agree with reality before the assertion means anything.
        expect(() => fs.accessSync(store, fs.constants.W_OK)).to.throw();

        const guard = makeGuard(path.join(store, 'spend-state.json'));

        expect(guard.spentInWindow(Date.now()))
            .to.equal(CAP_CENTS, "an unwritable store must read as a spent window, not a fresh one");
        expect(guard.allow()).to.equal(false, 'a spent window must refuse the next spend');
    });

    it('still starts empty on a genuine first run, where the store accepts writes', function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spendguard-rw-'));
        made.push(root);

        const guard = makeGuard(path.join(root, 'spend-state.json'));

        expect(guard.spentInWindow(Date.now()))
            .to.equal(0, 'a writable store with no file yet is a first run');
        expect(guard.allow()).to.equal(true, 'a first run must not be gated');
    });

    it('treats an absent directory under a writable parent as a first run', function () {
        // _persist() mkdirs the tree it needs, so a missing leaf directory under a
        // writable parent is still a store this hub can write.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spendguard-mk-'));
        made.push(root);

        const guard = makeGuard(path.join(root, 'not', 'made', 'yet', 'spend-state.json'));

        expect(guard.spentInWindow(Date.now())).to.equal(0);
        expect(guard.allow()).to.equal(true);
    });
});
