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
 **********************************************************************
 *
 * Await-safe spend gating on the two effectors whose sends are driven by
 * unawaited event handlers: OraclePublisher._processQueueInner and
 * AttestationRelay._broadcast.
 *
 * Both used to gate an AWAITED broadcast with the pure spendGuard.allow()
 * predicate and only call record() after the send returned. src/lib/spend_guard.js
 * forbids that composition for exactly this reason: every caller parked on the
 * await reads the same pre-send budget, so with one slot left they ALL broadcast
 * and the per-window ceiling is exceeded by the concurrency width. On the oracle
 * side that is also a duplicate DOGE spend on one round, since every
 * at-most-once marker in the body closes only after the send returns.
 *
 * These tests hold the fix by its failure mode: with a one-broadcast window,
 * two overlapping passes must produce exactly ONE send. They fail on a revert to
 * allow()/record() and pass on reserve()/commit()/release().
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

const SpendGuard       = require('../../src/lib/spend_guard.js');
const AttestationRelay = require('../../src/AttestationRelay.js');

// A promise plus the handle that settles it, so a test can park a broadcast
// mid-flight and start a second pass while the first is still awaiting.
function deferred() {
    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    return { promise: promise, resolve: resolveFn, reject: rejectFn };
}

function makeFsMock(queueLine) {
    return {
        mkdirSync:     sinon.stub(),
        existsSync:    sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        openSync:      sinon.stub().returns(99),
        writeSync:     sinon.stub(),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        readFileSync:  sinon.stub().returns(queueLine || ''),
        appendFileSync: sinon.stub()
    };
}

function makeOracleHub(cfg) {
    return {
        p2pConfig:          cfg || {},
        getIdentity:        sinon.stub().returns({
            getPubkeyHex: sinon.stub().returns('aa'.repeat(32)),
            sign:         sinon.stub().returns('bb'.repeat(64))
        }),
        capabilityRegistry: null,
        capabilitySnapshot: null,
        oracleConsensus:    null
    };
}

describe('await-safe spend gating on the hub effectors', function () {

    afterEach(function () {
        sinon.restore();
        SpendGuard.unregister('OraclePublisher');
        SpendGuard.unregister('AttestationRelay');
    });

    it('OraclePublisher: two overlapping publish passes spend one window slot, not two', async function () {
        const entry  = { round: 7, btcBlockTime: 1700000000, prices: [], sigs: [], attempts: 0 };
        const fsMock = makeFsMock(JSON.stringify(entry) + '\n');
        const OraclePublisher = proxyquire('../../src/OraclePublisher', {
            fs: fsMock,
            './EncoderClient': function () { return null; }
        });

        // One broadcast per window: the ceiling is what the second pass must hit.
        const pub = new OraclePublisher(makeOracleHub({
            ORACLE_PUBLISH_MAX_PUBLISHES_PER_WINDOW: '1'
        }));
        pub.db           = null;
        pub.getBalanceFn = sinon.stub().resolves(50);   // well above the floor

        const gate = deferred();
        const broadcastStub = sinon.stub().returns(gate.promise);
        pub.broadcastFn = broadcastStub;

        // Drive the INNER pass directly: _processQueue's own _sweeping guard would
        // hide the spend race behind a skip, and the point here is that the gate
        // holds even when a second pass reaches the send (a future second call
        // site, a sweep timer, or a caller that bypasses the wrapper).
        const passA = pub._processQueueInner();
        const passB = pub._processQueueInner();

        // Let both passes reach the awaited broadcast before either settles.
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        gate.resolve({ txid: 'tx-7' });
        await Promise.all([passA, passB]);

        expect(broadcastStub.callCount,
            'the window allows one broadcast, so the second pass must find no budget').to.equal(1);
    });

    it('OraclePublisher: a declined round leaves no publish-intent row behind', async function () {
        const entry  = { round: 9, btcBlockTime: 1700000000, prices: [], sigs: [], attempts: 0 };
        const fsMock = makeFsMock(JSON.stringify(entry) + '\n');
        const OraclePublisher = proxyquire('../../src/OraclePublisher', {
            fs: fsMock,
            './EncoderClient': function () { return null; }
        });

        const pub = new OraclePublisher(makeOracleHub({
            ORACLE_PUBLISH_MAX_PUBLISHES_PER_WINDOW: '1'
        }));
        pub.getBalanceFn = sinon.stub().resolves(50);
        pub.broadcastFn  = sinon.stub().resolves({ txid: 'tx-9' });

        // A DB whose only intent write would strand the round: an intent-only row is
        // what _hydratePublishedMarkers quarantines forever, so a round the ceiling
        // declined must never reach the INSERT.
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/SELECT round, txid, sent_at/)).resolves([]);
        doQuery.resolves([]);
        pub.db = { doQuery: doQuery };

        pub.spendGuard.pause('ceiling closed for this test');
        await pub._processQueueInner();

        const intentWrites = doQuery.getCalls().filter(c => /INSERT INTO oracle_published_rounds/.test(String(c.args[0])));
        expect(intentWrites.length,
            'a round the spend gate declined must record no publish intent').to.equal(0);
    });

    it('AttestationRelay: two overlapping broadcasts of one leg spend one window slot', async function () {
        const walDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-reserve-'));
        const walPath = path.join(walDir, 'queue.jsonl');

        const relay = new AttestationRelay({
            db:        { doQuery: sinon.stub().resolves([]) },
            network:   'regtest',
            p2pConfig: {
                ATTEST_RELAY_QUEUE_PATH:              walPath,
                ATTEST_RELAY_MAX_PUBLISHES_PER_WINDOW: '1'
            },
            hubDbBroadcaster:   null,
            capabilitySnapshot: null,
            getPeerManager:     () => ({}),
            getIdentity:        () => ({ getPubkeyHex: () => 'a'.repeat(64), sign: () => '1'.repeat(128) })
        });

        const rid  = 'd'.repeat(64);
        const gate = deferred();
        const broadcastStub = sinon.stub().returns(gate.promise);
        relay.broadcastFn = broadcastStub;
        relay._legState('request').wire.set(rid, { coin: null, wire: 'ATTEST|3|' + rid });

        const sendA = relay._broadcast('request', rid);
        const sendB = relay._broadcast('request', rid);

        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        gate.resolve({ txid: 'tx-rid' });
        await Promise.all([sendA, sendB]);

        expect(broadcastStub.callCount,
            'the ATTEST_RELAY window allows one broadcast, so the second caller must find no budget').to.equal(1);

        try { fs.rmSync(walDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    });
});
