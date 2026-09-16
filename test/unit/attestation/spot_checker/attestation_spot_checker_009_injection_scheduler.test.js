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
const hookAt33644 = function () { sinon.restore(); };

const CORPUS = [
        { providerId: 'http_get', prompt: 'q1', expectedPattern: 'a1' },
        { providerId: 'llm',      prompt: 'q2', expectedPattern: 'a2' }
    ];

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('isTruthy accepts common truthy spellings only', function () {
        const sc = new AttestationSpotChecker(makeHub(), makeProviderRegistry());
        ['1', 'true', 'TRUE', 'yes', 'on', true].forEach(v => expect(sc.isTruthy(v)).to.be.true);
        ['0', 'false', '', 'off', undefined, null].forEach(v => expect(sc.isTruthy(v)).to.be.false);
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('parses a corpus from a JSON string and from an array, dropping malformed entries', function () {
        const sc = new AttestationSpotChecker(makeHub(), makeProviderRegistry());
        const parsed = sc.parseCorpus(JSON.stringify([
            { provider_id: 'http_get', prompt: 'p', expected: 'x' },  // snake_case aliases
            { prompt: 'no provider' },                                // dropped
            { providerId: 'llm' },                                    // dropped (no prompt)
            'garbage'                                                 // dropped
        ]));
        expect(parsed).to.deep.equal([{ providerId: 'http_get', prompt: 'p', expectedPattern: 'x' }]);
        expect(sc.parseCorpus('not json')).to.deep.equal([]);
        expect(sc.parseCorpus(null)).to.deep.equal([]);
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('scheduler stays idle when SPOT_CHECK_ENABLED is unset', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: { SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.equal(null);
        await sc.stop();
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('scheduler stays idle when enabled but no injector is wired', async function () {
        const hub = makeHub({ p2pConfig: { SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.equal(null);
        await sc.stop();
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('scheduler stays idle when enabled with an injector but an empty corpus', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: { SPOT_CHECK_ENABLED: 'true' } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.equal(null);
        await sc.stop();
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('starts a scheduler interval when enabled + injector + corpus, and stop() clears it', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_INTERVAL_MS: '999999', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.start();
        expect(sc._scheduler).to.not.equal(null);
        await sc.stop();
        expect(sc._scheduler).to.equal(null);
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('schedulerTick injects via the injector and registers the returned request_id', async function () {
        const injector = sinon.stub()
            .onFirstCall().resolves({ requestId: 'SYNTH1' })
            .onSecondCall().resolves('SYNTH2');   // bare-string return also accepted
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_MAX_PER_TICK: '2', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        const n = await sc.schedulerTick();
        expect(n).to.equal(2);
        expect(injector.callCount).to.equal(2);
        expect(sc.isSpotCheck('SYNTH1')).to.be.true;
        expect(sc.isSpotCheck('SYNTH2')).to.be.true;
        // Corpus round-robins: first entry is http_get, second is llm.
        expect(injector.firstCall.args[0].providerId).to.equal('http_get');
        expect(injector.secondCall.args[0].providerId).to.equal('llm');
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('round-robins the corpus cursor across ticks', async function () {
        const injector = sinon.stub().callsFake(() => Promise.resolve({ requestId: 'rid' + Math.random() }));
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });  // maxPerTick default 1
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        await sc.schedulerTick();
        await sc.schedulerTick();
        await sc.schedulerTick();
        expect(injector.getCall(0).args[0].prompt).to.equal('q1');
        expect(injector.getCall(1).args[0].prompt).to.equal('q2');
        expect(injector.getCall(2).args[0].prompt).to.equal('q1');  // wrapped
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('a throwing injector does not abort the batch or throw out of the tick', async function () {
        const injector = sinon.stub()
            .onFirstCall().rejects(new Error('encoder down'))
            .onSecondCall().resolves({ requestId: 'OK2' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_MAX_PER_TICK: '2', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        const n = await sc.schedulerTick();     // must not throw
        expect(n).to.equal(1);
        expect(sc.isSpotCheck('OK2')).to.be.true;
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('does not register when the injector returns no request_id', async function () {
        const injector = sinon.stub().resolves({ notARequestId: true });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        const n = await sc.schedulerTick();
        expect(n).to.equal(0);
        expect(sc.queueSize()).to.equal(0);
    }); });

describe('AttestationSpotChecker: injection scheduler', function () { afterEach(hookAt33644); it('skips the tick under queue backpressure (near capacity)', async function () {
        const injector = sinon.stub().resolves({ requestId: 'z' });
        const hub = makeHub({ spotCheckInjector: injector, p2pConfig: {
            SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS) } });
        const sc  = new AttestationSpotChecker(hub, makeProviderRegistry());
        for (let i = 0; i < 1000; i++) sc.register('q' + i, 'http_get', 'e');  // >= 90% of 1024
        const n = await sc.schedulerTick();
        expect(n).to.equal(0);
        expect(injector.called).to.be.false;
    }); });
}
