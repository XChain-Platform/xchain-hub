// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { startTelemetryRetention } = require('../../../src/api/server.js');
const { buildSystemRpc } = require('../../../src/api/rpc/system.js');
const anchorWatchdog = require('../../../src/anchor/publisher/broadcast.js');
const oracleWatchdog = require('../../../src/oracle/publisher/landing.js');
const Governance = require('../../../src/validators/governance.js');

function deferred() {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}

function summary(txid) {
    return {
        known: true,
        confirmed: 0,
        unconfirmed: 1,
        byTxid: new Map([[txid, 0]])
    };
}

function watchdogSubject(methods, txid) {
    return {
        _confirmChecking: false,
        _pendingConfirmations: new Map([[txid, {
            txid,
            kind: 'anchor',
            ref: '1',
            round: 1,
            sentAt: Date.now() - 100
        }]]),
        confirmationCheckFailures: 0,
        confirmedPublishes: 0,
        lastConfirmationCheckAt: null,
        confirmStaleMs: Number.MAX_SAFE_INTEGER,
        oldestUnconfirmedPublish: methods.oldestUnconfirmedPublish
    };
}

async function assertSingleFlight(methods, txid) {
    const gate = deferred();
    const subject = watchdogSubject(methods, txid);
    let reads = 0;
    subject.readUtxoReserve = () => { reads++; return gate.promise; };

    const first = methods.checkPublishedConfirmations.call(subject);
    const second = methods.checkPublishedConfirmations.call(subject);
    expect(reads).to.equal(1);

    gate.resolve(summary(txid));
    await Promise.all([first, second]);
    subject.readUtxoReserve = async () => { reads++; return summary(txid); };
    await methods.checkPublishedConfirmations.call(subject);
    expect(reads).to.equal(2);
}

async function assertReadCutoff(methods, txid, newerTxid) {
    const gate = deferred();
    const subject = watchdogSubject(methods, txid);
    subject.readUtxoReserve = () => gate.promise;

    const pass = methods.checkPublishedConfirmations.call(subject);
    subject._pendingConfirmations.set(newerTxid, {
        txid: newerTxid,
        kind: 'anchor',
        ref: '2',
        round: 2,
        sentAt: Date.now()
    });
    gate.resolve({ known: true, confirmed: 1, unconfirmed: 0, byTxid: new Map() });
    await pass;

    expect(subject._pendingConfirmations.has(txid)).to.equal(false);
    expect(subject._pendingConfirmations.has(newerTxid)).to.equal(true);
    expect(subject.confirmedPublishes).to.equal(1);
}

// Prune failure cases: a failing delete is recorded, kept out of the public stats and recovered from
function pruneFailureCases() {
    it('records a failed prune, warns, and resets the failure count after recovery', async function () {
        const clock = sinon.useFakeTimers();
        const db = { deleteTelemetryPing: sinon.stub() };
        db.deleteTelemetryPing.onFirstCall().rejects(new Error('boom'));
        db.deleteTelemetryPing.onSecondCall().resolves({ affectedRows: 3 });
        const logger = { info: sinon.spy(), warn: sinon.spy() };
        const hub = { db };

        const timer = startTelemetryRetention({
            hub, logger, TELEMETRY_ENABLED: true, TELEMETRY_RETENTION_DAYS: 90
        });
        await clock.tickAsync(60000);
        expect(logger.warn.calledWithMatch('Telemetry retention: prune failed')).to.equal(true);
        expect(hub.telemetryRetention.getStats()).to.include({
            last_error_code: 'UNKNOWN', consecutive_failures: 1
        });

        await clock.tickAsync(86400000 - 60000);
        expect(hub.telemetryRetention.getStats()).to.include({
            last_deleted: 3, consecutive_failures: 0
        });
        clearInterval(timer);
    });

    it('keeps the raw error text out of the public health stats', async function () {
        const clock = sinon.useFakeTimers();
        const leak = 'connect ECONNREFUSED 10.9.8.7:3306 as retention_user';
        const err = Object.assign(new Error(leak), { code: 'ECONNREFUSED' });
        const db = { deleteTelemetryPing: sinon.stub().rejects(err) };
        const logger = { info: sinon.spy(), warn: sinon.spy() };
        const hub = { db };

        const timer = startTelemetryRetention({
            hub, logger, TELEMETRY_ENABLED: true, TELEMETRY_RETENTION_DAYS: 90
        });
        await clock.tickAsync(60000);
        const stats = hub.telemetryRetention.getStats();
        expect(stats.last_error_code).to.equal('ECONNREFUSED');
        expect(JSON.stringify(stats)).to.not.include('10.9.8.7');
        expect(JSON.stringify(stats)).to.not.include('retention_user');
        expect(logger.warn.calledWithMatch('10.9.8.7')).to.equal(true);
        clearInterval(timer);
    });
}

// Detached and unknown-code cases: the retention timer only runs when telemetry is on
function retentionConfigCases() {
    it('publishes an unknown code for a driver code that is not a short token', async function () {
        const clock = sinon.useFakeTimers();
        const err = Object.assign(new Error('x'), { code: 'host=db.internal user=svc' });
        const hub = { db: { deleteTelemetryPing: sinon.stub().rejects(err) } };

        const timer = startTelemetryRetention({
            hub, logger: { info() {}, warn() {} },
            TELEMETRY_ENABLED: true, TELEMETRY_RETENTION_DAYS: 90
        });
        await clock.tickAsync(60000);
        expect(hub.telemetryRetention.getStats().last_error_code).to.equal('UNKNOWN');
        clearInterval(timer);
    });

    it('stays detached when telemetry is disabled', function () {
        const hub = { db: { deleteTelemetryPing: sinon.stub() } };
        const timer = startTelemetryRetention({
            hub, logger: { info() {}, warn() {} },
            TELEMETRY_ENABLED: false, TELEMETRY_RETENTION_DAYS: 90
        });
        expect(timer).to.equal(null);
        expect(hub).to.not.have.property('telemetryRetention');
    });
}

// Health case: retention state is reported in the health body without degrading status
function retentionHealthCases() {
    it('publishes retention state in health without degrading the hub', async function () {
        const hub = {
            db: { circuitState: 'closed', getDatabaseLivenessProbe: async () => true },
            telemetryRetention: { getStats: () => ({ consecutive_failures: 2 }) }
        };
        const rpc = buildSystemRpc({
            hub,
            hubConfig: {},
            p2pConfig: null,
            configFetchCounters: { served: 0, errors: 0 },
            DB_PROBE_TIMEOUT_MS: 100,
            COIN_CONSENSUS_HASHES: {}
        });
        const body = await rpc.health({}, { res: { status() { return this; } } });
        expect(body.status).to.equal('healthy');
        expect(body.telemetry_retention).to.deep.equal({ consecutive_failures: 2 });
    });
}

// Watchdog cases: each publisher watchdog is single-flight and reads against a fixed cutoff
function confirmationWatchdogCases() {
    it('keeps the anchor watchdog single-flight', async function () {
        await assertSingleFlight(anchorWatchdog, 'aa');
    });

    it('keeps the oracle watchdog single-flight', async function () {
        await assertSingleFlight(oracleWatchdog, 'bb');
    });

    it('does not judge an anchor broadcast against an older read', async function () {
        await assertReadCutoff(anchorWatchdog, 'aa', 'cc');
    });

    it('does not judge an oracle broadcast against an older read', async function () {
        await assertReadCutoff(oracleWatchdog, 'bb', 'dd');
    });
}

// Tally cases: an overlapping tally pass is skipped and a rejected pass clears the guard
function governanceTallyCases() {
    it('skips an overlapping pass and runs again after the first settles', async function () {
        const gate = deferred();
        let checks = 0, requests = 0;
        const gov = {
            _tallyRunning: false,
            _tallyTimer: {},
            checkExpiredProposals() { checks++; return checks === 1 ? gate.promise : Promise.resolve(); },
            requestMissingResults() { requests++; return Promise.resolve(); }
        };

        const first = Governance.prototype.runTallyTick.call(gov);
        const second = Governance.prototype.runTallyTick.call(gov);
        expect(checks).to.equal(1);
        gate.resolve();
        await Promise.all([first, second]);
        expect(requests).to.equal(1);
        await Governance.prototype.runTallyTick.call(gov);
        expect(checks).to.equal(2);
    });

    it('clears the tally guard after a rejected pass', async function () {
        let checks = 0;
        const gov = {
            _tallyRunning: false,
            _tallyTimer: {},
            checkExpiredProposals() {
                checks++;
                return checks === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
            },
            requestMissingResults() { return Promise.resolve(); }
        };
        sinon.stub(console, 'error');

        await Governance.prototype.runTallyTick.call(gov);
        expect(gov._tallyRunning).to.equal(false);
        await Governance.prototype.runTallyTick.call(gov);
        expect(checks).to.equal(2);
    });
}

describe('job liveness guards', function () {
    afterEach(function () { sinon.restore(); });

    describe('telemetry retention', function () {
        pruneFailureCases();
        retentionConfigCases();
        retentionHealthCases();
    });

    describe('confirmation watchdogs', confirmationWatchdogCases);

    describe('governance tally', governanceTallyCases);
});
