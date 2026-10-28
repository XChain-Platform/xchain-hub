/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

/**
 * The bound on concurrent /hub-db/snapshot/* reads, and the single-flight DB
 * liveness probe behind ping and health.
 *
 * The defect these guard: a fleet-bootstrap page flood (a dozen indexers walking
 * price_snapshots at limit=10000 at once) was never shed. The per-IP snapshot
 * limiter exempts loopback and private-range callers, and even a distributed
 * fleet stays under its per-source budget, so every page read went straight to
 * the shared ten-connection pool. Once the pool was full, the health RPC's
 * SELECT 1 queued behind the page reads, missed its deadline and reported
 * db:false with HTTP 503, and every poll queued one more SELECT 1. The route
 * entry now caps in-flight snapshot reads below the pool size and sheds the rest
 * with 429 and Retry-After, and concurrent liveness probes share one SELECT 1.
 */

const { expect } = require('chai');
const http = require('http');
const express = require('express');
const { mountSnapshotRoutes } = require('../../../src/api/rest/hub_db_snapshot');
const { buildSystemRpc } = require('../../../src/api/rpc/system.js');
const configsQueries = require('../../../src/db/configs.js');

const POOL_SIZE = 10;

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

async function waitFor(predicate, ms) {
    const deadline = Date.now() + (ms || 2000);
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition not reached in time');
        await tick(5);
    }
}

// A connection pool of POOL_SIZE slots: work past the limit queues for a slot,
// the way the mariadb pool queues getConnection.
function fakePool(size) {
    let busy = 0;
    const waiters = [];
    return {
        get busy() { return busy; },
        async acquire() {
            if (busy < size) { busy++; return; }
            await new Promise((r) => waiters.push(r));
        },
        release() {
            const next = waiters.shift();
            if (next) next(); else busy--;
        }
    };
}

// A hub DB whose snapshot page reads hold a pool slot until the test lets them go,
// with the real configs mixin (liveness probe included) running over the same pool.
function starvableDb(pool) {
    const held = [];
    const db = Object.assign({}, configsQueries, {
        circuitState: 'closed',
        selectOnes: 0,
        snapshotInFlight: 0,
        snapshotPeak: 0,
        async doQuery(sql) {
            if (sql === 'SELECT 1') db.selectOnes++;
            await pool.acquire();
            try { return [{ 1: 1 }]; } finally { pool.release(); }
        },
        async findPriceSnapshotsById() {
            db.snapshotInFlight++;
            db.snapshotPeak = Math.max(db.snapshotPeak, db.snapshotInFlight);
            const gate = deferred();
            held.push(gate);
            await pool.acquire();
            try {
                await gate.promise;
                return [];
            } finally {
                pool.release();
                db.snapshotInFlight--;
            }
        },
        getPriceSnapshotsFinalizedAgeSeconds: async () => []
    });
    return { db, held, releaseAll() { while (held.length) held.shift().resolve(); } };
}

function snapshotCtx(db, hubConfig) {
    return {
        hub: { network: 'regtest', db },
        HUB_NETWORK: 'regtest',
        hubConfig,
        logger: { error() {}, warn() {}, info() {} },
        bigIntReplacer: undefined
    };
}

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server;
}

function get(server, path) {
    const { port } = server.address();
    let request;
    const done = new Promise((resolve) => {
        request = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        request.on('error', (err) => resolve({ status: 0, error: err }));
    });
    return { done, request };
}

// Requests answered so far. With the reads still held this accounts for every
// request; only then is the in-flight peak final, since one still in transit
// could yet overshoot the cap.
function answeredCount(calls) {
    let answered = 0;
    for (const c of calls) c.done.then(() => { answered++; });
    return () => answered;
}

let server = null;

async function stopServer() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    server = null;
}

function capSuite() {
    it('caps in-flight snapshot reads from a loopback caller and sheds the rest with 429 and Retry-After', async function () {
        const cap = 3;
        const { db, releaseAll } = starvableDb(fakePool(POOL_SIZE));
        const app = express();
        mountSnapshotRoutes(app, snapshotCtx(db, { HUB_SNAPSHOT_MAX_INFLIGHT: String(cap) }));
        server = await listen(app);

        const calls = Array.from({ length: 5 * cap }, (_, i) =>
            get(server, '/hub-db/snapshot/price_snapshots?limit=10000&since_id=' + (i * 10000)));
        const answered = answeredCount(calls);
        await waitFor(() => answered() + db.snapshotInFlight === calls.length);
        expect(db.snapshotPeak).to.be.at.most(cap);

        releaseAll();
        const results = await Promise.all(calls.map((c) => c.done));
        const shed = results.filter((r) => r.status === 429);
        const served = results.filter((r) => r.status === 200);
        expect(served.length + shed.length).to.equal(5 * cap);
        expect(served).to.have.length(cap);
        expect(shed).to.have.length(4 * cap);
        for (const r of shed) {
            expect(Number(r.headers['retry-after'])).to.be.at.least(1);
            expect(JSON.parse(r.body).code).to.equal(-32029);
        }
        expect(db.snapshotPeak).to.be.at.most(cap);
    });

    it('defaults the cap below the pool size when no setting is given', async function () {
        const { db, releaseAll } = starvableDb(fakePool(POOL_SIZE));
        const app = express();
        mountSnapshotRoutes(app, snapshotCtx(db, undefined));
        server = await listen(app);
        const calls = Array.from({ length: 3 * POOL_SIZE }, () => get(server, '/hub-db/snapshot/price_snapshots'));
        const answered = answeredCount(calls);
        await waitFor(() => db.snapshotInFlight >= 1 && answered() + db.snapshotInFlight === calls.length);
        expect(db.snapshotPeak).to.be.within(1, POOL_SIZE - 2);
        releaseAll();
        await Promise.all(calls.map((c) => c.done));
    });

}

function releaseSuite() {
    it('releases the slot when the handler errors and when the client aborts', async function () {
        let mode = 'throw';
        let heldGate = null;
        let calls = 0;
        const db = {
            async findPriceSnapshotsById() {
                calls++;
                if (mode === 'throw') throw new Error('boom');
                heldGate = deferred();
                await heldGate.promise;
                return [];
            }
        };
        const app = express();
        // The gate frees a slot on the response's close; this counter, mounted first,
        // sees the same event, so it shows when the aborted request's slot is free.
        let closed = 0;
        app.use((req, res, next) => { res.on('close', () => { closed++; }); next(); });
        mountSnapshotRoutes(app, snapshotCtx(db, { HUB_SNAPSHOT_MAX_INFLIGHT: '1' }));
        server = await listen(app);

        const failed = await get(server, '/hub-db/snapshot/price_snapshots').done;
        expect(failed.status).to.equal(500);

        mode = 'hold';
        const aborted = get(server, '/hub-db/snapshot/price_snapshots');
        await waitFor(() => heldGate !== null);
        const busy = await get(server, '/hub-db/snapshot/price_snapshots').done;
        expect(busy.status).to.equal(429);
        aborted.request.destroy();
        await aborted.done;
        await waitFor(() => closed >= 3);                 // the failed, the shed and the aborted request

        const firstGate = heldGate;
        heldGate = null;
        const next = get(server, '/hub-db/snapshot/price_snapshots');
        await waitFor(() => heldGate !== null);
        heldGate.resolve();
        expect((await next.done).status).to.equal(200);
        firstGate.resolve();
        expect(calls).to.equal(3);
    });

}

function headroomSuite() {
    it('keeps health at db:true under a page flood because the cap leaves pool headroom', async function () {
        const pool = fakePool(POOL_SIZE);
        const { db, releaseAll } = starvableDb(pool);
        const app = express();
        mountSnapshotRoutes(app, snapshotCtx(db, { HUB_SNAPSHOT_MAX_INFLIGHT: '4' }));
        server = await listen(app);

        const calls = Array.from({ length: 20 }, (_, i) =>
            get(server, '/hub-db/snapshot/price_snapshots?limit=10000&since_id=' + (i * 10000)));
        const answered = answeredCount(calls);
        await waitFor(() => answered() + db.snapshotInFlight === calls.length);

        const rpc = buildSystemRpc({
            hub: { network: 'regtest', db }, hubConfig: {}, p2pConfig: null,
            configFetchCounters: { served: 0, errors: 0 }, DB_PROBE_TIMEOUT_MS: 300, COIN_CONSENSUS_HASHES: {}
        });
        let statusCode = 200;
        const res = { status(code) { statusCode = code; return this; } };
        const body = await rpc.health({}, { res });
        const ping = await rpc.ping({}, { res: { status() { return this; } } });
        expect(body.db).to.equal(true);
        expect(body.status).to.equal('healthy');
        expect(statusCode).to.equal(200);
        expect(ping.db).to.equal(true);

        releaseAll();
        await Promise.all(calls.map((c) => c.done));
    });
}

describe('hub DB snapshot concurrency bound', function () {
    this.timeout(10000);
    afterEach(stopServer);
    capSuite();
    releaseSuite();
    headroomSuite();
});

describe('hub DB liveness probe single-flight', function () {
    it('shares one SELECT 1 across concurrent callers and issues a fresh one after it settles', async function () {
        let issued = 0;
        let pending = deferred();
        const db = Object.assign({}, configsQueries, {
            doQuery(sql) { if (sql === 'SELECT 1') issued++; return pending.promise; }
        });
        const probes = Array.from({ length: 25 }, () => db.getDatabaseLivenessProbe());
        expect(issued).to.equal(1);
        pending.resolve([{ 1: 1 }]);
        await Promise.all(probes);

        pending = deferred();
        const again = db.getDatabaseLivenessProbe();
        expect(issued).to.equal(2);
        pending.reject(new Error('down'));
        let rejected = false;
        try { await again; } catch (err) { rejected = true; }
        expect(rejected).to.equal(true);

        pending = deferred();
        const third = db.getDatabaseLivenessProbe();
        expect(issued).to.equal(3);
        pending.resolve([]);
        await third;
    });
});
