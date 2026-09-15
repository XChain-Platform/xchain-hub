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
const hookAt29604 = function () { sinon.restore(); };

const DAY = 24 * 60 * 60 * 1000;

function seedRow(db, rid, ageMs) {
        db.rows.push({
            validator_pubkey: 'ab'.repeat(32), provider_id: 'http_get', request_id: rid,
            block_index: 10, passed: 1, checked_at: Date.now() - ageMs
        });
    }

describe('AttestationSpotChecker: stats retention', function () { afterEach(hookAt29604); it('prunes outcome rows past the retention window and keeps recent ones', async function () {
        const db  = makeFakeDb();
        const sc  = new AttestationSpotChecker(makeHub({ db }), makeProviderRegistry(true));
        seedRow(db, 'old',    120 * DAY);
        seedRow(db, 'recent',   2 * DAY);

        const pruned = await sc.pruneStats();
        expect(pruned, 'only the row past the 90-day default window').to.equal(1);
        expect(db.rows.map(r => r.request_id)).to.deep.equal(['recent']);
        expect(sc.statsPruned).to.equal(1);
    }); });

describe('AttestationSpotChecker: stats retention', function () { afterEach(hookAt29604); it('floors the window at the rolling failure window, so a tiny config cannot delete live evidence', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        hub.p2pConfig = { SPOT_CHECK_STATS_RETENTION_MS: '1000' };   // 1s, far below the 24h window
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        seedRow(db, 'hour-old', 60 * 60 * 1000);

        const pruned = await sc.pruneStats();
        expect(pruned, 'an hour-old row is still inside the 24h failure window').to.equal(0);
        expect(db.counts.retentionWindowSec).to.equal(Math.ceil(sc.failureWindowMs / 1000));
    }); });

describe('AttestationSpotChecker: stats retention', function () { afterEach(hookAt29604); it('an explicit 0 disables the sweep entirely', async function () {
        const db  = makeFakeDb();
        const hub = makeHub({ db });
        hub.p2pConfig = { SPOT_CHECK_STATS_RETENTION_MS: '0' };
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry(true));
        seedRow(db, 'ancient', 400 * DAY);

        expect(sc.statsRetentionMs).to.equal(0);
        expect(await sc.pruneStats()).to.equal(0);
        expect(db.counts.retentionDeletes, 'no DELETE is issued at all').to.equal(0);
        expect(db.rows).to.have.length(1);
    }); });

describe('AttestationSpotChecker: stats retention', function () { afterEach(hookAt29604); it('persisting an outcome sweeps once, then throttles', async function () {
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
    }); });

describe('AttestationSpotChecker: stats retention', function () { afterEach(hookAt29604); it('a failing sweep is swallowed and never breaks the judging path', async function () {
        const db = makeFakeDb();
        const sc = new AttestationSpotChecker(makeHub({ db }), makeProviderRegistry(true));
        sinon.stub(sc, 'pruneStats').rejects(new Error('DB gone'));
        sinon.stub(console, 'warn');

        sc.register('r1', 'http_get', 'e');
        await sc.onRequestFinalized(okEvent('r1', 500, ['aa'.repeat(32)]));   // must not throw
        expect(await sc._statsSweep).to.equal(0);
        expect(db.rows, 'the outcome still persisted').to.have.length(1);
    }); });

describe('AttestationSpotChecker: stats retention', function () { afterEach(hookAt29604); it('is a safe no-op with no DB wired', async function () {
        const sc = new AttestationSpotChecker(makeHub(), makeProviderRegistry(true));
        expect(await sc.pruneStats()).to.equal(0);
    }); });
}
