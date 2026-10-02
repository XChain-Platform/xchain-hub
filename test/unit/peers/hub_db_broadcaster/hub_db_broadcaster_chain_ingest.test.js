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
const fs                = require('node:fs');
const http              = require('node:http');
const path              = require('node:path');
const ws                = require('ws');
const PriceAggregator = require('../../../../src/oracle/price_aggregator.js');

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_DIR ||
    path.resolve(__dirname, '../../../../../xchain-indexer');
const INDEXER_SYNC_PATH = path.join(INDEXER_ROOT, 'src', 'hub', 'hub_db_sync.js');
const HubDbSync = fs.existsSync(INDEXER_SYNC_PATH) ? require(INDEXER_SYNC_PATH) : null;
const WebSocketServer = ws.WebSocketServer || ws.Server;

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
    const broadcaster = new HubDbBroadcaster({});
    const ws = socket();
    await broadcaster.addSubscriber(ws);
    ws.send.resetHistory();
    broadcaster.admissionWatermark = lateWatermark();
    return { broadcaster, ws };
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for production mirror reconnect');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

async function closeServer(server) {
    if (!server) return;
    await new Promise(resolve => server.close(resolve));
}

describe('HubDbBroadcaster chain-ingest rows', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('makes the production indexer re-download a chain-ingested round below this hub watermark', async function () {
        this.timeout(15000);
        if (!HubDbSync) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer mirror is missing at ' + INDEXER_SYNC_PATH);
            this.skip();
        }

        const hubRows = [];
        const mirroredRows = [];
        const snapshotRequests = [];
        const db = {
            getPriceSnapshotsMaxId: sinon.stub().callsFake(async () => [{
                max_id: hubRows.length === 0 ? null : Math.max(...hubRows.map(row => row.id))
            }])
        };
        const broadcaster = new HubDbBroadcaster({}, db);
        broadcaster.admissionWatermark = lateWatermark();
        let httpServer;
        let wsServer;
        let sync;
        let connectionCount = 0;
        let firstClose;

        try {
            httpServer = http.createServer((req, res) => {
                const url = new URL(req.url, 'http://127.0.0.1');
                if (url.pathname !== '/hub-db/snapshot/price_snapshots') {
                    res.writeHead(404).end();
                    return;
                }
                const sinceId = Number(url.searchParams.get('since_id') || 0);
                snapshotRequests.push(sinceId);
                const rows = hubRows.filter(row => Number(row.id) > sinceId);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ rows: rows, watermark: 1700000000, heights: {} }));
            });
            wsServer = new WebSocketServer({ server: httpServer, path: '/hub-db/subscribe' });
            wsServer.on('connection', (conn, req) => {
                connectionCount++;
                if (connectionCount === 1) {
                    firstClose = new Promise(resolve => conn.once('close', (code, reason) => {
                        resolve({ code: code, reason: reason.toString() });
                    }));
                }
                broadcaster.addSubscriber(conn, req);
            });

            const port = await listen(httpServer);
            sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, {
                hubUrl: 'http://127.0.0.1:' + port,
                network: 'testnet'
            });
            sinon.stub(sync, 'localColumns').resolves(new Set([
                'id', 'round_number', 'coin_pair', 'price', 'reference_block',
                'block_timestamp', 'status', 'admit_block_btc'
            ]));
            sinon.stub(sync, 'applyRow').callsFake(async (table, row) => {
                expect(table).to.equal('price_snapshots');
                if (!mirroredRows.some(existing => Number(existing.id) === Number(row.id)))
                    mirroredRows.push(Object.assign({}, row));
            });
            sinon.stub(sync, 'reconcileForeignPriceRounds').resolves();
            sinon.stub(sync, 'replayDrainedPriceEvents').resolves(true);
            sinon.stub(sync, 'refreshPriceSyncHeight').resolves();
            sinon.stub(sync, 'refreshAllSyncHeights').resolves();
            const productionBootstrapTable = sync.bootstrapTable.bind(sync);
            const bootstrapTable = sinon.stub(sync, 'bootstrapTable').callsFake(async table => {
                if (table === 'price_snapshots') return productionBootstrapTable(table);
                return 1700000000;
            });

            await sync.start();
            expect(mirroredRows).to.deep.equal([]);
            const lateRow = {
                id: 41,
                round_number: 41,
                coin_pair: 'BTC/USD',
                price: '50000.00000000',
                reference_block: 1003,
                block_timestamp: 1700000000,
                status: 'finalized',
                admit_block_btc: 1003
            };
            hubRows.push(lateRow);

            broadcaster.broadcastRow({
                table: 'price_snapshots',
                origin: 'chain-ingest',
                row: lateRow
            });

            const closed = await firstClose;
            await waitUntil(() => mirroredRows.length === 1 && connectionCount === 2, 10000);

            expect(closed).to.deep.equal({
                code: 1012,
                reason: 'chain-ingested price_snapshots below admission watermark'
            });
            expect(broadcaster.admissionWatermark.isLateFinalization.calledOnce).to.equal(true);
            expect(connectionCount).to.equal(2);
            expect(db.getPriceSnapshotsMaxId.callCount).to.equal(2);
            expect(bootstrapTable.withArgs('price_snapshots').callCount).to.equal(2);
            expect(snapshotRequests).to.deep.equal([0, 0]);
            expect(mirroredRows).to.deep.equal([lateRow]);
            expect(broadcaster.getSubscriberCount()).to.equal(1);
        } finally {
            if (sync) sync.stop();
            broadcaster.stop();
            if (wsServer) wsServer.close();
            await closeServer(httpServer);
        }
    });

    it('still refuses a self-finalized late round', async function () {
        const { broadcaster, ws } = await subscribedBroadcaster();
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
        const { broadcaster, ws } = await subscribedBroadcaster();
        broadcaster.admissionWatermark.isLateFinalization.returns(null);
        const row = {
            round_number: 43,
            coin_pair: 'BTC/USD',
            batch_block_time: 1700009000,
            admit_block_btc: 1003
        };
        const db = {
            updatePriceSnapshotByRoundNumber: sinon.stub().resolves(),
            findPriceSnapshotsByRoundNumberAndBatchBlockTime: sinon.stub().resolves([row])
        };
        const aggregator = new PriceAggregator({ db });
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
