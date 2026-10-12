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

// The hub-local round split depends only on the set of distinct signing keys, never on
// their case, repetition or order.

const { expect }        = require('chai');
const RewardTracker     = require('../../../src/anchor/reward_tracker');
const { createMockHub } = require('../../helpers/mockHub');

const KEYS = ['a', 'b', 'c', 'd'].map(c => c.repeat(64));

async function insertedRows(participants) {
    const rt = new RewardTracker(createMockHub({ p2pConfig: { ORACLE_REWARD_PER_ROUND: '10.00000000' } }));
    await rt.distributeRewards(4786, participants, 100);
    return rt.db.doQuery.getCalls()
        .filter(c => String(c.args[0]).includes('INSERT IGNORE INTO validator_rewards'))
        .map(c => c.args[1]);
}

describe('RewardTracker.distributeRewards recipient set determinism', function () {
    it('splits across distinct keys only, ignoring repeats', async function () {
        const rows = await insertedRows([...KEYS, ...KEYS]);
        expect(rows).to.have.length(4);
        for (const r of rows) expect(r).to.include('2.50000000');
    });

    it('treats case variants of one key as one recipient', async function () {
        const rows = await insertedRows([KEYS[0], KEYS[0].toUpperCase(), KEYS[1], KEYS[2], KEYS[3]]);
        expect(rows).to.have.length(4);
        for (const r of rows) expect(r).to.include('2.50000000');
    });

    it('produces identical rows for any input order', async function () {
        const fwd = await insertedRows(KEYS);
        const rev = await insertedRows([...KEYS].reverse());
        expect(rev).to.deep.equal(fwd);
    });
});
