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

const sinon            = require('sinon');
const { expect }       = require('chai');
const proxyquire       = require('proxyquire');
const PriceAggregator = require('../../../../src/oracle/price_aggregator.js');

const HubDbBroadcaster = proxyquire('../../../../src/peers/hub_db_broadcaster.js', {
    ws: { OPEN: 1 }
});

function socket() {
    return {
        readyState: 1,
        bufferedAmount: 0,
        _hubBuffered: 0,
        send: sinon.stub(),
        close: sinon.stub(),
        on: sinon.stub()
    };
}

function lateWatermark() {
    return {
        isLateFinalization: sinon.stub().returns({
            chain: 'BTC',
            reason: 'round abandoned',
            watermark: 999,
            admitBlock: 1003
        })
    };
}

async function subscribedBroadcaster() {
    let broadcaster = new HubDbBroadcaster({});
    let ws = socket();
    await broadcaster.addSubscriber(ws);
    ws.send.resetHistory();
    broadcaster.admissionWatermark = lateWatermark();
    return { broadcaster, ws };
}

describe('HubDbBroadcaster chain-ingest rows', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('forces a mirror re-download for a chain-ingested round below this hub watermark', async function () {
        let { broadcaster, ws } = await subscribedBroadcaster();

        broadcaster.broadcastRow({
            table: 'price_snapshots',
            origin: 'chain-ingest',
            row: { round_number: 41, admit_block_btc: 1003 }
        });

        expect(broadcaster.admissionWatermark.isLateFinalization.calledOnce).to.equal(true);
        expect(ws.send.called).to.equal(false);
        expect(ws.close.calledOnceWithExactly(1012,
            'chain-ingested price_snapshots below admission watermark')).to.equal(true);
        expect(broadcaster.getSubscriberCount()).to.equal(0);
        broadcaster.stop();
    });

    it('still refuses a self-finalized late round', async function () {
        let { broadcaster, ws } = await subscribedBroadcaster();
        sinon.stub(console, 'error');

        broadcaster.broadcastRow({
            table: 'price_snapshots',
            row: { round_number: 42, admit_block_btc: 1003 }
        });

        expect(broadcaster.admissionWatermark.isLateFinalization.calledOnce).to.equal(true);
        expect(ws.send.called).to.equal(false);
        expect(console.error.calledOnce).to.equal(true);
        broadcaster.stop();
    });

    it('carries batch_block_time through a landing re-emit', async function () {
        let { broadcaster, ws } = await subscribedBroadcaster();
        broadcaster.admissionWatermark.isLateFinalization.returns(null);
        let row = {
            round_number: 43,
            coin_pair: 'BTC/USD',
            batch_block_time: 1700009000,
            admit_block_btc: 1003
        };
        let db = {
            updatePriceSnapshotByRoundNumber: sinon.stub().resolves(),
            findPriceSnapshotsByRoundNumberAndBatchBlockTime: sinon.stub().resolves([row])
        };
        let aggregator = new PriceAggregator({ db });
        let emitted;
        aggregator.on('row:inserted', event => {
            emitted = event;
            broadcaster.broadcastRow(event);
        });

        expect(await aggregator.stampBatchLanding(43, 1700009000)).to.equal(1);
        expect(emitted.origin).to.equal('chain-ingest');
        expect(broadcaster.admissionWatermark.isLateFinalization.calledOnce).to.equal(true);
        expect(ws.send.calledOnce).to.equal(true);
        expect(JSON.parse(ws.send.firstCall.args[0]).row.batch_block_time).to.equal(1700009000);
        broadcaster.stop();
    });
});
