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

const sinon                  = require('sinon');
const { expect }             = require('chai');
const EventEmitter           = require('events');
const AttestationSpotChecker = require('../../src/AttestationSpotChecker');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeHub(overrides) {
    let consensus = new EventEmitter();
    let hub = {
        p2pConfig:           {},
        attestationConsensus: overrides && overrides.attestationConsensus !== undefined
            ? overrides.attestationConsensus : consensus,
        slashDetector:       overrides && overrides.slashDetector !== undefined
            ? overrides.slashDetector : null,
        ...(overrides || {})
    };
    hub._consensus = consensus;
    return hub;
}

function makeProviderRegistry(agreeResult) {
    return {
        getModule: sinon.stub().returns({
            agree: sinon.stub().resolves(agreeResult !== undefined ? agreeResult : true)
        })
    };
}

function makeFinalizedEvent(overrides) {
    return {
        requestId:    'rid001',
        providerId:   'http_get',
        responseBody: Buffer.from('response text', 'utf8'),
        status:       'finalized',
        meta:         '200',
        signatures:   [{ pubkey: 'pubkey1' }, { pubkey: 'pubkey2' }],
        leaderPubkey: 'pubkey1',
        ...(overrides || {})
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('AttestationSpotChecker', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('initialises with empty queue and failures maps', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            expect(sc._queueSize()).to.equal(0);
            expect(sc._failuresFor('any')).to.deep.equal([]);
        });

        it('reads SPOT_CHECK_FAILURE_THRESHOLD from config', function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_THRESHOLD: '7' } });
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            expect(sc.failureThreshold).to.equal(7);
        });

        it('reads SPOT_CHECK_FAILURE_WINDOW_MS from config', function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_WINDOW_MS: '3600000' } });
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            expect(sc.failureWindowMs).to.equal(3600000);
        });

        it('uses defaults when config is empty', function () {
            let hub = makeHub({ p2pConfig: {} });
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            expect(sc.failureThreshold).to.equal(3);
            expect(sc.failureWindowMs).to.equal(24 * 60 * 60 * 1000);
        });
    });

    // ── register / isSpotCheck ──────────────────────────────────────────────

    describe('register() / isSpotCheck()', function () {
        it('registers a spot-check and reports isSpotCheck=true', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('REQ001', 'http_get', 'expected pattern');
            expect(sc.isSpotCheck('REQ001')).to.be.true;
            expect(sc.isSpotCheck('req001')).to.be.true; // case-insensitive
        });

        it('returns false for unknown requestIds', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            expect(sc.isSpotCheck('unknown')).to.be.false;
        });

        it('ignores registration with empty requestId', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('', 'http_get', 'pattern');
            expect(sc._queueSize()).to.equal(0);
        });

        it('ignores registration with no providerId', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('rid1', '', 'pattern');
            expect(sc._queueSize()).to.equal(0);
        });

        it('drops the oldest entry when MAX_QUEUE_SIZE (1024) is exceeded', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            // Fill the queue to capacity
            for (let i = 0; i < 1024; i++) {
                sc.register('rid' + i, 'http_get', 'p');
            }
            expect(sc._queueSize()).to.equal(1024);
            // rid0 is the first/oldest entry
            expect(sc.isSpotCheck('rid0')).to.be.true;
            // Adding one more evicts rid0
            sc.register('rid_new', 'http_get', 'p');
            expect(sc._queueSize()).to.equal(1024);
            expect(sc.isSpotCheck('rid0')).to.be.false;
            expect(sc.isSpotCheck('rid_new')).to.be.true;
        });
    });

    // ── start / stop ────────────────────────────────────────────────────────

    describe('start()', function () {
        it('wires to the consensus request:finalized event', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            await sc.start();
            expect(hub.attestationConsensus.listenerCount('request:finalized')).to.equal(1);
        });

        it('logs and returns when no attestationConsensus exists', async function () {
            let hub = makeHub({ attestationConsensus: null });
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            await sc.start(); // should not throw
        });
    });

    describe('stop()', function () {
        it('removes the event listener and clears state', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            await sc.start();
            sc.register('rid1', 'http_get', 'p');
            await sc.stop();
            expect(hub.attestationConsensus.listenerCount('request:finalized')).to.equal(0);
            expect(sc._queueSize()).to.equal(0);
        });

        it('is safe to call stop() without start()', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            await sc.stop(); // should not throw
        });
    });

    // ── onRequestFinalized ───────────────────────────────────────────────────

    describe('onRequestFinalized()', function () {

        it('does nothing for non-spot-check requests', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            // rid001 is NOT registered as a spot-check
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc._failuresFor('pubkey1')).to.have.length(0);
        });

        it('does nothing when event has no requestId', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            await sc.onRequestFinalized(null);
            await sc.onRequestFinalized({});
        });

        it('removes the entry from queue after processing', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc.isSpotCheck('rid001')).to.be.false;
        });

        it('logs and returns on provider_id mismatch', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('rid001', 'llm', 'expected');  // registered as llm
            // event has http_get
            await sc.onRequestFinalized(makeFinalizedEvent({ providerId: 'http_get' }));
            // No failures recorded (provider mismatch → inconclusive)
            expect(sc._failuresFor('pubkey1')).to.have.length(0);
        });

        it('logs and returns when provider module has no agree()', async function () {
            let hub = makeHub();
            let reg = { getModule: sinon.stub().returns({ /* no agree */ }) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc._failuresFor('pubkey1')).to.have.length(0);
        });

        it('logs and returns when provider registry returns null module', async function () {
            let hub = makeHub();
            let reg = { getModule: sinon.stub().returns(null) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc._failuresFor('pubkey1')).to.have.length(0);
        });

        it('returns without recording failures when agree() returns truthy (pass)', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc._failuresFor('pubkey1')).to.have.length(0);
            expect(sc._failuresFor('pubkey2')).to.have.length(0);
        });

        it('records failures against all signers when agree() returns falsy (fail)', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc._failuresFor('pubkey1')).to.have.length(1);
            expect(sc._failuresFor('pubkey2')).to.have.length(1);
        });

        it('handles agree() throwing without propagating the error', async function () {
            let hub = makeHub();
            let reg = { getModule: sinon.stub().returns({ agree: sinon.stub().rejects(new Error('judge died')) }) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent()); // must not throw
            expect(sc._failuresFor('pubkey1')).to.have.length(0);
        });

        it('handles string responseBody (wraps to Buffer)', async function () {
            let hub = makeHub();
            let agreeSpy = sinon.stub().resolves(false);
            let reg = { getModule: sinon.stub().returns({ agree: agreeSpy }) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent({ responseBody: 'string body' }));
            expect(agreeSpy.called).to.be.true;
        });

        it('calls slashDetector when failure count reaches threshold', async function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_THRESHOLD: '3' } });
            let slashStub = sinon.stub().resolves();
            hub.slashDetector = { _recordSlashProposal: slashStub };
            let sc = new AttestationSpotChecker(hub, makeProviderRegistry(false));

            // Fire 3 failures for pubkey1
            for (let i = 1; i <= 3; i++) {
                sc.register('rid' + String(i).padStart(8, '0'), 'http_get', 'expected');
                await sc.onRequestFinalized(makeFinalizedEvent({
                    requestId: 'rid' + String(i).padStart(8, '0'),
                    signatures: [{ pubkey: 'pubkey1' }]
                }));
            }

            expect(slashStub.called).to.be.true;
            expect(slashStub.firstCall.args[0]).to.equal('pubkey1');
            expect(slashStub.firstCall.args[1]).to.equal('attestation_spot_check_failure');
        });

        it('does NOT call slashDetector when failures are below threshold', async function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_THRESHOLD: '5' } });
            let slashStub = sinon.stub().resolves();
            hub.slashDetector = { _recordSlashProposal: slashStub };
            let sc = new AttestationSpotChecker(hub, makeProviderRegistry(false));

            for (let i = 1; i <= 2; i++) {
                sc.register('rid' + i, 'http_get', 'expected');
                await sc.onRequestFinalized(makeFinalizedEvent({
                    requestId: 'rid' + i,
                    signatures: [{ pubkey: 'pubkey1' }]
                }));
            }

            expect(slashStub.called).to.be.false;
        });

        it('prunes failures outside the failure window', async function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_WINDOW_MS: '100', SPOT_CHECK_FAILURE_THRESHOLD: '2' } });
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));

            // First failure (will be pruned after window expires)
            sc.register('rid1', 'http_get', 'e');
            await sc.onRequestFinalized(makeFinalizedEvent({ requestId: 'rid1', signatures: [{ pubkey: 'pk' }] }));

            // Wait for window to expire
            await new Promise(r => setTimeout(r, 150));

            // Second failure after the window; pruning should remove the first
            sc.register('rid2', 'http_get', 'e');
            await sc.onRequestFinalized(makeFinalizedEvent({ requestId: 'rid2', signatures: [{ pubkey: 'pk' }] }));

            // Only 1 failure in the window now (rid2)
            let failures = sc._failuresFor('pk');
            expect(failures).to.have.length(1);
        });

        it('caps history at MAX_HISTORY_PER_VALIDATOR (64) entries', async function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_WINDOW_MS: String(10 * 60 * 60 * 1000) } });
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));

            // Register and finalize 70 distinct spot-check failures for the same validator
            for (let i = 0; i < 70; i++) {
                let rid = 'a' + String(i).padStart(7, '0');
                sc.register(rid, 'http_get', 'expected');
                await sc.onRequestFinalized(makeFinalizedEvent({ requestId: rid, signatures: [{ pubkey: 'pka' }] }));
            }

            expect(sc._failuresFor('pka').length).to.be.at.most(64);
        });
    });

    // ── _recordFailure ────────────────────────────────────────────────────────

    describe('_recordFailure()', function () {
        it('ignores calls with empty pubkey', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc._recordFailure('', 'rid1');
            sc._recordFailure(null, 'rid2');
            expect(sc._failuresFor('')).to.have.length(0);
        });

        it('normalises pubkey to lowercase', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc._recordFailure('PUBKEY123', 'rid1');
            expect(sc._failuresFor('pubkey123')).to.have.length(1);
        });
    });

    // ── integration: consensus event binding ─────────────────────────────────

    describe('event binding via start()', function () {
        it('receives request:finalized events and processes them', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
            await sc.start();
            sc.register('rid001', 'http_get', 'expected');
            // Emit the event
            hub.attestationConsensus.emit('request:finalized', makeFinalizedEvent());
            // Allow async processing to settle
            await new Promise(r => setImmediate(r));
            // Failures recorded for both signers
            expect(sc._failuresFor('pubkey1')).to.have.length(1);
        });
    });
});
