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
const AttestationSpotChecker = require('../../src/attestation/spot_checker');
const { DB_METHODS }         = require('../helpers/mockHub.js');

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
    // DB_METHODS first: the checker calls named query methods, and each of them
    // routes its statement through the doQuery below.
    return { ...DB_METHODS,
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

// ────────────────────────────────────────────────────────────────────────────
// durable-outcome retention
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// injection scheduler
// ────────────────────────────────────────────────────────────────────────────

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

{
const hookAt2320 = function () {
        sinon.restore();
    };

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('does nothing for non-spot-check requests', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            // rid001 is NOT registered as a spot-check
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc.failuresFor('pubkey1')).to.have.length(0);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('does nothing when event has no requestId', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            await sc.onRequestFinalized(null);
            await sc.onRequestFinalized({});
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('removes the entry from queue after processing', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc.isSpotCheck('rid001')).to.be.false;
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('logs and returns on provider_id mismatch', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('rid001', 'llm', 'expected');  // registered as llm
            // event has http_get
            await sc.onRequestFinalized(makeFinalizedEvent({ providerId: 'http_get' }));
            // No failures recorded (provider mismatch → inconclusive)
            expect(sc.failuresFor('pubkey1')).to.have.length(0);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('logs and returns when provider module has no agree()', async function () {
            let hub = makeHub();
            let reg = { getModule: sinon.stub().returns({ /* no agree */ }) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc.failuresFor('pubkey1')).to.have.length(0);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('logs and returns when provider registry returns null module', async function () {
            let hub = makeHub();
            let reg = { getModule: sinon.stub().returns(null) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc.failuresFor('pubkey1')).to.have.length(0);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('returns without recording failures when agree() returns truthy (pass)', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc.failuresFor('pubkey1')).to.have.length(0);
            expect(sc.failuresFor('pubkey2')).to.have.length(0);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('records failures against all signers when agree() returns falsy (fail)', async function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent());
            expect(sc.failuresFor('pubkey1')).to.have.length(1);
            expect(sc.failuresFor('pubkey2')).to.have.length(1);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('handles agree() throwing without propagating the error', async function () {
            let hub = makeHub();
            let reg = { getModule: sinon.stub().returns({ agree: sinon.stub().rejects(new Error('judge died')) }) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent()); // must not throw
            expect(sc.failuresFor('pubkey1')).to.have.length(0);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('handles string responseBody (wraps to Buffer)', async function () {
            let hub = makeHub();
            let agreeSpy = sinon.stub().resolves(false);
            let reg = { getModule: sinon.stub().returns({ agree: agreeSpy }) };
            let sc  = new AttestationSpotChecker(hub, reg);
            sc.register('rid001', 'http_get', 'expected');
            await sc.onRequestFinalized(makeFinalizedEvent({ responseBody: 'string body' }));
            expect(agreeSpy.called).to.be.true;
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('calls slashDetector when failure count reaches threshold', async function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_THRESHOLD: '3' } });
            let slashStub = sinon.stub().resolves();
            hub.slashDetector = { recordSlashProposal: slashStub };
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
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('does NOT call slashDetector when failures are below threshold', async function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_THRESHOLD: '5' } });
            let slashStub = sinon.stub().resolves();
            hub.slashDetector = { recordSlashProposal: slashStub };
            let sc = new AttestationSpotChecker(hub, makeProviderRegistry(false));

            for (let i = 1; i <= 2; i++) {
                sc.register('rid' + i, 'http_get', 'expected');
                await sc.onRequestFinalized(makeFinalizedEvent({
                    requestId: 'rid' + i,
                    signatures: [{ pubkey: 'pubkey1' }]
                }));
            }

            expect(slashStub.called).to.be.false;
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('prunes failures outside the failure window', async function () {
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
            let failures = sc.failuresFor('pk');
            expect(failures).to.have.length(1);
        }); }); });

// ── onRequestFinalized ───────────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('onRequestFinalized()', function () { it('caps history at MAX_HISTORY_PER_VALIDATOR (64) entries', async function () {
            let hub = makeHub({ p2pConfig: { SPOT_CHECK_FAILURE_WINDOW_MS: String(10 * 60 * 60 * 1000) } });
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));

            // Register and finalize 70 distinct spot-check failures for the same validator
            for (let i = 0; i < 70; i++) {
                let rid = 'a' + String(i).padStart(7, '0');
                sc.register(rid, 'http_get', 'expected');
                await sc.onRequestFinalized(makeFinalizedEvent({ requestId: rid, signatures: [{ pubkey: 'pka' }] }));
            }

            expect(sc.failuresFor('pka').length).to.be.at.most(64);
        }); }); });
}
