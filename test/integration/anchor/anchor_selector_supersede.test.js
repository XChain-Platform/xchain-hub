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

// The anchor bundle selector, run as real SQL on MariaDB, never returns a plain checkpoint
// a later supersede marker covers and never falls back to an older seq when it drops one.

const { expect } = require('chai');
const testDb = require('../../helpers/testDb');

const DIGEST = 'ab'.repeat(32);

let db;

// Insert one checkpoint row; `supersedesFrom` makes it a supersede marker.
async function row(chain, network, seq, blockIndex, opts) {
    const o = opts || {};
    await db.doQuery(
        'INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, ' +
        'contract_hash, checkpoint_seq, snapshot_block, validator_signatures, anchor_txid, supersedes_from, rules_digest) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [chain, network, blockIndex, 'h', 'l', 'a', 'c', seq, 100, '[]', o.txid || null,
         o.supersedesFrom == null ? null : o.supersedesFrom, o.supersedesFrom == null ? null : DIGEST]);
}

async function selected(step, everyN, network) {
    const rows = network
        ? await db.findAnchorEligibleUnanchoredCheckpointsByNetwork(step, everyN, network)
        : await db.findAnchorEligibleUnanchoredCheckpoints(step, everyN);
    return rows.map(r => [r.chain, r.network, Number(r.checkpoint_seq)])
        .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

// Set up the test database once, empty the checkpoint table before each case and tear it down after.
function registerDbLifecycle() {
    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            if (Object.prototype.hasOwnProperty.call(process.env, 'TEST_DB_PASS')) throw e;
            console.warn('MariaDB unavailable; skipping the anchor selector supersede test');
            this.skip();
        }
    });

    beforeEach(async function () {
        await db.doQuery('DELETE FROM state_checkpoints');
    });

    after(async function () {
        await testDb.teardown();
    });
}

describe('Integration: anchor selector drops marker-superseded checkpoints', function () {
    this.timeout(30000);
    registerDbLifecycle();

    it('returns the newest eligible unanchored plain row when no marker exists', async function () {
        await row('BTC', 'regtest', 1, 501);
        await row('BTC', 'regtest', 2, 502);
        expect(await selected(1, 1)).to.deep.equal([['BTC', 'regtest', 2]]);
    });

    it('returns nothing for a chain whose newest plain row a later marker covers', async function () {
        await row('BTC', 'regtest', 1, 501);
        await row('BTC', 'regtest', 2, 502);
        await row('BTC', 'regtest', 3, 503, { supersedesFrom: 502 });
        expect(await selected(1, 1), 'neither the superseded row nor an older seq').to.deep.equal([]);
    });

    it('returns a newer plain row once one lands above the marker', async function () {
        await row('BTC', 'regtest', 1, 501);
        await row('BTC', 'regtest', 2, 502);
        await row('BTC', 'regtest', 3, 503, { supersedesFrom: 502 });
        await row('BTC', 'regtest', 4, 504);
        expect(await selected(1, 1)).to.deep.equal([['BTC', 'regtest', 4]]);
    });

    it('keeps the newest row when the marker floor sits above its block', async function () {
        await row('BTC', 'regtest', 2, 502);
        await row('BTC', 'regtest', 3, 503, { supersedesFrom: 503 });
        expect(await selected(1, 1)).to.deep.equal([['BTC', 'regtest', 2]]);
    });

    it('keeps returning nothing when the newest eligible row is anchored', async function () {
        await row('BTC', 'regtest', 1, 501);
        await row('BTC', 'regtest', 2, 502, { txid: 'ee'.repeat(32) });
        expect(await selected(1, 1)).to.deep.equal([]);
    });

    it('drops a superseded eligible row when the anchor stride is two', async function () {
        await row('BTC', 'regtest', 2, 502);
        await row('BTC', 'regtest', 3, 503);
        await row('BTC', 'regtest', 5, 505, { supersedesFrom: 502 });
        expect(await selected(1, 2)).to.deep.equal([]);
        await row('BTC', 'regtest', 6, 506);
        expect(await selected(1, 2)).to.deep.equal([['BTC', 'regtest', 6]]);
    });

    it('scopes markers to their own chain and network, unscoped and by network', async function () {
        await row('BTC', 'regtest', 2, 502);
        await row('LTC', 'regtest', 2, 502);
        await row('BTC', 'testnet', 2, 502);
        await row('BTC', 'regtest', 3, 503, { supersedesFrom: 500 });
        expect(await selected(1, 1)).to.deep.equal([['BTC', 'testnet', 2], ['LTC', 'regtest', 2]]);
        expect(await selected(1, 1, 'regtest')).to.deep.equal([['LTC', 'regtest', 2]]);
        expect(await selected(1, 1, 'testnet')).to.deep.equal([['BTC', 'testnet', 2]]);
    });
});
