'use strict';

const http = require('http');
const express = require('express');
const sinon = require('sinon');
const { expect } = require('chai');

const { authGate } = require('../../../src/api/auth_gate.js');
const { evaluateAuthPosture } = require('../../../src/api/auth_posture.js');
const { mountSnapshotRoutes } = require('../../../src/api/rest/hub_db_snapshot.js');
const { mountTelemetryRoutes } = require('../../../src/api/rest/telemetry.js');
const attestationDb = require('../../../src/db/attestation.js');
const governanceDb = require('../../../src/db/governance.js');
const reorgDb = require('../../../src/db/reorg_attestations.js');
const slashDb = require('../../../src/db/slash_proposals.js');
const swapDb = require('../../../src/db/swap_records.js');

function listen(app) {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function request(server, { method = 'GET', path = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const requestHeaders = { ...headers };
        if (payload !== null) {
            requestHeaders['content-type'] = 'application/json';
            requestHeaders['content-length'] = Buffer.byteLength(payload);
        }
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, method, path,
            headers: requestHeaders
        }, (res) => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch (err) { /* keep non-JSON bodies as text */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

function logger() {
    return { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
}

function snapshotApp(findPriceSnapshotsById) {
    const app = express();
    mountSnapshotRoutes(app, {
        hub: { db: {
            findPriceSnapshotsById,
            findOraclePricesAfterId: sinon.stub().resolves([]),
            findLatestOraclePricesPerFeed: sinon.stub().resolves([])
        } },
        logger: logger(),
        HUB_API_KEY: '', HUB_FEED_API_KEY: '', HUB_NETWORK: 'regtest',
        bigIntReplacer: (key, value) => value
    });
    return app;
}

describe('snapshot cursor validation through Express', function () {
    let server;
    let findPriceSnapshotsById;

    before(async function () {
        findPriceSnapshotsById = sinon.stub().resolves([]);
        server = await listen(snapshotApp(findPriceSnapshotsById));
    });

    after(function (done) {
        server.close(done);
    });

    it('rejects a cursor beyond the safe integer range before the DB call', async function () {
        const res = await request(server, {
            path: '/hub-db/snapshot/price_snapshots?since_id=9007199254740993'
        });
        expect(res.status).to.equal(400);
        expect(res.json).to.deep.equal({ error: 'since_id must be a non-negative safe integer' });
        expect(findPriceSnapshotsById.called).to.equal(false);
    });

    it('returns a stable JSON error without a driver message or stack', async function () {
        findPriceSnapshotsById.rejects(new Error('driver detail and stack marker'));
        const res = await request(server, { path: '/hub-db/snapshot/price_snapshots' });
        expect(res.status).to.equal(500);
        expect(res.headers['content-type']).to.match(/^application\/json/);
        expect(res.json).to.deep.equal({ error: 'snapshot error' });
        expect(res.text).not.to.include('driver detail');
        expect(res.text).not.to.include('at ');
    });

    it('rejects an empty limit rather than treating it as omitted', async function () {
        const res = await request(server, { path: '/hub-db/snapshot/oracle_prices?limit=' });
        expect(res.status).to.equal(400);
        expect(res.json.error).to.include('limit');
    });

    it('rejects an empty cursor rather than treating it as omitted', async function () {
        const res = await request(server, { path: '/hub-db/snapshot/oracle_prices?since_id=' });
        expect(res.status).to.equal(400);
        expect(res.json).to.deep.equal({ error: 'since_id must be a non-negative safe integer' });
    });

    for (const latest of ['', 'yes', '2', 'TRUE']) {
        it('rejects an unknown latest flag ' + JSON.stringify(latest), async function () {
            const res = await request(server, {
                path: '/hub-db/snapshot/oracle_prices?latest=' + encodeURIComponent(latest)
            });
            expect(res.status).to.equal(400);
            expect(res.json).to.deep.equal({ error: "latest must be one of: 0, 1, false, true" });
        });
    }
});

describe('telemetry window validation through Express', function () {
    let server;
    let findLatest;

    before(async function () {
        const app = express();
        findLatest = sinon.stub().resolves([]);
        mountTelemetryRoutes(app, {
            hub: { db: {
                findLatestTelemetryPingPerInstall: findLatest,
                getTelemetryPingCountInWindow: sinon.stub().resolves([{ c: 0 }]),
                findLatestTelemetryOperatorPingPerInstall: sinon.stub().resolves([]),
                findTelemetryPingStatsPerInstall: sinon.stub().resolves([])
            } },
            logger: logger(), geoip: { lookup: sinon.stub().returns(null) },
            TELEMETRY_ENABLED: true, TELEMETRY_IP_SALT: '', TELEMETRY_ADMIN_KEY: 'admin-key'
        });
        server = await listen(app);
    });

    after(function (done) {
        server.close(done);
    });

    for (const value of ['1e3', '30junk', 'NaN', 'Infinity', '-0', '']) {
        it('rejects malformed days ' + JSON.stringify(value) + ' before the DB call', async function () {
            findLatest.resetHistory();
            const res = await request(server, { path: '/telemetry/summary?days=' + encodeURIComponent(value) });
            expect(res.status).to.equal(400);
            expect(res.json).to.deep.equal({ error: 'days must be a positive integer no greater than 365' });
            expect(findLatest.called).to.equal(false);
        });
    }

    it('rejects a window beyond the range and accepts the upper boundary', async function () {
        findLatest.resetHistory();
        expect((await request(server, { path: '/telemetry/summary?days=366' })).status).to.equal(400);
        expect(findLatest.called).to.equal(false);
        expect((await request(server, { path: '/telemetry/summary?days=365' })).status).to.equal(200);
        expect(findLatest.lastCall.args).to.deep.equal([365]);
    });
});

describe('stable list query order', function () {
    function recordingTarget() {
        return { doQuery: sinon.stub().resolves([]) };
    }

    const cases = [
        ['attestations', attestationDb.findAttestations, [50]],
        ['filtered attestations', attestationDb.findAttestationsByStatus, ['pending', 50]],
        ['swaps', swapDb.findSwapRecords, [50]],
        ['filtered swaps', swapDb.findSwapRecordsByStatus, ['initiated', 50]],
        ['reorg attestations', reorgDb.findReorgAttestations, [50]],
        ['governance proposals', governanceDb.findGovernanceProposalsFiltered, [null, null, 50]],
        ['validator slash history', slashDb.findRecentSlashProposalsByValidator, ['a'.repeat(64)]],
    ];

    for (const [name, fn, args] of cases) {
        it(name + ' breaks timestamp ties with the unique id', async function () {
            const target = recordingTarget();
            await fn.apply(target, args);
            expect(target.doQuery.calledOnce).to.equal(true);
            expect(String(target.doQuery.firstCall.args[0])).to.match(/ORDER BY created_at DESC, id DESC/);
        });
    }
});

describe('authentication and response transport', function () {
    it('refuses a write without a key and never copies the id into a header', async function () {
        const app = express();
        app.use(express.json());
        app.use(authGate({
            HUB_API_KEY: 'bulk-key', HUB_FEED_API_KEY: '', HUB_REORG_API_KEY: '',
            HUB_CONFIG_SECRETS_API_KEY: '', REORG_WRITE_METHODS: new Set(),
            WRITE_METHODS: new Set(['updateconfig']), SENSITIVE_READ_METHODS: new Set(),
            SENSITIVE_READ_AUTH: true
        }));
        app.post('/', (req, res) => res.json({ ok: true }));
        const server = await listen(app);
        try {
            const hostileId = '<script>alert(1)</script>\r\nx-injected: yes';
            const res = await request(server, {
                method: 'POST', body: { jsonrpc: '2.0', id: hostileId, method: 'updateconfig', params: {} }
            });
            expect(res.status).to.equal(401);
            expect(res.headers['content-type']).to.match(/^application\/json/);
            expect(Object.values(res.headers).join('\n')).not.to.include('x-injected');
            expect(res.json.error).to.deep.equal({ code: -32001, message: 'Unauthorized' });
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('requires an explicit declaration for keyless operation', function () {
        expect(evaluateAuthPosture({ apiKey: '', allowUnauthenticated: false }).refuse).to.equal(true);
        expect(evaluateAuthPosture({ apiKey: '', allowUnauthenticated: true }).refuse).to.equal(false);
    });
});
