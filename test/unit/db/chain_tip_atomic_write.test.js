'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// setChainTip wrote height, time and chain id as three statements, so a getChainTip
// between them returned the new height with the old block_time: the pushed tip's
// freshness was then dated by the previous block, and after a regtest re-genesis the
// same window could pair a new height with the old chain id. The tip is one write now.

const { expect }     = require('chai');
const { DB_METHODS } = require('../../helpers/mockHub.js');

// A configs table whose every statement yields to the event loop first, so a reader
// interleaves with a writer exactly where a pooled connection would.
function configsDb() {
    const rows = new Map();
    const db = { ...DB_METHODS, statements: 0,
        async doQuery(sql, p) {
            p = p || [];
            await new Promise(r => setImmediate(r));
            if (sql.includes('INSERT INTO configs')) {
                db.statements++;
                const n = (p.length === 6) ? 1 : p.length / 5;
                for (let i = 0; i < n; i++) {
                    const [coin, network, module, param_name, param_value] = p.slice(i * 5, i * 5 + 5);
                    rows.set([coin, network, module, param_name].join('|'), { coin, network, module, param_name, param_value });
                }
                return [];
            }
            if (sql.startsWith('SELECT param_name, param_value FROM configs WHERE coin = ? AND network = ? AND module = ?'))
                return [...rows.values()].filter(r => r.coin === p[0] && r.network === p[1] && r.module === p[2]);
            return [];
        } };
    return db;
}

async function readsDuring(db, write) {
    const seen = [];
    const w = write();
    for (let i = 0; i < 6; i++) seen.push(await db.getChainTip('BTC', 'regtest'));
    await w;
    return seen;
}

describe('db.setChainTip writes the tip in one statement', function () {
    it('a concurrent reader sees the old tip or the new one, never a mix', async function () {
        const db = configsDb();
        const ID_A = 'aa'.repeat(32), ID_B = 'bb'.repeat(32);
        await db.setChainTip('BTC', 'regtest', 500, 1700000000, ID_A);
        const before = db.statements;
        const seen = await readsDuring(db, () => db.setChainTip('BTC', 'regtest', 501, 1700000600, ID_B));
        expect(db.statements - before, 'one statement per tip').to.equal(1);
        const whole = new Set([
            JSON.stringify({ blockHeight: 500, blockTime: 1700000000, chainId: ID_A }),
            JSON.stringify({ blockHeight: 501, blockTime: 1700000600, chainId: ID_B })
        ]);
        for (const t of seen) expect(whole.has(JSON.stringify(t)), 'torn read ' + JSON.stringify(t)).to.equal(true);
        expect(await db.getChainTip('BTC', 'regtest')).to.deep.equal({ blockHeight: 501, blockTime: 1700000600, chainId: ID_B });
    });

    it('a push without a chain id keeps the stored id and is still one statement', async function () {
        const db = configsDb();
        await db.setChainTip('BTC', 'regtest', 500, 1700000000, 'aa'.repeat(32));
        const before = db.statements;
        await db.setChainTip('BTC', 'regtest', 501, 1700000600);
        expect(db.statements - before).to.equal(1);
        expect(await db.getChainTip('BTC', 'regtest')).to.deep.equal({ blockHeight: 501, blockTime: 1700000600, chainId: 'aa'.repeat(32) });
    });
});
