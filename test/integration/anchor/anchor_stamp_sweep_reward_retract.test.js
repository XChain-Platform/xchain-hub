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

// The anchor stamp sweep clears the stamp of an own bundle whose transaction vanished and,
// on a real MariaDB, retracts the hub-local anchor_bundle reward written at broadcast.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../src/anchor/publisher');
const RewardTracker = require('../../../src/anchor/reward_tracker');
const testDb = require('../../helpers/testDb');

const ME = 'aa'.repeat(32);
const PEER = '11'.repeat(32);
const LOST_TXID = 'ab'.repeat(32);
const OTHER_TXID = 'cd'.repeat(32);
const BUNDLE_BLOCK = 1000;

let db;

// Insert one checkpoint section, stamped with `txid` when given.
async function section(chain, seq, snapshotBlock, txid) {
    await db.doQuery(
        'INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, ' +
        'contract_hash, checkpoint_seq, snapshot_block, validator_signatures, anchor_txid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [chain, 'regtest', 500 + seq, 'h', 'l', 'a', 'c', seq, snapshotBlock, '[]', txid || null]);
}

// Record this hub's own publisher marker for a section it sent at DOGE height 100.
async function marker(chain, seq, txid) {
    await db.doQuery(
        'INSERT INTO anchor_published_checkpoints (chain, network, checkpoint_seq, txid, sent_doge_height, sent_at) ' +
        'VALUES (?, ?, ?, ?, ?, NOW())', [chain, 'regtest', seq, txid, 100]);
}

async function reward(pubkey, round, batchSeq) {
    await db.createValidatorAnchorReward(pubkey, round, 'anchor_bundle', '10.00000000', round, 0);
    if (batchSeq != null) {
        await db.doQuery('UPDATE validator_rewards SET batch_seq = ? WHERE validator_pubkey = ? AND round_number = ?',
            [batchSeq, pubkey, round]);
    }
}

async function rewardsOf(pubkey) {
    const rows = await db.doQuery(
        "SELECT round_number, batch_seq FROM validator_rewards WHERE validator_pubkey = ? AND reward_type = 'anchor_bundle' " +
        'ORDER BY round_number', [pubkey]);
    return rows.map(r => [Number(r.round_number), r.batch_seq == null ? null : Number(r.batch_seq)]);
}

function publisher(status) {
    const hub = { db, p2pConfig: {}, getIdentity: () => ({ getPubkeyHex: () => ME }) };
    hub.rewardTracker = new RewardTracker(hub);
    const pub = new StateAnchorPublisher(hub);
    pub.anchorStampReorgDepth = 10;
    pub.encoder = { async getTxStatus() { return { status: status || 'unknown' }; } };
    pub.indexerCall = async () => ({ block_index: 110 });
    return pub;
}

// A two-section bundle: BTC at the bundle block and LTC below it, both stamped by `txid`.
async function lostBundle(txid) {
    await section('BTC', 1, BUNDLE_BLOCK, txid);
    await section('LTC', 2, BUNDLE_BLOCK - 2, txid);
    await marker('BTC', 1, txid);
    await marker('LTC', 2, txid);
}

// Set up the test database once, empty the swept tables before each case and tear it down after.
function registerDbLifecycle() {
    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            if (Object.prototype.hasOwnProperty.call(process.env, 'TEST_DB_PASS')) throw e;
            console.warn('MariaDB unavailable; skipping the anchor stamp sweep reward test');
            this.skip();
        }
    });

    beforeEach(async function () {
        for (const table of ['state_checkpoints', 'anchor_published_checkpoints', 'validator_rewards'])
            await db.doQuery('DELETE FROM ' + table);
    });

    after(async function () {
        await testDb.teardown();
    });
}

describe('Integration: anchor stamp sweep retracts the reward of a vanished own bundle', function () {
    this.timeout(30000);
    registerDbLifecycle();

    it('retracts only this hub\'s unarchived reward at the bundle block', async function () {
        await lostBundle(LOST_TXID);
        await reward(ME, BUNDLE_BLOCK);
        await reward(ME, BUNDLE_BLOCK - 10);
        await reward(PEER, BUNDLE_BLOCK);

        expect(await publisher().sweepAnchorStamps()).to.equal(2);

        expect(await rewardsOf(ME)).to.deep.equal([[BUNDLE_BLOCK - 10, null]]);
        expect(await rewardsOf(PEER)).to.deep.equal([[BUNDLE_BLOCK, null]]);
        const stamps = await db.doQuery('SELECT anchor_txid FROM state_checkpoints');
        expect(stamps.map(s => s.anchor_txid)).to.deep.equal([null, null]);
    });

    it('keeps a reward that already rode an archive', async function () {
        await lostBundle(LOST_TXID);
        await reward(ME, BUNDLE_BLOCK, 7);

        expect(await publisher().sweepAnchorStamps()).to.equal(2);
        expect(await rewardsOf(ME)).to.deep.equal([[BUNDLE_BLOCK, 7]]);
    });

    it('keeps the reward while another stamp at the bundle block still stands', async function () {
        await lostBundle(LOST_TXID);
        await section('DOGE', 3, BUNDLE_BLOCK, OTHER_TXID);
        await reward(ME, BUNDLE_BLOCK);

        expect(await publisher().sweepAnchorStamps()).to.equal(2);
        expect(await rewardsOf(ME)).to.deep.equal([[BUNDLE_BLOCK, null]]);
    });

    it('keeps the stamp and the reward while the transaction is still in the mempool', async function () {
        await lostBundle(LOST_TXID);
        await reward(ME, BUNDLE_BLOCK);

        expect(await publisher('mempool').sweepAnchorStamps()).to.equal(0);
        expect(await rewardsOf(ME)).to.deep.equal([[BUNDLE_BLOCK, null]]);
    });
});
