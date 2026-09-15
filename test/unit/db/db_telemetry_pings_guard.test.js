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
 * src/db/telemetry_pings.js interpolates its `days` window straight into an
 * INTERVAL literal because MariaDB will not bind a placeholder inside one, so
 * assertTelemetryWindowDays is the ONLY thing standing between a caller and a
 * string landing in that literal verbatim. The routes already clamp the value
 * to 1..365 before calling, but nothing here held the statement-side guard
 * itself, so a route bug (or a future caller) that skipped the clamp had no
 * test naming what would happen. Every guarded method shares one assert
 * function, so this drives all four rather than trusting one to stand for
 * the rest.
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const Database = require('../../../src/db');

// Async functions never throw synchronously: assertTelemetryWindowDays runs
// before any `await`, so a hostile `days` value rejects the returned promise
// rather than throwing at the call site. This drives that rejection and
// fails loudly if the call resolves instead.
async function assertRejects(fn) {
    let threw = false;
    try {
        await fn();
    } catch (err) {
        threw = true;
        expect(err.message).to.match(/positive whole number of days/);
    }
    expect(threw, 'expected the call to reject').to.equal(true);
}

function recordingDb() {
    const db = Object.create(Database.prototype);
    db.calls = [];
    db.doQuery = async function (sql, params) {
        db.calls.push({ sql, params: params || [] });
        return [];
    };
    return db;
}

// Every method this mixin exports that funnels `days` through the shared guard.
const GUARDED_METHODS = [
    'findLatestTelemetryPingPerInstall',
    'getTelemetryPingCountInWindow',
    'findLatestTelemetryOperatorPingPerInstall',
    'findTelemetryPingStatsPerInstall',
];

// Hostile inputs the guard must refuse before the statement is ever built: a
// non-integer, a non-positive integer, and inputs that would put attacker text
// straight into the INTERVAL literal if the guard were not there.
const HOSTILE_INPUTS = [0, -1, 1.5, '30) OR (1=1', '5 UNION SELECT 1', null, undefined, NaN];

describe('db/telemetry_pings.js: the window-days guard', function () {
    for (const method of GUARDED_METHODS) {
        describe(method, function () {
            it('accepts a positive integer and inlines it into the statement', async function () {
                const db = recordingDb();
                await db[method](30);
                expect(db.calls).to.have.length(1);
                expect(db.calls[0].sql).to.include('30');
            });

            for (const bad of HOSTILE_INPUTS) {
                it('refuses ' + String(bad) + ' before any statement is built', async function () {
                    const db = recordingDb();
                    await assertRejects(() => db[method](bad));
                    expect(db.calls, 'doQuery must not have been reached').to.have.length(0);
                });
            }
        });
    }
});
