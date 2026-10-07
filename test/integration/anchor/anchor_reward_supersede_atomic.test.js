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

// The anchor-reward supersede on a real MariaDB: a winner whose INSERT fails after the
// incumbent's DELETE must leave the incumbent row, never zero rows for the anchor.
// The control replays the old two-autocommit sequence and shows it loses the row, so
// the incumbent assertion can fail. Needs MariaDB (TEST_DB_*); skips without it.

const { expect }    = require('chai');
const testDb        = require('../../helpers/testDb');
const RewardTracker = require('../../../src/anchor/reward_tracker');

const PK_LOW  = 'aa'.repeat(32);
const PK_HIGH = 'bb'.repeat(32);
const ROUND   = 42;
const TYPE    = 'anchor_BTC';
const BLOCK   = 100;

// A statement the server itself refuses, so the failure is MariaDB's, not a stub's.
const FAILING_INSERT = 'INSERT INTO validator_rewards (no_such_column) VALUES (1)';

async function anchorRows(db) {
    let rows = await db.findValidatorRewardsByRoundNumber(ROUND, TYPE, 0);
    return rows.map(r => r.validator_pubkey).sort();
}

function tracker(db) {
    return new RewardTracker({ db, network: '', p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '10.00000000' } });
}

async function rejectionOf(promise) {
    try { await promise; } catch (e) { return e; }
    return null;
}

describe('anchor reward supersede is atomic on MariaDB', function () {
    this.timeout(30000);
    let db = null;

    before(async function () {
        try { await testDb.setup(); } catch (e) { return this.skip(); }
        db = testDb.getDb();
    });
    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        await db.createValidatorAnchorReward(PK_HIGH, ROUND, TYPE, '10.00000000', BLOCK, 0);
    });

    it('runs on a transactional engine, without which a rollback is a silent no-op', async function () {
        let rows = await db.doQuery("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'validator_rewards'");
        expect(rows[0].ENGINE).to.equal('InnoDB');
    });

    it('replaces the incumbent with the lower pubkey', async function () {
        await tracker(db).recordAnchorReward(TYPE, ROUND, PK_LOW, BLOCK, '');
        expect(await anchorRows(db)).to.deep.equal([PK_LOW]);
    });

    it('keeps the incumbent when the winner\'s INSERT fails after the DELETE ran', async function () {
        db.createSupersedingValidatorAnchorReward = conn => conn.query(FAILING_INSERT);
        try {
            let err = await rejectionOf(tracker(db).recordAnchorReward(TYPE, ROUND, PK_LOW, BLOCK, ''));
            expect(err, 'the supersede must reject').to.be.an('error');
        } finally { delete db.createSupersedingValidatorAnchorReward; }

        expect(await anchorRows(db)).to.deep.equal([PK_HIGH]);
    });

    it('control: the old autocommit DELETE then failed INSERT leaves no row at all', async function () {
        await db.doQuery('DELETE FROM validator_rewards WHERE round_number = ? AND reward_type = ? AND round_qualifier = ? AND batch_seq IS NULL',
            [ROUND, TYPE, 0]);
        await rejectionOf(db.doQuery(FAILING_INSERT));

        expect(await anchorRows(db)).to.deep.equal([]);
    });
});
