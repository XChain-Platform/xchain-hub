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
        // The consensus event's status field carries the ATTEST wire status;
        // an ok round emits 'ok' (non-ok rounds are inconclusive spot-checks).
        status:       'ok',
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

            // Age the first failure out of the window by rewriting its timestamp. The
            // pruning rule is "older than SPOT_CHECK_FAILURE_WINDOW_MS", so stating that
            // directly is deterministic where sleeping past a wall clock is a race.
            for (let f of (sc._failures.get('pk') || [])) f.timestamp -= 200;

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

describe('AttestationSpotChecker: non-ok finalizations (Phase 4)', function () {

    const sinon = require('sinon');
    const { expect } = require('chai');
    const AttestationSpotChecker = require('../../src/AttestationSpotChecker');

    afterEach(function () { sinon.restore(); });

    function makeChecker() {
        const hub = { p2pConfig: {}, attestationConsensus: null, slashDetector: null };
        const registry = { getModule: sinon.stub().returns({ agree: sinon.stub().resolves(null) }) };
        return new AttestationSpotChecker(hub, registry);
    }

    it('treats a provider_error finalization as inconclusive: no failures, entry retained', async function () {
        const checker = makeChecker();
        const rid = 'ab'.repeat(32);
        checker.register(rid, 'llm', 'expected answer');
        await checker.onRequestFinalized({
            requestId:    rid,
            providerId:   'llm',
            responseBody: Buffer.alloc(0),
            meta:         '',
            status:       'provider_error',
            signatures:   [{ pubkey: 'aa'.repeat(32), sig: '00'.repeat(64) }]
        });
        expect(checker._failuresFor('aa'.repeat(32))).to.have.length(0);
        // Entry stays queued: the request is still pending on-chain and a
        // later ok round must still be judged.
        expect(checker.isSpotCheck(rid)).to.equal(true);
    });

    it('still judges (and can fail) an ok finalization after a prior non-ok one', async function () {
        const checker = makeChecker();
        const rid = 'cd'.repeat(32);
        checker.register(rid, 'llm', 'expected answer');
        await checker.onRequestFinalized({ requestId: rid, providerId: 'llm', responseBody: Buffer.alloc(0), meta: '', status: 'no_quorum', signatures: [] });
        expect(checker.isSpotCheck(rid)).to.equal(true);
        await checker.onRequestFinalized({
            requestId:    rid,
            providerId:   'llm',
            responseBody: Buffer.from('wrong answer'),
            meta:         'claude-sonnet-4-6',
            status:       'ok',
            signatures:   [{ pubkey: 'bb'.repeat(32), sig: '00'.repeat(64) }]
        });
        // agree() stub returns null → judged non-equivalent → failure recorded.
        expect(checker._failuresFor('bb'.repeat(32))).to.have.length(1);
        expect(checker.isSpotCheck(rid)).to.equal(false);
    });

    it('treats an inconclusive judge verdict (agree() populates options.outcome) as neutral: no failures recorded', async function () {
        const hub = { p2pConfig: {}, attestationConsensus: null, slashDetector: null };
        // Mirrors llm.js's inconclusive-null contract: agree() resolves null
        // and populates the caller-supplied options.outcome rather than
        // leaving the spot-checker unable to distinguish "could not judge"
        // from "judged not equivalent".
        const registry = {
            getModule: sinon.stub().returns({
                agree: sinon.stub().callsFake((proposals, options) => {
                    if (options && options.outcome) {
                        options.outcome.inconclusive = true;
                        options.outcome.reason = 'unreachable';
                    }
                    return Promise.resolve(null);
                })
            })
        };
        const checker = new AttestationSpotChecker(hub, registry);
        const rid = 'ef'.repeat(32);
        checker.register(rid, 'llm', 'expected answer');
        await checker.onRequestFinalized({
            requestId:    rid,
            providerId:   'llm',
            responseBody: Buffer.from('some answer'),
            meta:         'o1-mini',
            status:       'ok',
            signatures:   [{ pubkey: 'cc'.repeat(32), sig: '00'.repeat(64) }]
        });
        expect(checker._failuresFor('cc'.repeat(32))).to.have.length(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// reorg-safe stats persistence + rollback
// ────────────────────────────────────────────────────────────────────────────

// Minimal in-memory stand-in for the hub DB. Models the ON DUPLICATE KEY on
// (validator_pubkey, request_id), BOTH deletes this table takes (the reorg
// rollback on block_index and the age-based retention sweep on checked_at), and
// the COUNT/SUM aggregate that statsFor() runs.
function makeFakeDb() {
    const rows = [];
    const counts = { retentionDeletes: 0, retentionWindowSec: null };
    return {
        rows,
        counts,
        async doQuery(sql, args) {
            const s = String(sql).trim().toUpperCase();
            if (s.startsWith('INSERT')) {
                const [pk, provider, rid, blk, passed] = args;
                const existing = rows.find(r => r.validator_pubkey === pk && r.request_id === rid);
                if (existing) {
                    existing.passed = passed; existing.provider_id = provider; existing.block_index = blk;
                } else {
                    rows.push({ validator_pubkey: pk, provider_id: provider, request_id: rid,
                                block_index: blk, passed, checked_at: Date.now() });
                }
                return { affectedRows: 1 };
            }
            if (s.startsWith('DELETE')) {
                // Retention sweep: checked_at < DATE_SUB(NOW(), INTERVAL ? SECOND).
                if (s.indexOf('CHECKED_AT') !== -1) {
                    const windowSec = Number(args[0]);
                    counts.retentionDeletes++;
                    counts.retentionWindowSec = windowSec;
                    const cutoff = Date.now() - windowSec * 1000;
                    let pruned = 0;
                    for (let i = rows.length - 1; i >= 0; i--) {
                        const at = rows[i].checked_at !== undefined ? Number(rows[i].checked_at) : Date.now();
                        if (at < cutoff) { rows.splice(i, 1); pruned++; }
                    }
                    return { affectedRows: pruned };
                }
                // Reorg rollback: block_index > ?.
                const h = Number(args[0]);
                let removed = 0;
                for (let i = rows.length - 1; i >= 0; i--) {
                    if (Number(rows[i].block_index) > h) { rows.splice(i, 1); removed++; }
                }
                return { affectedRows: removed };
            }
            if (s.startsWith('SELECT')) {
                const pk = args[0];
                const mine = rows.filter(r => r.validator_pubkey === pk);
                return [{ total: mine.length, failed: mine.filter(r => Number(r.passed) === 0).length }];
            }
            return [];
        }
    };
}

function okEvent(rid, blockIndex, signers) {
    return {
        requestId:    rid,
        providerId:   'http_get',
        responseBody: Buffer.from('resp', 'utf8'),
        status:       'ok',
        meta:         '200',
        request:      { block_index: blockIndex },
        signatures:   (signers || ['pubkey1']).map(pk => ({ pubkey: pk }))
    };
}

describe('AttestationSpotChecker: reorg-safe stats', function () {

    afterEach(function () { sinon.restore(); });

    it('persists a passing spot-check as a row (passed=1) keyed by block_index', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        sc.register('r1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('r1', 500, ['aa'.repeat(32)]));
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].passed).to.equal(1);
        expect(db.rows[0].block_index).to.equal(500);
        expect(db.rows[0].validator_pubkey).to.equal('aa'.repeat(32));
    });

    it('persists a failing spot-check as a row (passed=0) for every signer', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        sc.register('r2', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('r2', 600, ['aa'.repeat(32), 'bb'.repeat(32)]));
        expect(db.rows).to.have.length(2);
        expect(db.rows.every(r => r.passed === 0)).to.be.true;
    });

    it('statsFor aggregates total/failed/passed from persisted rows', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const scFail = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        const pk = 'cc'.repeat(32);
        scFail.register('rf', 'http_get', 'e');
        await scFail.onRequestFinalized(okEvent('rf', 10, [pk]));
        const scPass = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        scPass.register('rp', 'http_get', 'e');
        await scPass.onRequestFinalized(okEvent('rp', 11, [pk]));
        const stats = await scFail.statsFor(pk);
        expect(stats).to.deep.equal({ total: 2, failed: 1, passed: 1 });
    });

    it('rollback deletes rows above the reorg height and clears in-memory failures', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        sc.register('low',  'http_get', 'e');
        sc.register('high', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('low',  100, ['dd'.repeat(32)]));
        await sc.onRequestFinalized(okEvent('high', 200, ['dd'.repeat(32)]));
        expect(db.rows).to.have.length(2);
        expect(sc._failuresFor('dd'.repeat(32))).to.have.length(2);

        const removed = await sc.rollback(150);
        expect(removed).to.equal(1);                 // only the block-200 row
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].block_index).to.equal(100);
        expect(sc._failuresFor('dd'.repeat(32))).to.have.length(0);  // window cleared
    });

    it('persist is a no-op (no throw) when the hub has no DB', async function () {
        const hub = makeHub();               // no db
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        sc.register('r', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('r', 5, ['ee'.repeat(32)]));  // must not throw
        expect(await sc.statsFor('ee'.repeat(32))).to.deep.equal({ total: 0, failed: 0, passed: 0 });
    });

    it('rollback is a safe no-op (returns 0) with no DB but still clears the window', async function () {
        const hub = makeHub();
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        sc._recordFailure('ff'.repeat(32), 'x');
        expect(sc._failuresFor('ff'.repeat(32))).to.have.length(1);
        const removed = await sc.rollback(10);
        expect(removed).to.equal(0);
        expect(sc._failuresFor('ff'.repeat(32))).to.have.length(0);
    });

    it('start() wires reorg:confirmed to rollback and stop() unwires it', async function () {
        const db    = makeFakeDb();
        const reorg = new EventEmitter();
        const hub   = makeHub({ db, reorgHandler: reorg });
        const sc    = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        sc.register('a', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('a', 300, ['ab'.repeat(32)]));
        await sc.start();
        expect(reorg.listenerCount('reorg:confirmed')).to.equal(1);

        reorg.emit('reorg:confirmed', { reorgHeight: 250 });
        await new Promise(r => setImmediate(r));
        expect(db.rows).to.have.length(0);           // block-300 row rolled back

        await sc.stop();
        expect(reorg.listenerCount('reorg:confirmed')).to.equal(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// durable-outcome retention
// ────────────────────────────────────────────────────────────────────────────

describe('AttestationSpotChecker: stats retention', function () {

    afterEach(function () { sinon.restore(); });

    const DAY = 24 * 60 * 60 * 1000;

    function seedRow(db, rid, ageMs) {
        db.rows.push({
            validator_pubkey: 'ab'.repeat(32), provider_id: 'http_get', request_id: rid,
            block_index: 10, passed: 1, checked_at: Date.now() - ageMs
        });
    }

    it('prunes outcome rows past the retention window and keeps recent ones', async function () {
        const db  = makeFakeDb();
        const sc  = new AttestationSpotChecker(makeHub({ db }), makeProviderRegistry(true));
        seedRow(db, 'old',    120 * DAY);
        seedRow(db, 'recent',   2 * DAY);

        const pruned = await sc._pruneStats();
        expect(pruned, 'only the row past the 90-day default window').to.equal(1);
        expect(db.rows.map(r => r.request_id)).to.deep.equal(['recent']);
        expect(sc.statsPruned).to.equal(1);
    });

    it('floors the window at the rolling failure window, so a tiny config cannot delete live evidence', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        hub.p2pConfig = { SPOT_CHECK_STATS_RETENTION_MS: '1000' };   // 1s, far below the 24h window
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        seedRow(db, 'hour-old', 60 * 60 * 1000);

        const pruned = await sc._pruneStats();
        expect(pruned, 'an hour-old row is still inside the 24h failure window').to.equal(0);
        expect(db.counts.retentionWindowSec).to.equal(Math.ceil(sc.failureWindowMs / 1000));
    });

    it('an explicit 0 disables the sweep entirely', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        hub.p2pConfig = { SPOT_CHECK_STATS_RETENTION_MS: '0' };
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        seedRow(db, 'ancient', 400 * DAY);

        expect(sc.statsRetentionMs).to.equal(0);
        expect(await sc._pruneStats()).to.equal(0);
        expect(db.counts.retentionDeletes, 'no DELETE is issued at all').to.equal(0);
        expect(db.rows).to.have.length(1);
    });

    it('persisting an outcome sweeps once, then throttles', async function () {
        const db = makeFakeDb();
        const sc = new AttestationSpotChecker(makeHub({ db }), makeProviderRegistry(true));
        seedRow(db, 'old', 120 * DAY);

        sc.register('r1', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('r1', 500, ['aa'.repeat(32)]));
        await sc._statsSweep;
        expect(db.counts.retentionDeletes, 'the first persisted outcome sweeps').to.equal(1);
        expect(db.rows.some(r => r.request_id === 'old'), 'the aged row is gone').to.equal(false);

        sc.register('r2', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('r2', 501, ['aa'.repeat(32)]));
        await sc._statsSweep;
        expect(db.counts.retentionDeletes, 'the next outcome is throttled out').to.equal(1);
    });

    it('a failing sweep is swallowed and never breaks the judging path', async function () {
        const db = makeFakeDb();
        const sc = new AttestationSpotChecker(makeHub({ db }), makeProviderRegistry(true));
        sinon.stub(sc, '_pruneStats').rejects(new Error('DB gone'));
        sinon.stub(console, 'warn');

        sc.register('r1', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('r1', 500, ['aa'.repeat(32)]));   // must not throw
        expect(await sc._statsSweep).to.equal(0);
        expect(db.rows, 'the outcome still persisted').to.have.length(1);
    });

    it('is a safe no-op with no DB wired', async function () {
        const sc = new AttestationSpotChecker(makeHub(), makeProviderRegistry(true));
        expect(await sc._pruneStats()).to.equal(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// injection scheduler
// ────────────────────────────────────────────────────────────────────────────

describe('AttestationSpotChecker: injection scheduler', function () {

    afterEach(function () { sinon.restore(); });

    const CORPUS = [
        { providerId: 'http_get', prompt: 'q1', expectedPattern: 'a1' },
        { providerId: 'llm',      prompt: 'q2', expectedPattern: 'a2' }
    ];

    it('_isTruthy accepts common truthy spellings only', function () {
        const sc = new AttestationSpotChecker(makeHub(), makeProviderRegistry());
        ['1', 'true', 'TRUE', 'yes', 'on', true].forEach(v => expect(sc._isTruthy(v)).to.be.true);
        ['0', 'false', '', 'off', undefined, null].forEach(v => expect(sc._isTruthy(v)).to.be.false);
    });

    it('parses a corpus from a JSON string and from an array, dropping malformed entries', function () {
        const sc = new AttestationSpotChecker(makeHub(), makeProviderRegistry());
        const parsed = sc._parseCorpus(JSON.stringify([
            { provider_id: 'http_get', prompt: 'p', expected: 'x' },  // snake_case aliases
            { prompt: 'no provider' },                                // dropped
            { providerId: 'llm' },                                    // dropped (no prompt)
            'garbage'                                                 // dropped
        ]));
        expect(parsed).to.deep.equal([{ providerId: 'http_get', prompt: 'p', expectedPattern: 'x' }]);
        expect(sc._parseCorpus('not json')).to.deep.equal([]);
        expect(sc._parseCorpus(null)).to.deep.equal([]);
    });

    it('scheduler stays idle when SPOT_CHECK_ENABLED is unset', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: { SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.equal(null);
        await sc.stop();
    });

    it('scheduler stays idle when enabled but no injector is wired', async function () {
        const hub = makeHub({ p2pConfig: { SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.equal(null);
        await sc.stop();
    });

    it('scheduler stays idle when enabled with an injector but an empty corpus', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: { SPOT_CHECK_ENABLED: 'true' } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.equal(null);
        await sc.stop();
    });

    it('starts a scheduler interval when enabled + injector + corpus, and stop() clears it', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_INTERVAL_MS: '999999', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.not.equal(null);
        await sc.stop();
        expect(sc._scheduler).to.equal(null);
    });

    it('_schedulerTick injects via the injector and registers the returned request_id', async function () {
        const injector = sinon.stub()
            .onFirstCall().resolves({ requestId: 'SYNTH1' })
            .onSecondCall().resolves('SYNTH2');   // bare-string return also accepted
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_MAX_PER_TICK: '2', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        const n = await sc._schedulerTick();
        expect(n).to.equal(2);
        expect(injector.callCount).to.equal(2);
        expect(sc.isSpotCheck('SYNTH1')).to.be.true;
        expect(sc.isSpotCheck('SYNTH2')).to.be.true;
        // Corpus round-robins: first entry is http_get, second is llm.
        expect(injector.firstCall.args[0].providerId).to.equal('http_get');
        expect(injector.secondCall.args[0].providerId).to.equal('llm');
    });

    it('round-robins the corpus cursor across ticks', async function () {
        const injector = sinon.stub().callsFake(() => Promise.resolve({ requestId: 'rid' + Math.random() }));
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });  // maxPerTick default 1
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc._schedulerTick();
        await sc._schedulerTick();
        await sc._schedulerTick();
        expect(injector.getCall(0).args[0].prompt).to.equal('q1');
        expect(injector.getCall(1).args[0].prompt).to.equal('q2');
        expect(injector.getCall(2).args[0].prompt).to.equal('q1');  // wrapped
    });

    it('a throwing injector does not abort the batch or throw out of the tick', async function () {
        const injector = sinon.stub()
            .onFirstCall().rejects(new Error('encoder down'))
            .onSecondCall().resolves({ requestId: 'OK2' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_MAX_PER_TICK: '2', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        const n = await sc._schedulerTick();     // must not throw
        expect(n).to.equal(1);
        expect(sc.isSpotCheck('OK2')).to.be.true;
    });

    it('does not register when the injector returns no request_id', async function () {
        const injector = sinon.stub().resolves({ notARequestId: true });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        const n = await sc._schedulerTick();
        expect(n).to.equal(0);
        expect(sc._queueSize()).to.equal(0);
    });

    it('skips the tick under queue backpressure (near capacity)', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        for (let i = 0; i < 1000; i++) sc.register('q' + i, 'http_get', 'e');  // >= 90% of 1024
        const n = await sc._schedulerTick();
        expect(n).to.equal(0);
        expect(injector.called).to.be.false;
    });
});

// ────────────────────────────────────────────────────────────────────────────
// an unavailable judge no longer discards the spot-check
// ────────────────────────────────────────────────────────────────────────────

// A judge that is unavailable (inconclusive with `reason`) for its first
// `unavailableFor` calls and then answers `then`.
function makeFlakyRegistry(reason, unavailableFor, then) {
    let calls = 0;
    const agree = (proposals, options) => {
        if (calls++ < unavailableFor) {
            if (options && options.outcome) {
                options.outcome.inconclusive = true;
                options.outcome.reason = reason;
            }
            return Promise.resolve(null);
        }
        return Promise.resolve(then);
    };
    return { calls: () => calls, getModule: () => ({ agree }) };
}

describe('AttestationSpotChecker: re-judge queue', function () {

    afterEach(function () { sinon.restore(); });

    it('holds a provider_paused spot-check instead of discarding it, recording no evidence yet', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', 1, false));
        sc.register('rp1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rp1', 700, ['aa'.repeat(32)]));
        expect(sc._pendingReJudgeSize()).to.equal(1);
        expect(db.rows).to.have.length(0);                       // neutral while held
        expect(sc._failuresFor('aa'.repeat(32))).to.have.length(0);
    });

    it('scores the held spot-check once the provider resumes (the coverage that used to be lost)', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', 1, false));
        sc.register('rp2', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rp2', 701, ['bb'.repeat(32)]));
        const scored = await sc._sweepReJudge();                 // provider is back
        expect(scored).to.equal(1);
        expect(sc._pendingReJudgeSize()).to.equal(0);
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].passed).to.equal(0);                   // judged wrong
        expect(db.rows[0].block_index).to.equal(701);            // the ORIGINAL request's block
        expect(sc._failuresFor('bb'.repeat(32))).to.have.length(1);
    });

    it('holds a spot-check whose judge call threw, and scores a pass on the retry', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        let calls = 0;
        const registry = { getModule: () => ({ agree: () => {
            if (calls++ === 0) return Promise.reject(new Error('judge transport reset'));
            return Promise.resolve(true);
        } }) };
        const sc = new AttestationSpotChecker(hub, registry);
        sc.register('rt1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rt1', 702, ['cc'.repeat(32)]));
        expect(sc._pendingReJudgeSize()).to.equal(1);
        await sc._sweepReJudge();
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].passed).to.equal(1);
        expect(sc._failuresFor('cc'.repeat(32))).to.have.length(0);
    });

    it('does NOT hold a neutral verdict: a reason about the round itself can never change', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('meta_unrecognized', 1, false));
        sc.register('rn1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rn1', 703, ['dd'.repeat(32)]));
        expect(sc._pendingReJudgeSize()).to.equal(0);
        expect(db.rows).to.have.length(0);
        expect(sc._failuresFor('dd'.repeat(32))).to.have.length(0);
    });

    it('stops holding a record whose reason turns neutral on a later attempt', async function () {
        const hub = makeHub({ db: makeFakeDb() });
        let calls = 0;
        const registry = { getModule: () => ({ agree: (p, options) => {
            options.outcome.inconclusive = true;
            options.outcome.reason = (calls++ === 0) ? 'provider_paused' : 'unparseable';
            return Promise.resolve(null);
        } }) };
        const sc = new AttestationSpotChecker(hub, registry);
        sc.register('rn2', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rn2', 704, ['ee'.repeat(32)]));
        expect(sc._pendingReJudgeSize()).to.equal(1);
        await sc._sweepReJudge();
        expect(sc._pendingReJudgeSize()).to.equal(0);
    });

    it('gives up after the attempt cap rather than holding a response body forever', async function () {
        const hub = makeHub({ db: makeFakeDb() });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        sc.register('rc1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rc1', 705, ['ff'.repeat(32)]));
        for (let i = 0; i < 6; i++) await sc._sweepReJudge();
        expect(sc._pendingReJudgeSize()).to.equal(0);
    });

    it('ages a held record out even when the sweep never reaches the attempt cap', async function () {
        const hub = makeHub({ db: makeFakeDb(), p2pConfig: { SPOT_CHECK_REJUDGE_MAX_AGE_MS: '1' } });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        sc.register('ra1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('ra1', 706, ['ab'.repeat(32)]));
        expect(sc._pendingReJudgeSize()).to.equal(1);
        // Age the held record past SPOT_CHECK_REJUDGE_MAX_AGE_MS directly rather than
        // sleeping through it: the sweep compares firstSeen, so this is the same fact.
        for (let rec of sc._pendingReJudge.values()) rec.firstSeen -= 50;
        await sc._sweepReJudge();
        expect(sc._pendingReJudgeSize()).to.equal(0);
    });

    it('a reorg purges held records above the reorg height so the sweep cannot score an orphaned round', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', 2, false));
        sc.register('rr1', 'http_get', 'expected');
        sc.register('rr2', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rr1', 100, ['ac'.repeat(32)]));   // below the reorg
        await sc.onRequestFinalized(okEvent('rr2', 900, ['ad'.repeat(32)]));   // orphaned
        expect(sc._pendingReJudgeSize()).to.equal(2);
        await sc.rollback(500);
        expect(sc._pendingReJudgeSize()).to.equal(1);
        await sc._sweepReJudge();
        expect(db.rows.map(r => r.block_index)).to.deep.equal([100]);
    });

    it('bounds the held map, dropping the oldest record at capacity', async function () {
        const hub = makeHub({ db: makeFakeDb() });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        for (let i = 0; i < 300; i++) {
            sc.register('rb' + i, 'http_get', 'expected');
            await sc.onRequestFinalized(okEvent('rb' + i, 800 + i, ['ae'.repeat(32)]));
        }
        expect(sc._pendingReJudgeSize()).to.equal(256);
    });

    it('stop() releases the sweep timer and the held bodies', async function () {
        const hub = makeHub({ db: makeFakeDb(), attestationConsensus: null });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        await sc.start();
        expect(sc._sweeper).to.not.equal(null);
        sc.register('rs1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rs1', 900, ['af'.repeat(32)]));
        expect(sc._pendingReJudgeSize()).to.equal(1);
        await sc.stop();
        expect(sc._sweeper).to.equal(null);
        expect(sc._pendingReJudgeSize()).to.equal(0);
    });
});
