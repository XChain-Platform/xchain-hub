'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon      = require('sinon');

const bookkeeping = require('../../../../src/db/prices/archive_bookkeeping');

function stubbedDb() {
    return { doQuery: sinon.stub().resolves([]) };
}

function lastCall(db) {
    const call = db.doQuery.lastCall;
    return { sql: call.args[0], args: call.args[1] };
}

describe('price tombstone rearming', function () {
    it('re-arms a stamped tombstone for a bounded fenced retraction', async function () {
        const db = stubbedDb();
        await bookkeeping.insertPriceTombstonesForRetraction.call(db, 'BTC', 7, 12, 4, true, true);
        const { sql, args } = lastCall(db);

        expect(sql).to.match(/^INSERT INTO archive_price_tombstones \(round_number, coin_pair\) SELECT /);
        expect(sql).to.include('ON DUPLICATE KEY UPDATE archive_price_tombstones.batch_seq = NULL');
        expect(sql).to.match(/source_chain = \? AND source_action_index >= \? AND source_action_index <= \? AND push_generation <= \? AND batch_seq IS NOT NULL/);
        expect(args).to.deep.equal(['BTC', 7, 12, 4]);
    });

    it('re-arms a stamped tombstone for an open unfenced retraction', async function () {
        const db = stubbedDb();
        await bookkeeping.insertPriceTombstonesForRetraction.call(db, 'DOGE', 9, undefined, undefined, false, false);
        const { sql, args } = lastCall(db);

        expect(sql).to.include('ON DUPLICATE KEY UPDATE archive_price_tombstones.batch_seq = NULL');
        expect(sql).to.match(/source_chain = \? AND source_action_index >= \? AND batch_seq IS NOT NULL ON DUPLICATE KEY UPDATE/);
        expect(sql).to.not.include('source_action_index <= ?');
        expect(sql).to.not.include('push_generation <= ?');
        expect(args).to.deep.equal(['DOGE', 9]);
    });
});
