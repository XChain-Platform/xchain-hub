'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const { MIRRORED_TABLES } = require('./catchup_verifiers.js');

function createCatchupState(tables = MIRRORED_TABLES) {
    if (!Array.isArray(tables) || tables.length === 0) {
        throw new TypeError('Catch-up tables must be a non-empty array');
    }

    const tableStates = new Map(tables.map(table => [table, false]));

    function assertKnownTable(table) {
        if (!tableStates.has(table)) {
            throw new Error('Unknown catch-up table: ' + table);
        }
    }

    function markCaughtUp(table) {
        assertKnownTable(table);
        tableStates.set(table, true);
    }

    function markBehind(table) {
        assertKnownTable(table);
        tableStates.set(table, false);
    }

    function isTableCaughtUp(table) {
        assertKnownTable(table);
        return tableStates.get(table);
    }

    function resetAll() {
        for (const table of tableStates.keys()) {
            tableStates.set(table, false);
        }
    }

    function isCaughtUp() {
        return Array.from(tableStates.values()).every(Boolean);
    }

    function status() {
        return Object.fromEntries(tableStates);
    }

    return {
        markCaughtUp,
        markBehind,
        isTableCaughtUp,
        resetAll,
        isCaughtUp,
        status
    };
}

module.exports = { createCatchupState };
