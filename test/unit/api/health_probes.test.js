/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * The probes behind `health` (src/api/rpc/health_probes.js).
 *
 * The defect these guard: every health call read all three admission tips from the
 * indexers, and each Promise.race deadline left its timer running after a fast answer
 * and its axios read running after a timeout. One upstream read is now shared by every
 * concurrent caller and cached briefly, every deadline is cleared, and a timed-out read
 * is cancelled. The upstream count is measured on a real indexer-shaped endpoint.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const http = require('http');
const XChainHub = require('../../../src/XChainHub.js');
const { buildSystemRpc } = require('../../../src/api/rpc/system.js');
const { ADMISSION_PROBE_TTL_MS, makeAdmissionTipProbe, raceTimeout } = require('../../../src/api/rpc/health_probes.js');
const { ADMIT_COLUMN_CHAINS } = require('../../../src/consensus/gates/mirror_admission_gate.js');
const carrierLogicPin = require('../../../bin/lib/carrier_logic_pin.js');

let server = null;
let url = '';
let upstream = 0;
let closedEarly = 0;

// An indexer that answers getlatestblock after `delayMs`, or never when delayMs is null.
function startIndexer(delayMs) {
    upstream = 0;
    closedEarly = 0;
    server = http.createServer((req, res) => {
        upstream++;
        res.on('close', () => { if (!res.writableEnded) closedEarly++; });
        req.resume();
        if (delayMs === null) return;
        setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { block_index: 100, decoder_block: 120 } }));
        }, delayMs);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        url = 'http://127.0.0.1:' + server.address().port + '/';
        resolve();
    }));
}

function stopIndexer() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.closeAllConnections();
        server.close(() => { server = null; resolve(); });
    });
}

// The real resolver methods on a hub that reads its indexer URL and nothing else.
function indexerBackedHub() {
    return {
        network: 'regtest',
        _admissionTipSeen: new Map(),
        resolveIndexerUrl: async () => url,
        resolveAdmissionTips: XChainHub.prototype.resolveAdmissionTips,
        resolveAdmissionTip: XChainHub.prototype.resolveAdmissionTip,
        admissionTipFresh: XChainHub.prototype.admissionTipFresh,
        db: {
            circuitState: 'closed',
            getDatabaseLivenessProbe: async () => true,
            getPriceSnapshotsFinalizedAgeSeconds: async () => []
        }
    };
}

function healthRpcFor(hub, timeoutMs) {
    return buildSystemRpc({
        hub, hubConfig: {}, p2pConfig: {}, configFetchCounters: { served: 0, errors: 0 },
        DB_PROBE_TIMEOUT_MS: timeoutMs || 2000, COIN_CONSENSUS_HASHES: {}
    });
}

const RES = { status() { return this; } };

function concurrentHealth(rpc, n) {
    return Promise.all(Array.from({ length: n }, () => rpc.health({}, { res: RES })));
}

function singleFlightSuite() {
    afterEach(stopIndexer);

    it('collapses N concurrent health calls into exactly one read per admission chain', async function () {
        expect(ADMIT_COLUMN_CHAINS).to.have.length(3);
        await startIndexer(30);
        const rpc = healthRpcFor(indexerBackedHub());
        const bodies = await concurrentHealth(rpc, 50);
        expect(upstream).to.equal(3);
        for (const body of bodies) expect(body.admission_tips.chains.BTC.height).to.equal(120);
        // Still inside the TTL: a second flood reuses the same answer.
        await concurrentHealth(rpc, 50);
        expect(upstream).to.equal(3);
    });

    it('reads again once the cache has aged past its TTL', async function () {
        let t = 0;
        const hub = { resolveAdmissionTips: sinon.stub().resolves({ BTC: 1, LTC: 2, DOGE: 3 }), _admissionTipSeen: new Map() };
        const probe = makeAdmissionTipProbe(hub, {}, 2000, { ttlMs: 1000, now: () => t });
        await Promise.all([probe(), probe(), probe()]);
        expect(hub.resolveAdmissionTips.callCount).to.equal(1);
        t = 999;
        await probe();
        expect(hub.resolveAdmissionTips.callCount).to.equal(1);
        t = 1001;
        await probe();
        expect(hub.resolveAdmissionTips.callCount).to.equal(2);
        expect(ADMISSION_PROBE_TTL_MS).to.be.within(1000, 2000);
    });

    it('cancels the indexer reads when the probe deadline fires', async function () {
        await startIndexer(null);
        const rpc = healthRpcFor(indexerBackedHub(), 50);
        const [body] = await concurrentHealth(rpc, 5);
        expect(upstream).to.equal(3);
        expect(body.admission_tips.chains.BTC.fresh).to.equal(false);
        // axios' own timeout is 5000ms; a close inside 1s is the abort, not that.
        const deadline = Date.now() + 1000;
        while (closedEarly < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        expect(closedEarly).to.equal(3);
    });

    it('answers null where the hub runs no admission producer', async function () {
        expect(await makeAdmissionTipProbe({}, {}, 2000)()).to.equal(null);
        expect(await makeAdmissionTipProbe({ resolveAdmissionTips() {} }, null, 2000)()).to.equal(null);
    });
}

function timerSuite() {
    let clock;
    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => clock.restore());

    it('clears the deadline when the work completes first', async function () {
        expect(await raceTimeout(Promise.resolve('done'), 2000)).to.equal('done');
        expect(clock.countTimers()).to.equal(0);
        let err = null;
        await raceTimeout(Promise.reject(new Error('boom')), 2000).catch((e) => { err = e; });
        expect(err.message).to.equal('boom');
        expect(clock.countTimers()).to.equal(0);
    });

    it('aborts the work and rejects when the deadline fires', async function () {
        let signal = null;
        const race = raceTimeout((s) => { signal = s; return new Promise(() => {}); }, 2000);
        const outcome = race.catch((e) => e);
        await clock.tickAsync(2000);
        expect((await outcome).message).to.equal('timeout');
        expect(signal.aborted).to.equal(true);
        expect(clock.countTimers()).to.equal(0);
    });

    it('rejects a synchronously throwing work without leaving its timer', async function () {
        const err = await raceTimeout(() => { throw new Error('sync'); }, 2000).catch((e) => e);
        expect(err.message).to.equal('sync');
        expect(clock.countTimers()).to.equal(0);
    });

    it('leaves no live timer after health and ping answer', async function () {
        const hub = indexerBackedHub();
        hub.resolveAdmissionTips = async () => ({ BTC: 5, LTC: 6, DOGE: 7 });
        const rpc = healthRpcFor(hub);
        const body = await rpc.health({}, { res: RES });
        expect(body.status).to.equal('healthy');
        expect(await rpc.ping({}, { res: RES })).to.deep.equal({ status: 'success', db: true });
        expect(clock.countTimers()).to.equal(0);
    });
}

function identitySuite() {
    it('carries the carrier_logic_digest computed from the shipped pins', async function () {
        const hub = indexerBackedHub();
        hub.resolveAdmissionTips = async () => ({ BTC: 1, LTC: 2, DOGE: 3 });
        const rpc = healthRpcFor(hub);
        const body = await rpc.health({}, { res: RES });
        const expected = carrierLogicPin.digest(carrierLogicPin.readPin(carrierLogicPin.REPO_ROOT));
        expect(body.carrier_logic_digest).to.equal(expected);
    });
}

describe('hub health probes', function () {
    this.timeout(10000);
    describe('admission-tip single flight', singleFlightSuite);
    describe('deadlines', timerSuite);
    describe('consensus identity', identitySuite);
});
