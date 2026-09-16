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
const hookAt41466 = function () { sinon.restore(); };

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('holds a provider_paused spot-check instead of discarding it, recording no evidence yet', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', 1, false));
        sc.register('rp1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rp1', 700, ['aa'.repeat(32)]));
        expect(sc.pendingReJudgeSize()).to.equal(1);
        expect(db.rows).to.have.length(0);                       // neutral while held
        expect(sc.failuresFor('aa'.repeat(32))).to.have.length(0);
    }); });

// A spent per-window spend budget heals when the window rolls, so it is held for
    // re-judge exactly like a paused provider rather than dropped.
describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('holds a budget_exhausted spot-check for re-judge instead of dropping it', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('budget_exhausted', 1, false));
        sc.register('rb1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rb1', 700, ['aa'.repeat(32)]));
        expect(sc.pendingReJudgeSize()).to.equal(1);
        expect(db.rows).to.have.length(0);
        expect(sc.failuresFor('aa'.repeat(32))).to.have.length(0);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('scores the held spot-check once the provider resumes (the coverage that used to be lost)', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', 1, false));
        sc.register('rp2', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rp2', 701, ['bb'.repeat(32)]));
        const scored = await sc.sweepReJudge();                 // provider is back
        expect(scored).to.equal(1);
        expect(sc.pendingReJudgeSize()).to.equal(0);
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].passed).to.equal(0);                   // judged wrong
        expect(db.rows[0].block_index).to.equal(701);            // the ORIGINAL request's block
        expect(sc.failuresFor('bb'.repeat(32))).to.have.length(1);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('holds a spot-check whose judge call threw, and scores a pass on the retry', async function () {
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
        expect(sc.pendingReJudgeSize()).to.equal(1);
        await sc.sweepReJudge();
        expect(db.rows).to.have.length(1);
        expect(db.rows[0].passed).to.equal(1);
        expect(sc.failuresFor('cc'.repeat(32))).to.have.length(0);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('does NOT hold a neutral verdict: a reason about the round itself can never change', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('meta_unrecognized', 1, false));
        sc.register('rn1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rn1', 703, ['dd'.repeat(32)]));
        expect(sc.pendingReJudgeSize()).to.equal(0);
        expect(db.rows).to.have.length(0);
        expect(sc.failuresFor('dd'.repeat(32))).to.have.length(0);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('stops holding a record whose reason turns neutral on a later attempt', async function () {
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
        expect(sc.pendingReJudgeSize()).to.equal(1);
        await sc.sweepReJudge();
        expect(sc.pendingReJudgeSize()).to.equal(0);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('gives up after the attempt cap rather than holding a response body forever', async function () {
        const hub = makeHub({ db: makeFakeDb() });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        sc.register('rc1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rc1', 705, ['ff'.repeat(32)]));
        for (let i = 0; i < 6; i++) await sc.sweepReJudge();
        expect(sc.pendingReJudgeSize()).to.equal(0);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('ages a held record out even when the sweep never reaches the attempt cap', async function () {
        const hub = makeHub({ db: makeFakeDb(), p2pConfig: { SPOT_CHECK_REJUDGE_MAX_AGE_MS: '1' } });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        sc.register('ra1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('ra1', 706, ['ab'.repeat(32)]));
        expect(sc.pendingReJudgeSize()).to.equal(1);
        // Age the held record past SPOT_CHECK_REJUDGE_MAX_AGE_MS directly rather than
        // sleeping through it: the sweep compares firstSeen, so this is the same fact.
        for (let rec of sc._pendingReJudge.values()) rec.firstSeen -= 50;
        await sc.sweepReJudge();
        expect(sc.pendingReJudgeSize()).to.equal(0);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('a reorg purges held records above the reorg height so the sweep cannot score an orphaned round', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', 2, false));
        sc.register('rr1', 'http_get', 'expected');
        sc.register('rr2', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rr1', 100, ['ac'.repeat(32)]));   // below the reorg
        await sc.onRequestFinalized(okEvent('rr2', 900, ['ad'.repeat(32)]));   // orphaned
        expect(sc.pendingReJudgeSize()).to.equal(2);
        await sc.rollback(500);
        expect(sc.pendingReJudgeSize()).to.equal(1);
        await sc.sweepReJudge();
        expect(db.rows.map(r => r.block_index)).to.deep.equal([100]);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('bounds the held map, dropping the oldest record at capacity', async function () {
        const hub = makeHub({ db: makeFakeDb() });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        for (let i = 0; i < 300; i++) {
            sc.register('rb' + i, 'http_get', 'expected');
            await sc.onRequestFinalized(okEvent('rb' + i, 800 + i, ['ae'.repeat(32)]));
        }
        expect(sc.pendingReJudgeSize()).to.equal(256);
    }); });

describe('AttestationSpotChecker: re-judge queue', function () { afterEach(hookAt41466); it('stop() releases the sweep timer and the held bodies', async function () {
        const hub = makeHub({ db: makeFakeDb(), attestationConsensus: null });
        const sc  = new AttestationSpotChecker(hub, makeFlakyRegistry('provider_paused', Infinity, false));
        await sc.start();
        expect(sc._sweeper).to.not.equal(null);
        sc.register('rs1', 'http_get', 'expected');
        await sc.onRequestFinalized(okEvent('rs1', 900, ['af'.repeat(32)]));
        expect(sc.pendingReJudgeSize()).to.equal(1);
        await sc.stop();
        expect(sc._sweeper).to.equal(null);
        expect(sc.pendingReJudgeSize()).to.equal(0);
    }); });
}
