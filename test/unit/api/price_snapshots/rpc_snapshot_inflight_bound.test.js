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
 * The bound on concurrent JSON-RPC getpricesnapshots calls.
 *
 * The defect this guards: the REST snapshot routes cap their in-flight reads, but
 * the JSON-RPC getpricesnapshots read had no bound. Four dozen public callers at
 * limit=10000 (or ten callers sending 20-member batches) filled the shared
 * ten-connection pool, the liveness probe's SELECT 1 queued behind them, and
 * ping and health answered 503 db:false while the database was serving every
 * read. The handler now admits a bounded number of reads and sheds the rest
 * in-band with the rate limiter's error code, so a pool slot stays free for the
 * probe.
 */

const { expect } = require('chai');
const { buildOracleRpc } = require('../../../../src/api/rpc/oracle.js');
const { buildSystemRpc } = require('../../../../src/api/rpc/system.js');
const configsQueries = require('../../../../src/db/configs.js');

const POOL_SIZE = 10;
const CALLERS = 48;
const DB_PROBE_TIMEOUT_MS = 200;

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

// A connection pool of `size` slots: work past the limit queues for a slot in
// arrival order, the way the mariadb pool queues getConnection.
function fakePool(size) {
    let busy = 0;
    const waiters = [];
    return {
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

// A hub whose page reads hold a pool slot until the test lets them go, with the
// real configs mixin (the liveness probe) running over the same pool.
function starvableHub(pool) {
    const held = [];
    const state = { calls: 0, inFlight: 0, peak: 0, failNext: 0 };
    const db = Object.assign({}, configsQueries, {
        circuitState: 'closed',
        async doQuery() {
            await pool.acquire();
            try { return [{ 1: 1 }]; } finally { pool.release(); }
        }
    });
    const hub = {
        network: 'regtest',
        db,
        async getPriceSnapshots() {
            state.calls++;
            if (state.failNext > 0) { state.failNext--; throw new Error('read failed'); }
            state.inFlight++;
            state.peak = Math.max(state.peak, state.inFlight);
            const gate = deferred();
            held.push(gate);
            await pool.acquire();
            try {
                await gate.promise;
                return [{ id: 1 }];
            } finally {
                pool.release();
                state.inFlight--;
            }
        },
        async oracleMaxAgeSecondsInForce() { return 600; }
    };
    return { hub, state, releaseAll() { while (held.length) held.shift().resolve(); } };
}

function systemRpc(hub) {
    return buildSystemRpc({
        hub, hubConfig: {}, p2pConfig: null,
        configFetchCounters: { served: 0, errors: 0 }, DB_PROBE_TIMEOUT_MS, COIN_CONSENSUS_HASHES: {}
    });
}

async function ping(rpc) {
    let statusCode = 200;
    const res = { status(code) { statusCode = code; return this; }, setHeader() {} };
    const body = await rpc.ping({}, { res });
    return { statusCode, body };
}

function boundSuite() {
    it('caps in-flight page reads below the pool, sheds the excess in-band, and keeps ping answering db:true', async function () {
        const { hub, state, releaseAll } = starvableHub(fakePool(POOL_SIZE));
        const oracle = buildOracleRpc({ hub, hubConfig: {} });
        const system = systemRpc(hub);

        const calls = Array.from({ length: CALLERS }, () =>
            oracle.getpricesnapshots({ limit: 10000 }));
        let settled = 0;
        for (const c of calls) c.then(() => { settled++; });
        // Every call is either holding a read or already answered.
        await waitFor(() => state.inFlight + settled === CALLERS);

        // The broken invariant first: with the reads held, ping must still see the DB.
        const started = Date.now();
        const probe = await ping(system);
        expect(probe.statusCode).to.equal(200);
        expect(probe.body).to.deep.equal({ status: 'success', db: true });
        expect(Date.now() - started).to.be.below(DB_PROBE_TIMEOUT_MS);
        expect(state.peak).to.be.within(1, POOL_SIZE - 2);

        releaseAll();
        const results = await Promise.all(calls);
        const served = results.filter((r) => Array.isArray(r));
        const shed = results.filter((r) => r && !Array.isArray(r) && r.code === -32029);
        expect(served.length).to.equal(state.peak);
        expect(served.length + shed.length).to.equal(CALLERS);
        for (const r of shed) {
            expect(r.error).to.be.a('string');
            expect(r.data.retryAfterSeconds).to.be.at.least(1);
            expect(r.data.limit).to.equal(state.peak);
        }
    });
}

function releaseSuite() {
    it('honours a configured bound', async function () {
        const { hub, state, releaseAll } = starvableHub(fakePool(POOL_SIZE));
        const oracle = buildOracleRpc({ hub, hubConfig: { HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '2' } });
        const calls = Array.from({ length: 12 }, () => oracle.getpricesnapshots({ limit: 10000 }));
        let settled = 0;
        for (const c of calls) c.then(() => { settled++; });
        await waitFor(() => state.inFlight + settled === calls.length);
        expect(state.peak).to.equal(2);
        releaseAll();
        const results = await Promise.all(calls);
        expect(results.filter((r) => Array.isArray(r))).to.have.length(2);
    });

    it('frees the slot when the read throws, so later calls are admitted again', async function () {
        const { hub, state, releaseAll } = starvableHub(fakePool(POOL_SIZE));
        const oracle = buildOracleRpc({ hub, hubConfig: { HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '2' } });

        state.failNext = 6;
        for (let i = 0; i < 6; i++) {
            const r = await oracle.getpricesnapshots({ limit: 10000 });
            expect(r).to.deep.equal({ error: 'error fetching price snapshots' });
        }

        const calls = [oracle.getpricesnapshots({ limit: 10 }), oracle.getpricesnapshots({ limit: 10 })];
        await waitFor(() => state.inFlight === 2);
        releaseAll();
        const results = await Promise.all(calls);
        for (const r of results) expect(r).to.deep.equal([{ id: 1 }]);
        expect(state.calls).to.equal(8);

        // After the gate drains, a call is admitted again.
        const again = oracle.getpricesnapshots({ limit: 10, with_watermark: 1 });
        await waitFor(() => state.inFlight === 1);
        releaseAll();
        const body = await again;
        expect(body.snapshots).to.deep.equal([{ id: 1 }]);
    });

    it('does not take a slot for a call that fails validation', async function () {
        const { hub, state, releaseAll } = starvableHub(fakePool(POOL_SIZE));
        const oracle = buildOracleRpc({ hub, hubConfig: { HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '1' } });
        const bad = await oracle.getpricesnapshots({ limit: 10, status: 'pending' });
        expect(bad.error).to.match(/status/);
        const ok = oracle.getpricesnapshots({ limit: 10 });
        await waitFor(() => state.inFlight === 1);
        releaseAll();
        expect(await ok).to.deep.equal([{ id: 1 }]);
    });
}

describe('JSON-RPC getpricesnapshots in-flight bound', function () {
    boundSuite();
    releaseSuite();
});
