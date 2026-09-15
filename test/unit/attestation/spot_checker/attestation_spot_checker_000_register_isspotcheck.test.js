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
const hookAt2320 = function () {
        sinon.restore();
    };

// ── register / isSpotCheck ──────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('register() / isSpotCheck()', function () { it('registers a spot-check and reports isSpotCheck=true', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('REQ001', 'http_get', 'expected pattern');
            expect(sc.isSpotCheck('REQ001')).to.be.true;
            expect(sc.isSpotCheck('req001')).to.be.true; // case-insensitive
        }); }); });

// ── register / isSpotCheck ──────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('register() / isSpotCheck()', function () { it('returns false for unknown requestIds', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            expect(sc.isSpotCheck('unknown')).to.be.false;
        }); }); });

// ── register / isSpotCheck ──────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('register() / isSpotCheck()', function () { it('ignores registration with empty requestId', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('', 'http_get', 'pattern');
            expect(sc.queueSize()).to.equal(0);
        }); }); });

// ── register / isSpotCheck ──────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('register() / isSpotCheck()', function () { it('ignores registration with no providerId', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            sc.register('rid1', '', 'pattern');
            expect(sc.queueSize()).to.equal(0);
        }); }); });

// ── register / isSpotCheck ──────────────────────────────────────────────
describe('AttestationSpotChecker', function () { afterEach(hookAt2320); describe('register() / isSpotCheck()', function () { it('drops the oldest entry when MAX_QUEUE_SIZE (1024) is exceeded', function () {
            let hub = makeHub();
            let sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
            // Fill the queue to capacity
            for (let i = 0; i < 1024; i++) {
                sc.register('rid' + i, 'http_get', 'p');
            }
            expect(sc.queueSize()).to.equal(1024);
            // rid0 is the first/oldest entry
            expect(sc.isSpotCheck('rid0')).to.be.true;
            // Adding one more evicts rid0
            sc.register('rid_new', 'http_get', 'p');
            expect(sc.queueSize()).to.equal(1024);
            expect(sc.isSpotCheck('rid0')).to.be.false;
            expect(sc.isSpotCheck('rid_new')).to.be.true;
        }); }); });
}
