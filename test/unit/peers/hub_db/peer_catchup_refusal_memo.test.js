'use strict';
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub_schema_version.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');
const { rememberCatchupHub } = require('../../../../src/peers/hub_db/catchup_context.js');
const { createRefusalMemo, createFileRefusalStore } = require('../../../../src/peers/hub_db/refusal_memo.js');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const { PEER, makeCatchup, peerManager, priceDb } = require('./helpers/peer_catchup_harness.js');

const SKIPPED = [
    { id: 11, round_number: 5, coin_pair: 'BTC/USD', status: 'skipped' },
    { id: 12, round_number: 6, coin_pair: 'BTC/USD', status: 'skipped' }
];

// Serves the given rows on the first page of every walk, then an empty page.
function servingRows(rowsForWalk) {
    let walk = 0;
    return sinon.stub().callsFake(async (peer, table, cursor) => {
        if (cursor !== 0) return { table, schema_version: HUB_SCHEMA_VERSION, rows: [] };
        walk += 1;
        return { table, schema_version: HUB_SCHEMA_VERSION, rows: rowsForWalk(walk) };
    });
}

function refusingVerifier() {
    return sinon.stub().resolves({ ok: false, reason: 'price snapshot is not finalized' });
}

function memoCatchup(verifier, fetchPage, extra) {
    const logger = { warn: sinon.stub(), error: sinon.stub() };
    const catchup = makeCatchup(Object.assign({ getVerifier: () => verifier, fetchPage, logger,
        hasRow: async () => false, storeRow: sinon.stub().resolves() }, extra));
    return { catchup, logger };
}

function warnLines(logger, text) {
    return logger.warn.getCalls().map(call => String(call.args[0])).filter(line => line.includes(text));
}

describe('hub DB peer catch-up refusal memo', function () {
    afterEach(function () { sinon.restore(); });

    registerRefusalReuseTests();
    registerRetryableRefusalTest();
    registerRefusalReportingTests();
    registerRestartPersistenceTests();
    registerStoreFailureTest();
    registerRefusalStoreTests();
});

// A store shared by two catch-up instances stands in for the file a restarted hub reads back.
function memoryStore() {
    const store = { record: null, writes: 0 };
    store.read = () => (store.record ? JSON.parse(JSON.stringify(store.record)) : null);
    store.write = (record) => { store.writes += 1; store.record = JSON.parse(JSON.stringify(record)); };
    return store;
}

// A fresh instance per call, as a restarted hub process builds one.
function restartedCatchup(verifier, fetchPage, refusalStore) {
    const logger = { warn: sinon.stub(), error: sinon.stub() };
    const catchup = new HubDbPeerCatchup({ db: priceDb(), peerManager: peerManager(true), tables: ['price_snapshots'],
        getVerifier: () => verifier, fetchPage, logger, hasRow: async () => false, storeRow: sinon.stub().resolves(),
        pageSize: 100000, indexerReadIntervalMs: 0, refusalStore });
    return { catchup, logger };
}

function skippedRows(n) {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1, round_number: i + 1, coin_pair: 'BTC/USD', status: 'skipped' }));
}

function registerRestartPersistenceTests() {

    it('does not re-verify or re-log rows refused before a restart', async function () {
        const rows = skippedRows(40);
        const store = memoryStore();
        const first = restartedCatchup(refusingVerifier(), servingRows(() => rows), store);
        await first.catchup.run();
        expect(store.writes).to.equal(1);
        const verifier = refusingVerifier();
        const second = restartedCatchup(verifier, servingRows(() => rows), store);
        await second.catchup.run();
        expect(verifier.callCount).to.equal(0);
        expect(second.catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        expect(warnLines(second.logger, 'verifier refused')).to.have.length(0);
        expect(warnLines(second.logger, 'refused (')).to.deep.equal([
            'Hub DB peer catch-up: 40 price_snapshots row(s) from ' + PEER + ' refused (40 already known)']);
        // Nothing new was remembered, so the restarted walk does not rewrite the store.
        expect(store.writes).to.equal(1);
    });

    it('re-verifies after a restart a row whose content changed', async function () {
        const store = memoryStore();
        await restartedCatchup(refusingVerifier(), servingRows(() => SKIPPED), store).catchup.run();
        const finalized = Object.assign({}, SKIPPED[0], { status: 'finalized', price: '1' });
        const verifier = sinon.stub().resolves(true);
        const second = restartedCatchup(verifier, servingRows(() => [finalized, SKIPPED[1]]), store);
        await second.catchup.run();
        expect(verifier.callCount).to.equal(1);
        expect(verifier.firstCall.args[0]).to.include({ id: 11, status: 'finalized' });
    });

    it('does not carry a retryable refusal across a restart', async function () {
        const store = memoryStore();
        const retryable = sinon.stub().resolves({ ok: false, retryable: true, reason: 'validator lookup failed' });
        await restartedCatchup(retryable, servingRows(() => SKIPPED.slice(0, 1)), store).catchup.run();
        const verifier = sinon.stub().resolves(true);
        await restartedCatchup(verifier, servingRows(() => SKIPPED.slice(0, 1)), store).catchup.run();
        expect(verifier.callCount).to.equal(1);
    });

    it('judges every row again when the stored memo is from another release or too old', async function () {
        for (const stale of [{ hubVersion: '0.0.0-other' }, { schemaVersion: -1 }, { savedAt: 0 }]) {
            const store = memoryStore();
            await restartedCatchup(refusingVerifier(), servingRows(() => SKIPPED), store).catchup.run();
            Object.assign(store.record, stale);
            const verifier = refusingVerifier();
            await restartedCatchup(verifier, servingRows(() => SKIPPED), store).catchup.run();
            expect(verifier.callCount, JSON.stringify(stale)).to.equal(2);
        }
    });
}

function registerStoreFailureTest() {
    it('carries refusals across a restart through refusalMemoPath on disk', async function () {
        const memoPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-refusal-memo-')), 'data', 'refusals.json');
        const build = verifier => new HubDbPeerCatchup({ db: priceDb(), peerManager: peerManager(true),
            tables: ['price_snapshots'], getVerifier: () => verifier, fetchPage: servingRows(() => SKIPPED),
            logger: { warn: sinon.stub(), error: sinon.stub() }, hasRow: async () => false,
            storeRow: sinon.stub().resolves(), pageSize: 100000, indexerReadIntervalMs: 0, refusalMemoPath: memoPath });
        await build(refusingVerifier()).run();
        expect(fs.existsSync(memoPath)).to.equal(true);
        const verifier = refusingVerifier();
        await build(verifier).run();
        expect(verifier.callCount).to.equal(0);
    });

    it('finishes the walk when the store cannot be read or written, with one warn line', async function () {
        const store = { read: () => { throw new Error('EACCES read'); }, write: () => { throw new Error('ENOSPC'); } };
        const { catchup, logger } = restartedCatchup(refusingVerifier(), servingRows(() => SKIPPED), store);
        await catchup.run();
        await catchup.run();
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        expect(warnLines(logger, 'refusal memo')).to.have.length(1);
        expect(warnLines(logger, 'catch-up failed')).to.have.length(0);
    });
}

// An in-memory fs with the calls the atomic rewrite makes, so the round trip touches no disk.
function memoryFs() {
    const files = new Map();
    const open = new Map();
    let nextFd = 3;
    return {
        files,
        mkdirSync: () => undefined,
        openSync: (file) => { const fd = nextFd++; open.set(fd, { file, text: '' }); return fd; },
        writeSync: (fd, text) => { open.get(fd).text += text; },
        fsyncSync: () => undefined,
        closeSync: (fd) => { const entry = open.get(fd); if (entry) files.set(entry.file, entry.text); open.delete(fd); },
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        unlinkSync: (file) => { files.delete(file); },
        readFileSync: (file) => {
            if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return files.get(file);
        }
    };
}

function registerRefusalStoreTests() {

    it('round-trips remembered refusals through the file store', function () {
        const fsImpl = memoryFs();
        const memoFile = '/hub/data/peer-catchup-refusals.json';
        const first = createRefusalMemo({ store: createFileRefusalStore(memoFile, fsImpl) });
        expect(first.size()).to.equal(0);
        const key = first.keyFor('peer', 'price_snapshots', SKIPPED[0]);
        first.remember(key);
        expect(first.flush()).to.equal(true);
        expect(first.flush()).to.equal(false);
        const second = createRefusalMemo({ store: createFileRefusalStore(memoFile, fsImpl) });
        expect(second.has(key)).to.equal(true);
        expect(second.has(second.keyFor('peer', 'price_snapshots', SKIPPED[1]))).to.equal(false);
    });

    it('reads a corrupt memo file as empty and keeps working', function () {
        const fsImpl = memoryFs();
        fsImpl.files.set('/hub/data/memo.json', '{"keys": [tor');
        const warn = sinon.stub();
        const memo = createRefusalMemo({ store: createFileRefusalStore('/hub/data/memo.json', fsImpl), warn });
        expect(memo.size()).to.equal(0);
        expect(warn.callCount).to.equal(1);
    });
}

function registerRefusalReuseTests() {

    it('does not re-verify a row refused for a local reason on the next walk', async function () {
        const verifier = refusingVerifier();
        const { catchup, logger } = memoCatchup(verifier, servingRows(() => SKIPPED));
        await catchup.run();
        await catchup.run();
        expect(verifier.callCount).to.equal(2);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        expect(warnLines(logger, 'price snapshot is not finalized')).to.have.length(2);
    });

    it('verifies a remembered row again once its content changes', async function () {
        const verifier = refusingVerifier();
        const finalized = Object.assign({}, SKIPPED[0], { status: 'finalized', price: '1' });
        const { catchup } = memoCatchup(verifier, servingRows(walk => (walk === 1 ? SKIPPED : [finalized, SKIPPED[1]])));
        await catchup.run();
        await catchup.run();
        expect(verifier.callCount).to.equal(3);
        expect(verifier.lastCall.args[0]).to.include({ id: 11, status: 'finalized' });
    });

    it('does not remember a row refused after a failed indexer read', async function () {
        const db = { name: 'refusal-memo-db' };
        const read = sinon.stub().resolves(null);
        rememberCatchupHub({ db, network: 'regtest', capabilitySnapshot: { getSnapshot: read, getWeightSnapshot: read } });
        const verifier = sinon.stub().callsFake(async (row, context) => {
            await context.readCapabilitySnapshot('getSnapshot', 'price', 1000);
            return { ok: false, reason: 'local capability snapshot unavailable' };
        });
        const { catchup } = memoCatchup(verifier, servingRows(() => SKIPPED.slice(0, 1)), { db, indexerReadIntervalMs: 0 });
        await catchup.run();
        await catchup.run();
        expect(verifier.callCount).to.equal(2);
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
    });

    it('does not remember a retryable verifier failure and forwards the deployment network', async function () {
        const verifier = sinon.stub().resolves({ ok: false, retryable: true, reason: 'validator lookup failed' });
        const { catchup } = memoCatchup(verifier, servingRows(() => SKIPPED.slice(0, 1)), { network: 'mainnet' });
        await catchup.run();
        await catchup.run();
        expect(verifier.callCount).to.equal(2);
        expect(verifier.firstCall.args[1].network).to.equal('mainnet');
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
    });
}

function registerRefusalReportingTests() {

    it('logs one summary line per walk for rows already refused', async function () {
        const { catchup, logger } = memoCatchup(refusingVerifier(), servingRows(() => SKIPPED));
        await catchup.run();
        await catchup.run();
        expect(warnLines(logger, 'verifier refused')).to.have.length(2);
        const summaries = warnLines(logger, 'price_snapshots row(s) from ' + PEER + ' refused');
        expect(summaries).to.deep.equal([
            'Hub DB peer catch-up: 2 price_snapshots row(s) from ' + PEER + ' refused (0 already known)',
            'Hub DB peer catch-up: 2 price_snapshots row(s) from ' + PEER + ' refused (2 already known)'
        ]);
    });

    it('bounds the per-row refusal lines of one walk and reports the true count in the summary', async function () {
        const lines = {};
        for (const n of [50, 500]) {
            const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, round_number: i + 1, coin_pair: 'BTC/USD', status: 'skipped' }));
            // A fresh instance has an empty memo, as after a restart.
            const { catchup, logger } = memoCatchup(refusingVerifier(), servingRows(() => rows), { pageSize: 100000 });
            await catchup.run();
            lines[n] = warnLines(logger, 'verifier refused').length;
            expect(lines[n]).to.be.at.most(10);
            const summaries = warnLines(logger, 'price_snapshots row(s) from ' + PEER + ' refused');
            expect(summaries).to.have.length(1);
            expect(summaries[0]).to.include('' + n + ' price_snapshots row(s)');
            expect(summaries[0]).to.include((n - lines[n]) + ' per-row refusal line(s) suppressed');
        }
        expect(lines[500]).to.equal(lines[50]);
    });

    it('evicts the oldest refusal once the memo is full', function () {
        const memo = createRefusalMemo({ maxEntries: 2 });
        const keys = SKIPPED.concat([{ id: 13, status: 'skipped' }]).map(row => memo.keyFor('peer', 'price_snapshots', row));
        keys.forEach(key => memo.remember(key));
        expect(memo.size()).to.equal(2);
        expect(memo.has(keys[0])).to.equal(false);
        expect(memo.has(keys[2])).to.equal(true);
    });
}

function registerRetryableRefusalTest() {
    it('retries an explicit retryable refusal on the next walk', async function () {
        const verifier = sinon.stub();
        verifier.onFirstCall().resolves({ ok: false, reason: 'validator lookup failed', retry: true });
        verifier.onSecondCall().resolves(true);
        const { catchup, logger } = memoCatchup(
            verifier, servingRows(() => SKIPPED.slice(0, 1)));
        await catchup.run();
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(false);
        await catchup.run();
        expect(verifier.callCount).to.equal(2);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
        expect(warnLines(logger, 'validator lookup failed')).to.have.length(1);
    });
}
