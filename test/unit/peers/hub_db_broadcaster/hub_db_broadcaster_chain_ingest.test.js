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

function requireIndexer(context) {
    if (HubDbSync) return;
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer mirror is missing at ' + INDEXER_SYNC_PATH);
    context.skip();
}

function recoveryFixture() {
    const hubRows = [];
    const db = {
        getHubInstanceId: sinon.stub().resolves('de305d54-75b4-431b-adb2-eb6b9e546014'),
        getPriceSnapshotsMaxId: sinon.stub().callsFake(async () => [{
            max_id: hubRows.length === 0 ? null : Math.max(...hubRows.map(row => row.id))
        }])
    };
    const broadcaster = new HubDbBroadcaster({}, db);
    broadcaster.admissionWatermark = lateWatermark();
    return {
        hubRows,
        db,
        broadcaster,
        mirroredRows: [],
        snapshotRequests: [],
        connectionCount: 0
    };
}

function chainIngestedRow() {
    return {
        id: 41,
        round_number: 41,
        coin_pair: 'BTC/USD',
        price: '50000.00000000',
        reference_block: 1003,
        block_timestamp: 1700000000,
        status: 'finalized',
        admit_block_btc: 1003
    };
}

function serveSnapshots(fixture, req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/hub-db/snapshot/price_snapshots') {
        res.writeHead(404).end();
        return;
    }
    const sinceId = Number(url.searchParams.get('since_id') || 0);
    fixture.snapshotRequests.push(sinceId);
    const rows = fixture.hubRows.filter(row => Number(row.id) > sinceId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rows: rows, watermark: 1700000000, heights: {} }));
}

function trackConnection(fixture, conn, req) {
    fixture.connectionCount++;
    if (fixture.connectionCount === 1) {
        fixture.firstClose = new Promise(resolve => conn.once('close', (code, reason) => {
            resolve({ code: code, reason: reason.toString() });
        }));
    }
    fixture.broadcaster.addSubscriber(conn, req);
}

async function openRecoveryServers(fixture) {
    fixture.httpServer = http.createServer((req, res) => serveSnapshots(fixture, req, res));
    fixture.wsServer = new WebSocketServer({ server: fixture.httpServer, path: '/hub-db/subscribe' });
    fixture.wsServer.on('connection', (conn, req) => trackConnection(fixture, conn, req));
    return listen(fixture.httpServer);
}

function configureRecoverySync(fixture, port) {
    fixture.sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, {
        hubUrl: 'http://127.0.0.1:' + port,
        network: 'testnet'
    });
    sinon.stub(fixture.sync, 'localColumns').resolves(new Set([
        'id', 'round_number', 'coin_pair', 'price', 'reference_block',
        'block_timestamp', 'status', 'admit_block_btc'
    ]));
    sinon.stub(fixture.sync, 'applyRow').callsFake(async (table, row) => {
        expect(table).to.equal('price_snapshots');
        if (!fixture.mirroredRows.some(existing => Number(existing.id) === Number(row.id)))
            fixture.mirroredRows.push(Object.assign({}, row));
    });
    sinon.stub(fixture.sync, 'reconcileForeignPriceRounds').resolves();
    sinon.stub(fixture.sync, 'replayDrainedPriceEvents').resolves(true);
    sinon.stub(fixture.sync, 'refreshPriceSyncHeight').resolves();
    sinon.stub(fixture.sync, 'refreshAllSyncHeights').resolves();
    const productionBootstrapTable = fixture.sync.bootstrapTable.bind(fixture.sync);
    fixture.bootstrapTable = sinon.stub(fixture.sync, 'bootstrapTable').callsFake(async table => {
        if (table === 'price_snapshots') return productionBootstrapTable(table);
        return 1700000000;
    });
}

function assertRecovery(fixture, closed, lateRow) {
    expect(closed).to.deep.equal({
        code: 1012,
        reason: 'chain-ingested price_snapshots below admission watermark'
    });
    expect(fixture.broadcaster.admissionWatermark.isLateFinalization.calledOnce).to.equal(true);
    expect(fixture.connectionCount).to.equal(2);
    expect(fixture.db.getPriceSnapshotsMaxId.callCount).to.equal(2);
    expect(fixture.bootstrapTable.withArgs('price_snapshots').callCount).to.equal(2);
    expect(fixture.snapshotRequests).to.deep.equal([0, 0]);
    expect(fixture.mirroredRows).to.deep.equal([lateRow]);
    expect(fixture.broadcaster.getSubscriberCount()).to.equal(1);
}

async function closeRecoveryFixture(fixture) {
    if (fixture.sync) fixture.sync.stop();
    fixture.broadcaster.stop();
    if (fixture.wsServer) fixture.wsServer.close();
    await closeServer(fixture.httpServer);
}

async function recoverChainIngestedRound() {
    this.timeout(15000);
    requireIndexer(this);
    const fixture = recoveryFixture();

    try {
        const port = await openRecoveryServers(fixture);
        configureRecoverySync(fixture, port);
        await fixture.sync.start();
        expect(fixture.mirroredRows).to.deep.equal([]);
        const lateRow = chainIngestedRow();
        fixture.hubRows.push(lateRow);

        fixture.broadcaster.broadcastRow({
            table: 'price_snapshots',
            origin: 'chain-ingest',
            row: lateRow
        });

        const closed = await fixture.firstClose;
        await waitUntil(() => fixture.mirroredRows.length === 1 && fixture.connectionCount === 2, 10000);
        assertRecovery(fixture, closed, lateRow);
    } finally {
        await closeRecoveryFixture(fixture);
    }
}

describe('HubDbBroadcaster chain-ingest rows', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('makes the production indexer re-download a chain-ingested round below this hub watermark',
        recoverChainIngestedRound);

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
