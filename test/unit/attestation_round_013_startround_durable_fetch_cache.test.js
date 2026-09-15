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

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const EventEmitter   = require('events');
// The flag day the silent-slot leader skip rides. Read rather than re-spelled, so
// a height change moves the cases with it instead of leaving them asserting a
// literal the code no longer uses.
const lssMod         = require('../../src/attest_leader_silence_skip_activation.js');
const { DB_METHODS } = require('../helpers/mockHub.js');

const LICENSE_HEADER = ''; // Only needed for file comment; tests use it below

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeIdentity(pubkey) {
    return { getPubkeyHex: () => pubkey || 'aa'.repeat(32) };
}

function makePeerManager() {
    let pm = new EventEmitter();
    pm.broadcast  = sinon.stub();
    pm.sendToPeer = sinon.stub();
    return pm;
}

function makeHub(overrides) {
    let pm = makePeerManager();
    let hub = {
        db:               { ...DB_METHODS, doQuery: sinon.stub().resolves([]) },
        p2pConfig:        overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getPeerManager:   () => pm,
        getIdentity:      () => makeIdentity(),
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        _resolveBtcIndexerUrl: overrides && overrides._resolveBtcIndexerUrl
            ? overrides._resolveBtcIndexerUrl
            : sinon.stub().resolves(null),
        btcIndexerHeaders: () => ({})
    };
    hub._peerManager = pm;
    return hub;
}

function makeProviderRegistry(overrides) {
    return {
        isKnown:   sinon.stub().returns(true),
        getModule: sinon.stub().returns({ fetch: sinon.stub().resolves({ body: 'data', meta: '200' }) }),
        getDef:    sinon.stub().returns({ max_response_bytes: 32768 }),
        getAdditionalConfig: sinon.stub().returns({ approved_models: ['claude-sonnet-4-6'], judge_model: 'claude-haiku-4-5' }),
        // Block-anchored provider stake floor. '0' keeps the pre-existing
        // fixtures (whose snapshots carry no weight) selecting exactly as before on the
        // unweighted path, which is the only path they exercise.
        getMinStake: sinon.stub().returns('0'),
        // Block-anchored PBFT strategy, resolved once at the request's block and pinned
        // onto roundState. byte_equality keeps the existing fixtures on the path they
        // already exercised; the anchoring itself is covered in ProviderRegistry.test.js
        // and the fail-closed branch below.
        getConsensusStrategy: sinon.stub().returns('byte_equality'),
        ...(overrides || {})
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Load AttestationRound (stub axios)
// ────────────────────────────────────────────────────────────────────────────

let axiosStub;
let AttestationRound;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    AttestationRound = proxyquire('../../src/attestation/round', { axios: axiosStub });
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

{
const hookAt3853 = function () {
        loadModule();
    };

const hookAt3913 = function () {
        sinon.restore();
    };

const MY_PUBKEY = 'aa'.repeat(32);

function makeRequest(overrides) {
            return {
                request_id:   'rid0001',
                provider_id:  'http_get',
                redundancy:   1,
                block_index:  100,
                action_index: 1,
                payload:      'https://example.com/',
                ...overrides
            };
        }

// doQuery that answers the cache SELECT with `row` (null => cache miss)
        // and records every statement for assertion.
        function makeCacheDb(row) {
            return sinon.stub().callsFake(async (q) => {
                if (/SELECT status, body, meta FROM attestation_fetch_cache/.test(q)) {
                    return row ? [row] : [];
                }
                return [];
            });
        }

function makeRound(fetchStub, row) {
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: MY_PUBKEY }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(MY_PUBKEY);
            hub.db = { ...DB_METHODS, doQuery: makeCacheDb(row) };
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
            ar.setConsensus({ propose: sinon.stub().resolves() });
            return { ar, hub };
        }

// ── durable fetch cache ──────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() durable fetch cache', function () { it('records the completed fetch so a restart has something to reuse', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);

            await ar._startRound(makeRequest());

            expect(fetchStub.calledOnce, 'a cache miss still fetches').to.be.true;
            let insert = hub.db.doQuery.getCalls()
                .find(c => /INSERT INTO attestation_fetch_cache/.test(c.args[0]));
            expect(insert, 'the outcome is upserted').to.not.equal(undefined);
            expect(insert.args[1][0]).to.equal('rid0001');
            expect(insert.args[1][2]).to.equal('ok');
            expect(Buffer.isBuffer(insert.args[1][3])).to.be.true;
            expect(insert.args[1][3].toString()).to.equal('ok');
            // The write follows the fetch: a claim recorded BEFORE the call would
            // let a crash mid-fetch skip a round this hub never finished.
            expect(insert.calledAfter(fetchStub.firstCall)).to.be.true;
        }); }); });

// ── durable fetch cache ──────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() durable fetch cache', function () { it('reuses a recorded fetch instead of paying the provider again', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('fresh'), meta: '200' });
            let { ar } = makeRound(fetchStub, { status: 'ok', body: Buffer.from('recorded'), meta: '200' });

            await ar._startRound(makeRequest());

            expect(fetchStub.called, 'the billed provider must not be called again').to.be.false;
            let state = ar.rounds.get('rid0001');
            expect(state.myProposal.status).to.equal('ok');
            // Byte-identical to the pre-restart proposal, so the hub cannot sign a
            // second, different body under the same request id.
            expect(state.myProposal.body.toString()).to.equal('recorded');
            expect(state.myProposal.meta).to.equal('200');
        }); }); });

// ── durable fetch cache ──────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() durable fetch cache', function () { it('reuses a recorded provider_error rather than re-deciding the round', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('fresh'), meta: '200' });
            let { ar } = makeRound(fetchStub, { status: 'provider_error', body: null, meta: null });

            await ar._startRound(makeRequest());

            expect(fetchStub.called).to.be.false;
            let state = ar.rounds.get('rid0001');
            expect(state.error).to.equal('provider_error');
            expect(state.myProposal.body.length).to.equal(0);
        }); }); });

// ── durable fetch cache ──────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() durable fetch cache', function () { it('reads only inside the retry window, so a lapsed round re-fetches', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);

            let before = Math.floor((Date.now() - ar.retryAfterMs) / 1000);
            await ar._startRound(makeRequest());

            let select = hub.db.doQuery.getCalls()
                .find(c => /SELECT status, body, meta FROM attestation_fetch_cache/.test(c.args[0]));
            expect(select.args[0]).to.contain('created_at >= FROM_UNIXTIME(?)');
            expect(select.args[1][1]).to.be.at.least(before);
        }); }); });

// ── durable fetch cache ──────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() durable fetch cache', function () { it('fails OPEN: an unreachable cache re-fetches rather than dropping the round', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);
            hub.db.doQuery = sinon.stub().rejects(new Error('db down'));

            await ar._startRound(makeRequest());

            expect(fetchStub.calledOnce).to.be.true;
            expect(ar.rounds.size).to.equal(1);
        }); }); });

// ── durable fetch cache ──────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() durable fetch cache', function () { it('evicts lapsed rows on the seen-window schedule', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);
            hub._resolveBtcIndexerUrl = sinon.stub().resolves('http://idx/rpc');
            axiosStub.post.resolves({ data: { result: { latest_block_index: 200, requests: [] } } });

            await ar.pollPending();

            let ran = hub.db.doQuery.getCalls().map(c => c.args[0]);
            expect(ran.some(q => /DELETE FROM attestation_fetch_cache/.test(q))).to.be.true;
        }); }); });
}
