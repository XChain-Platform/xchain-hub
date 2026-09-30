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
//
// Registers the per-table snapshot envelope cases for the chain identity suite.

const { expect } = require('chai');

function registerSnapshotTableTests(getEnv, { fakeRes, tables, localId }) {
    for (const table of tables) {
        it(table + ': the envelope carries btc_chain_id', async function () {
            const { routes, db } = getEnv();
            const res = fakeRes();
            await routes['/hub-db/snapshot/' + table]({ query: {} }, res);
            const env = res.parsed();
            expect(env.table).to.equal(table);
            expect(env.btc_chain_id).to.equal(localId);
            // The identity is read for BITCOIN on the hub's own network: a DOGE mirror
            // must be told the BTC chain the rows are anchored to, not its own.
            expect(db.lastTipArgs).to.deep.equal(['bitcoin', 'regtest']);
        });

        it(table + ': btc_chain_id is null when no indexer has reported one', async function () {
            const { routes, db } = getEnv();
            db.chainTip = null;
            const res = fakeRes();
            await routes['/hub-db/snapshot/' + table]({ query: {} }, res);
            expect(res.parsed().btc_chain_id).to.equal(null);
        });

        it(table + ': an unreadable identity serves null, never a 500', async function () {
            const { routes, db } = getEnv();
            db.chainTipThrows = true;
            const res = fakeRes();
            await routes['/hub-db/snapshot/' + table]({ query: {} }, res);
            expect(res.statusCode).to.equal(200);
            expect(res.parsed().btc_chain_id).to.equal(null);
            expect(res.parsed().rows).to.have.lengthOf(1);
        });
    }
}

module.exports = { registerSnapshotTableTests };
