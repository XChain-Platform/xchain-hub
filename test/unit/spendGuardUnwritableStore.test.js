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

/*
 * _persist() caught its write failure, warned once and returned, and
 * reserve() ignored the outcome: the token came back and the caller broadcast a
 * spend that no file on disk records. After the restart that store reads ENOENT,
 * the window comes back empty, and the allowance is handed out again - once per
 * restart, without bound, which is the shape this whole file exists to stop.
 *
 * Operator ruling (2026-09-09, re-affirmed 2026-09-11, option a): fail closed. An
 * unpersisted reservation refuses the broadcast; a hub on a read-only disk goes
 * visibly silent rather than authorising an unrecorded spend.
 *
 * These tests drive a REAL read-only state path, not a stubbed fs, and assert the
 * behaviour that follows from it: no token, no consumed budget, no broadcast.
 */
describe('SpendGuard: a reservation that cannot be persisted refuses the broadcast', function () {
    const made = [];
    let root, store, statePath, guard;

    beforeEach(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'spendguard-rw2ro-'));
        made.push(root);
        store = path.join(root, 'store');
        fs.mkdirSync(store);
        statePath = path.join(store, 'spend-state.json');
        // Arm while the store is writable, so the guard starts on a genuine first run
        // with a full allowance. Only the WRITE path is what these tests break.
        guard = makeGuard(statePath);
        expect(guard.spentInWindow(Date.now())).to.equal(0);
    });

    afterEach(function () {
        while (made.length) {
            const dir = made.pop();
            try { fs.chmodSync(path.join(dir, 'store'), 0o700); } catch (e) { /* already gone */ }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
        }
    });

    // Turn the armed store read-only and drop anything already written, which is what
    // a disk remounted read-only under a running hub looks like from here.
    function breakTheStore() {
        try { fs.rmSync(statePath, { force: true }); } catch (e) { /* not written yet */ }
        fs.chmodSync(store, 0o500);
        expect(() => fs.accessSync(store, fs.constants.W_OK)).to.throw();
    }
    function healTheStore() {
        fs.chmodSync(store, 0o700);
    }

    it('reserve() returns null when the write fails, instead of a token', function () {
        breakTheStore();
        expect(guard.reserve(), 'an unrecordable reservation must not authorise a send')
            .to.equal(null);
    });

    it('the refused reservation consumes no budget and holds no count slot', function () {
        breakTheStore();
        guard.reserve();

        expect(guard.spentInWindow(Date.now()),
            'a reservation rolled back must not leave its cost in the window').to.equal(0);
        expect(guard.stats().count.inWindow,
            'nor a slot in the count ceiling').to.equal(0);
    });

    it('stays refused for every later attempt while the store stays broken', function () {
        breakTheStore();
        for (let i = 0; i < 3; i++) expect(guard.reserve()).to.equal(null);
        // The warn-once flag must not become an allow-after-the-first-warning.
        expect(guard.blocked.persist, 'each refusal is counted').to.equal(3);
    });

    it('the pure-predicate pair refuses too, once the store has refused a write', function () {
        breakTheStore();
        guard.reserve();                                  // proves the store broken

        expect(guard.allow(), 'allow() must not green-light an unrecordable spend').to.equal(false);
        const verdict = guard.check();
        expect(verdict.ok).to.equal(false);
        expect(verdict.reason).to.match(/unwritable/i);
        expect(guard.noteBlocked(), 'the skip line names the real cause').to.match(/unwritable/i);
    });

    it('surfaces the broken store in stats() so the silence is explainable', function () {
        breakTheStore();
        guard.reserve();
        const s = guard.stats();
        expect(s.persistBroken).to.equal(true);
        expect(s.persistError).to.be.a('string').and.not.empty;
    });

    it('resumes on its own when the store accepts writes again', function () {
        breakTheStore();
        expect(guard.reserve()).to.equal(null);

        healTheStore();
        const token = guard.reserve();
        expect(token, 'a store that came back must not need a restart to notice').to.be.an('object');
        expect(fs.existsSync(statePath), 'and the reservation is on disk this time').to.equal(true);
        expect(guard.spentInWindow(Date.now())).to.equal(100);
        expect(guard.stats().persistBroken).to.equal(false);
    });

    it('a restart inherits every reservation that was authorised, and no others', function () {
        // The invariant the ruling buys: what reserve() authorised is exactly what the
        // next process inherits. One send under a writable store, then the store
        // breaks; the refused attempts leave no phantom budget AND cost the restart
        // nothing it did not really spend.
        expect(guard.reserve(), 'the first send is authorised').to.be.an('object');

        // Freeze the FILE rather than its directory, so the already-written state
        // survives for the restart to read while further writes are refused - which is
        // the shape that matters here.
        fs.chmodSync(statePath, 0o400);
        expect(() => fs.accessSync(statePath, fs.constants.W_OK)).to.throw();
        expect(guard.reserve(), 'the second is refused, the store cannot record it').to.equal(null);
        expect(guard.reserve()).to.equal(null);

        const after = makeGuard(statePath);
        expect(after.spentInWindow(Date.now()),
            'exactly the one authorised send comes back').to.equal(100);
    });

    it('a post-broadcast record() still never throws, and still binds in memory', function () {
        // record() runs AFTER the send went out; there is nothing left to refuse, so
        // the fail-closed rule must not turn it into a throw on the broadcast path.
        breakTheStore();
        expect(() => guard.record()).to.not.throw();
        expect(guard.spentInWindow(Date.now()),
            'the in-memory ceiling still binds this process').to.equal(100);
    });
});
