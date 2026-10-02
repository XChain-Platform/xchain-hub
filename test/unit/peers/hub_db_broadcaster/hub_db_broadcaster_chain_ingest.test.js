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
        heights: sinon.stub().returns({}),
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

    it('re-downloads a chain-ingested round below this hub watermark after reconnect', async function () {
        let hubRows = [];
        let mirroredRows = [];
        let db = {
            getPriceSnapshotsMaxId: sinon.stub().callsFake(async () => [{
                max_id: hubRows.length === 0 ? null : Math.max(...hubRows.map(row => row.id))
            }])
        };
        let downloadPriceSnapshots = sinon.stub().callsFake((sinceId, throughId) =>
            hubRows.filter(row => row.id > sinceId && row.id <= throughId));
        let broadcaster = new HubDbBroadcaster({}, db);
        broadcaster.admissionWatermark = lateWatermark();
        let reconnectPromise = null;
        let connections = [];

        async function connectMirror() {
            let ws = socket();
            connections.push(ws);
            ws.send.callsFake(payload => {
                let frame = JSON.parse(payload);
                if (frame.type !== 'ready') return;
                let localMax = mirroredRows.reduce((max, row) => Math.max(max, row.id), 0);
                let hubMax = Number(frame.max_ids.price_snapshots || 0);
                if (hubMax > localMax)
                    mirroredRows.push(...downloadPriceSnapshots(localMax, hubMax));
            });
            ws.close.callsFake(code => {
                if (code === 1012) reconnectPromise = connectMirror();
            });
            await broadcaster.addSubscriber(ws);
            return ws;
        }

        let firstWs = await connectMirror();
        expect(mirroredRows).to.deep.equal([]);
        let lateRow = { id: 41, round_number: 41, admit_block_btc: 1003 };
        hubRows.push(lateRow);

        broadcaster.broadcastRow({
            table: 'price_snapshots',
            origin: 'chain-ingest',
            row: lateRow
        });
        await reconnectPromise;

        expect(broadcaster.admissionWatermark.isLateFinalization.calledOnce).to.equal(true);
        expect(firstWs.close.calledOnceWithExactly(1012,
            'chain-ingested price_snapshots below admission watermark')).to.equal(true);
        expect(connections).to.have.length(2);
        expect(db.getPriceSnapshotsMaxId.callCount).to.equal(2);
        expect(downloadPriceSnapshots.calledOnceWithExactly(0, 41)).to.equal(true);
        expect(mirroredRows).to.deep.equal([lateRow]);
        expect(broadcaster.getSubscriberCount()).to.equal(1);
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
