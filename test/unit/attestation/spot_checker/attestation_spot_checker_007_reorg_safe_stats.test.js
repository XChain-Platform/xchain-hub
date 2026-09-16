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
const AttestationSpotChecker = require('../../../../src/attestation/spot_checker');
const { DB_METHODS }         = require('../../../helpers/mockHub.js');

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
const hookAt24737 = function () { sinon.restore(); };

describe('AttestationSpotChecker: reorg-safe stats', function () { afterEach(hookAt24737); it('persists a passing spot-check as a row (passed=1) keyed by block_index', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        sc.register('r1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('r1', 500, ['aa'.repeat(32)]));
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].passed).to.equal(1);
        expect(db.rows[0].block_index).to.equal(500);
        expect(db.rows[0].validator_pubkey).to.equal('aa'.repeat(32));
    }); });

describe('AttestationSpotChecker: reorg-safe stats', function () { afterEach(hookAt24737); it('persists a failing spot-check as a row (passed=0) for every signer', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        sc.register('r2', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('r2', 600, ['aa'.repeat(32), 'bb'.repeat(32)]));
        expect(db.rows).to.have.length(2);
        expect(db.rows.every(r => r.passed === 0)).to.be.true;
    }); });

describe('AttestationSpotChecker: reorg-safe stats', function () { afterEach(hookAt24737); it('statsFor aggregates total/failed/passed from persisted rows', async function () {
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
    }); });

describe('AttestationSpotChecker: reorg-safe stats', function () { afterEach(hookAt24737); it('rollback deletes rows above the reorg height and clears in-memory failures', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        sc.register('low',  'http_get', 'e');
        sc.register('high', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('low',  100, ['dd'.repeat(32)]));
        await sc.onRequestFinalized(okEvent('high', 200, ['dd'.repeat(32)]));
        expect(db.rows).to.have.length(2);
        expect(sc.failuresFor('dd'.repeat(32))).to.have.length(2);

        const removed = await sc.rollback(150);
        expect(removed).to.equal(1);                 // only the block-200 row
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].block_index).to.equal(100);
        expect(sc.failuresFor('dd'.repeat(32))).to.have.length(0);  // window cleared
    }); });

describe('AttestationSpotChecker: reorg-safe stats', function () { afterEach(hookAt24737); it('persist is a no-op (no throw) when the hub has no DB', async function () {
        const hub = makeHub();               // no db
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        sc.register('r', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('r', 5, ['ee'.repeat(32)]));  // must not throw
        expect(await sc.statsFor('ee'.repeat(32))).to.deep.equal({ total: 0, failed: 0, passed: 0 });
    }); });

describe('AttestationSpotChecker: reorg-safe stats', function () { afterEach(hookAt24737); it('rollback is a safe no-op (returns 0) with no DB but still clears the window', async function () {
        const hub = makeHub();
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(false));
        sc.recordFailure('ff'.repeat(32), 'x');
        expect(sc.failuresFor('ff'.repeat(32))).to.have.length(1);
        const removed = await sc.rollback(10);
        expect(removed).to.equal(0);
        expect(sc.failuresFor('ff'.repeat(32))).to.have.length(0);
    }); });

describe('AttestationSpotChecker: reorg-safe stats', function () { afterEach(hookAt24737); it('start() wires reorg:confirmed to rollback and stop() unwires it', async function () {
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
    }); });
}
