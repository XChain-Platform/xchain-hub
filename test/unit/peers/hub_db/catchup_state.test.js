'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { MIRRORED_TABLES } = require('../../../../src/peers/hub_db/catchup_verifiers.js');
const { createCatchupState } = require('../../../../src/peers/hub_db/catchup_state.js');

describe('catch-up state', function () {
    it('starts every mirrored table behind', function () {
        const state = createCatchupState();

        expect(state.isCaughtUp()).to.equal(false);
        expect(state.status()).to.deep.equal(
            Object.fromEntries(MIRRORED_TABLES.map(table => [table, false]))
        );
    });

    it('is not caught up when ten of eleven tables are caught up', function () {
        const state = createCatchupState();
        MIRRORED_TABLES.slice(0, -1).forEach(table => state.markCaughtUp(table));

        expect(state.isCaughtUp()).to.equal(false);
        expect(state.isTableCaughtUp(MIRRORED_TABLES.at(-1))).to.equal(false);
    });

    it('is caught up when every table is caught up', function () {
        const state = createCatchupState();
        MIRRORED_TABLES.forEach(table => state.markCaughtUp(table));

        expect(state.isCaughtUp()).to.equal(true);
    });

    it('falls behind when one caught-up table is marked behind', function () {
        const state = createCatchupState();
        MIRRORED_TABLES.forEach(table => state.markCaughtUp(table));

        state.markBehind(MIRRORED_TABLES[0]);

        expect(state.isCaughtUp()).to.equal(false);
        expect(state.isTableCaughtUp(MIRRORED_TABLES[0])).to.equal(false);
    });

    it('resets every table to behind', function () {
        const state = createCatchupState();
        MIRRORED_TABLES.forEach(table => state.markCaughtUp(table));

        state.resetAll();

        expect(state.isCaughtUp()).to.equal(false);
        expect(Object.values(state.status())).to.deep.equal(
            MIRRORED_TABLES.map(() => false)
        );
    });

    it('throws for an unknown table on every per-table operation', function () {
        const state = createCatchupState();

        expect(() => state.markCaughtUp('unknown_table')).to.throw('Unknown catch-up table: unknown_table');
        expect(() => state.markBehind('unknown_table')).to.throw('Unknown catch-up table: unknown_table');
        expect(() => state.isTableCaughtUp('unknown_table')).to.throw('Unknown catch-up table: unknown_table');
    });

    it('returns status snapshots whose edits do not change the tracker', function () {
        const state = createCatchupState();
        const table = MIRRORED_TABLES[0];
        const snapshot = state.status();

        snapshot[table] = true;

        expect(Object.getPrototypeOf(snapshot)).to.equal(Object.prototype);
        expect(state.isTableCaughtUp(table)).to.equal(false);
        expect(state.status()).to.not.equal(snapshot);
    });

    it('tracks a custom two-table list independently', function () {
        const state = createCatchupState(['first', 'second']);

        state.markCaughtUp('first');
        expect(state.status()).to.deep.equal({ first: true, second: false });
        expect(state.isCaughtUp()).to.equal(false);

        state.markCaughtUp('second');
        expect(state.isCaughtUp()).to.equal(true);
        expect(() => state.isTableCaughtUp(MIRRORED_TABLES[0])).to.throw();
    });

    it('rejects empty and non-array table lists', function () {
        expect(() => createCatchupState([])).to.throw(TypeError, 'non-empty array');
        expect(() => createCatchupState('first')).to.throw(TypeError, 'non-empty array');
        expect(() => createCatchupState(null)).to.throw(TypeError, 'non-empty array');
    });
});
