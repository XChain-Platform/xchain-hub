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
// item 4459 WATERMARK-OVERTAKE GUARD: the post-commit row broadcast used to swallow
// a failed re-read of the finalized round. The watermark heartbeat runs on its own
// wall-clock timer and would then certify the stream complete through an instant past
// a round no subscriber ever received, and the consumer's only gap repair (the max_ids
// catch-up inside its bootstrap) runs at connect time, so nothing on a healthy socket
// ever refilled it. A dropped broadcast must therefore force subscribers to resync.

const sinon             = require('sinon');
const { expect }        = require('chai');
const OracleConsensus   = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');

describe('OracleConsensus: post-commit price broadcast gap (#4459)', function () {
    const ROUND  = 41;
    const PRICES = [{ coinPair: 'BTC/USD', price: '100000' }];

    let hub, oc, broadcaster;

    function isRoundSelect(sql) {
        return typeof sql === 'string' && /SELECT \* FROM price_snapshots/.test(sql);
    }

    beforeEach(function () {
        hub = createMockHub();
        broadcaster = {
            broadcastRow:      sinon.stub(),
            dropAllForResync:  sinon.stub().returns(1)
        };
        hub.hubDbBroadcaster = broadcaster;
        oc = new OracleConsensus(hub, { getSubmissions: sinon.stub().returns(new Map()) });
        sinon.stub(console, 'error');
        sinon.stub(console, 'warn');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('broadcasts each finalized row and does not resync when the re-read succeeds', async function () {
        oc.db.doQuery.callsFake(async (sql) =>
            isRoundSelect(sql) ? [{ id: 1, round_number: ROUND, coin_pair: 'BTC/USD' }] : []);

        await oc._storeSnapshot(ROUND, PRICES, 3, '[]', 900001, 1700000000);

        expect(broadcaster.broadcastRow.calledOnce).to.be.true;
        expect(broadcaster.broadcastRow.firstCall.args[0].table).to.equal('price_snapshots');
        expect(broadcaster.dropAllForResync.called).to.be.false;
    });

    it('forces a subscriber resync when the post-commit re-read fails', async function () {
        oc.db.doQuery.callsFake(async (sql) => {
            if (isRoundSelect(sql)) throw new Error('connection reset');
            return [];
        });

        await oc._storeSnapshot(ROUND, PRICES, 3, '[]', 900001, 1700000000);

        expect(broadcaster.broadcastRow.called, 'no row reached a subscriber').to.be.false;
        expect(broadcaster.dropAllForResync.calledOnce, 'subscribers dropped for resync').to.be.true;
        expect(broadcaster.dropAllForResync.firstCall.args[0]).to.equal('price-round broadcast gap');
        expect(console.error.called, 'the drop is logged, not swallowed').to.be.true;
    });

    it('never fails the finalized write when the resync repair itself throws', async function () {
        oc.db.doQuery.callsFake(async (sql) => {
            if (isRoundSelect(sql)) throw new Error('connection reset');
            return [];
        });
        broadcaster.dropAllForResync.throws(new Error('broadcaster gone'));

        // Resolves rather than rejecting: _finalizeCommittedRound treats a throw here as a
        // store failure and would retain + retry an already-durable round.
        await oc._storeSnapshot(ROUND, PRICES, 3, '[]', 900001, 1700000000);

        expect(broadcaster.dropAllForResync.calledOnce).to.be.true;
    });
});
