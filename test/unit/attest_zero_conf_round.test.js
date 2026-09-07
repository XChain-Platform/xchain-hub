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
//
// The zero-confirmation flip as AttestationRound sees it (spec §3): the
// effective confirmation count, the poll gate it opens, the round-start line the
// acceptance drill greps, the fetch counters, and the boot ordering assertion.
// Regtest is armed at height 0 and mainnet carries the null sentinel, so the two
// networks give the above-height and below-height behaviour without a fixture.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const EventEmitter = require('events');

const zcMod = require('../../src/attest_zero_conf_activation.js');

const MY_PUBKEY = 'aa'.repeat(32);

function makeIdentity(pubkey) {
    return { getPubkeyHex: () => pubkey || MY_PUBKEY };
}

function makePeerManager() {
    let pm = new EventEmitter();
    pm.broadcast  = sinon.stub();
    pm.sendToPeer = sinon.stub();
    return pm;
}

// The AttestationRound.test.js stub shape, plus `network`, which is the input the
// whole flag day keys on and which that file's hub deliberately leaves unset.
function makeHub(overrides) {
    let o   = overrides || {};
    let pm  = makePeerManager();
    let hub = {
        db:                 o.db !== undefined ? o.db : { doQuery: sinon.stub().resolves([]) },
        p2pConfig:          o.p2pConfig || {},
        network:            o.network,
        getPeerManager:     () => pm,
        getIdentity:        () => makeIdentity(o.pubkey),
        capabilitySnapshot: o.capabilitySnapshot !== undefined ? o.capabilitySnapshot : null,
        _resolveBtcIndexerUrl: o._resolveBtcIndexerUrl || sinon.stub().resolves(null),
        _btcIndexerHeaders: () => ({})
    };
    hub._peerManager = pm;
    return hub;
}

function makeProviderRegistry(overrides) {
    return Object.assign({
        isKnown:   sinon.stub().returns(true),
        getModule: sinon.stub().returns({ fetch: sinon.stub().resolves({ body: Buffer.from('payload'), meta: '200' }) }),
        getDef:    sinon.stub().returns({ max_response_bytes: 32768 }),
        getAdditionalConfig:  sinon.stub().returns({ approved_models: ['claude-sonnet-4-6'], judge_model: 'claude-haiku-4-5' }),
        getMinStake:          sinon.stub().returns('0'),
        getConsensusStrategy: sinon.stub().returns('byte_equality')
    }, overrides || {});
}

let axiosStub;
let AttestationRound;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    AttestationRound = proxyquire('../../src/AttestationRound', { axios: axiosStub });
}

describe('AttestationRound zero-confirmation flip', function () {

    beforeEach(function () {
        loadModule();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── confirmationsFor ────────────────────────────────────────────────────

    describe('confirmationsFor()', function () {

        it('is 0 on regtest, which is armed at genesis', function () {
            let ar = new AttestationRound(makeHub({ network: 'regtest' }), makeProviderRegistry());
            expect(ar.confirmations, 'the tunable itself is untouched').to.equal(3);
            expect(ar.confirmationsFor(0)).to.equal(0);
            expect(ar.confirmationsFor(500)).to.equal(0);
        });

        it('is the operator tunable on mainnet, where the map holds the null sentinel', function () {
            expect(zcMod.ATTEST_ZERO_CONF_ACTIVATION.mainnet, 'guard: mainnet must still be unratified').to.equal(null);
            let ar = new AttestationRound(makeHub({ network: 'mainnet' }), makeProviderRegistry());
            expect(ar.confirmationsFor(0)).to.equal(3);
            expect(ar.confirmationsFor(999999999)).to.equal(3);
        });

        it('carries the operator tunable below the height rather than a hard-coded 3', function () {
            let ar = new AttestationRound(
                makeHub({ network: 'mainnet', p2pConfig: { ATTESTATION_CONFIRMATIONS: '6' } }),
                makeProviderRegistry());
            expect(ar.confirmationsFor(500)).to.equal(6);
        });

        it('flips exactly at the activation height and not one block below it', function () {
            // Drive the boundary on a network whose height is not 0, so "above" and
            // "below" are both reachable. testnet is unratified today, so the map is
            // moved for the duration of this test and restored.
            let saved = zcMod.ATTEST_ZERO_CONF_ACTIVATION.testnet;
            zcMod.ATTEST_ZERO_CONF_ACTIVATION.testnet = 151324;
            try {
                let ar = new AttestationRound(makeHub({ network: 'testnet' }), makeProviderRegistry());
                expect(ar.confirmationsFor(151323), 'one block below').to.equal(3);
                expect(ar.confirmationsFor(151324), 'at the height').to.equal(0);
                expect(ar.confirmationsFor(151325), 'one block above').to.equal(0);
            } finally {
                zcMod.ATTEST_ZERO_CONF_ACTIVATION.testnet = saved;
            }
        });
    });

    // ── the poll gate ───────────────────────────────────────────────────────

    describe('the poll gate reads confirmationsFor, not this.confirmations', function () {

        function pollWith(network, latestBlock, blockIndex) {
            axiosStub.post.resolves({
                data: { result: { latest_block_index: latestBlock, requests: [
                    { request_id: 'bb'.repeat(32), block_index: blockIndex, action_index: 1 }
                ] } }
            });
            let hub = makeHub({ network: network, _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let spy = sinon.stub(ar, '_startRound').resolves();
            return ar._pollPending().then(() => spy);
        }

        it('admits a regtest request in the very block it was mined in', async function () {
            let spy = await pollWith('regtest', 500, 500);
            expect(spy.calledOnce, 'tip == block_index must start the round').to.be.true;
            expect(spy.firstCall.args[1], 'the tip is handed to the round').to.equal(500);
        });

        it('holds a mainnet request until the tip reaches block_index + 3', async function () {
            expect((await pollWith('mainnet', 500, 500)).called, 'at the request block').to.be.false;
            expect((await pollWith('mainnet', 502, 500)).called, 'two blocks in').to.be.false;
            expect((await pollWith('mainnet', 503, 500)).calledOnce, 'three blocks in').to.be.true;
        });
    });

    // ── the round-start line ────────────────────────────────────────────────

    describe('the round-start line (spec §10 ZC1)', function () {

        function makeRegtestRound(reqOverrides) {
            let validators = [{ pubkey: MY_PUBKEY, weight: '100000', source: 'src1' }];
            let capSS = {
                getSnapshot:       sinon.stub().resolves({ validators: validators }),
                getWeightSnapshot: sinon.stub().resolves({ validators: validators })
            };
            let hub = makeHub({ network: 'regtest', capabilitySnapshot: capSS });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
            let request = Object.assign({
                request_id:     'cd'.repeat(32),
                provider_id:    'http_get',
                redundancy:     1,
                block_index:    500,
                action_index:   1,
                deadline_block: 510,
                payload:        'https://example.com/'
            }, reqOverrides || {});
            return { ar: ar, request: request };
        }

        it('reports the tip, the effective count and the widen the drill greps for', async function () {
            let { ar, request } = makeRegtestRound();
            let logs = [];
            sinon.stub(console, 'log').callsFake(l => logs.push(String(l)));
            await ar._startRound(request, 500);
            sinon.restore();
            let starting = logs.filter(l => l.indexOf('AttestationRound: starting ') === 0);
            expect(starting.length, 'exactly one start line per started round').to.equal(1);
            expect(starting[0]).to.equal(
                'AttestationRound: starting ' + 'cd'.repeat(32).substring(0, 16) +
                '... tip=500 conf=0 widen=1');
            // The literal ZC1 greps for, spelled out so a reworded line reds here.
            expect(starting[0]).to.contain('tip=500 conf=0 widen=1');
        });

        it('is silent on a hub that is not in the responsible set', async function () {
            let { ar, request } = makeRegtestRound();
            ar._computeResponsibleSet.returns([{ pubkey: 'ff'.repeat(32), hash: '00' }]);
            let logs = [];
            sinon.stub(console, 'log').callsFake(l => logs.push(String(l)));
            sinon.stub(console, 'warn');
            await ar._startRound(request, 500);
            sinon.restore();
            expect(logs.filter(l => l.indexOf('AttestationRound: starting ') === 0)).to.have.length(0);
        });
    });

    // ── fetch accounting ────────────────────────────────────────────────────

    describe('getStats fetch accounting', function () {

        function makeRegtestRound(dbRows) {
            let validators = [{ pubkey: MY_PUBKEY, weight: '100000', source: 'src1' }];
            let capSS = {
                getSnapshot:       sinon.stub().resolves({ validators: validators }),
                getWeightSnapshot: sinon.stub().resolves({ validators: validators })
            };
            let hub = makeHub({
                network: 'regtest',
                capabilitySnapshot: capSS,
                db: { doQuery: sinon.stub().resolves(dbRows || []) }
            });
            let reg = makeProviderRegistry();
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
            return { ar: ar, reg: reg, request: {
                request_id: 'ef'.repeat(32), provider_id: 'http_get', redundancy: 1,
                block_index: 500, action_index: 1, deadline_block: 510,
                payload: 'https://example.com/'
            } };
        }

        it('starts both counters at zero and exposes them', function () {
            let ar = new AttestationRound(makeHub({ network: 'regtest' }), makeProviderRegistry());
            let stats = ar.getStats();
            expect(stats).to.have.property('fetch_count', 0);
            expect(stats).to.have.property('fetch_cache_hit_count', 0);
        });

        it('counts a provider call the hub actually issued', async function () {
            let { ar, reg, request } = makeRegtestRound([]);
            sinon.stub(console, 'log');
            await ar._startRound(request, 500);
            sinon.restore();
            expect(reg.getModule().fetch.called, 'guard: the provider was called').to.be.true;
            expect(ar.getStats().fetch_count).to.equal(1);
            expect(ar.getStats().fetch_cache_hit_count).to.equal(0);
        });

        it('counts a durable-cache reuse instead, and issues no provider call', async function () {
            let { ar, reg, request } = makeRegtestRound([{ status: 'ok', body: Buffer.from('cached'), meta: '200' }]);
            let fetchStub = reg.getModule().fetch;
            fetchStub.resetHistory();
            sinon.stub(console, 'log');
            await ar._startRound(request, 500);
            sinon.restore();
            expect(fetchStub.called, 'a cache hit must not pay the provider').to.be.false;
            expect(ar.getStats().fetch_count).to.equal(0);
            expect(ar.getStats().fetch_cache_hit_count).to.equal(1);
        });
    });

    // ── the boot ordering assertion ─────────────────────────────────────────

    describe('the boot ordering assertion (spec §3.2 a)', function () {

        it('throws on a consensus network whose zero-conf height sits below the mirror and widening heights', function () {
            let saved = zcMod.ATTEST_ZERO_CONF_ACTIVATION.testnet;
            zcMod.ATTEST_ZERO_CONF_ACTIVATION.testnet = 1000;   // below both testnet heights
            try {
                let build = () => new AttestationRound(makeHub({ network: 'testnet' }), makeProviderRegistry());
                expect(build).to.throw(/ATTEST zero-conf/);
                try { build(); } catch (e) { expect(e.code).to.equal('ZERO_CONF_ORDERING'); }
            } finally {
                zcMod.ATTEST_ZERO_CONF_ACTIVATION.testnet = saved;
            }
        });

        it('warns instead of throwing on a non-consensus network', function () {
            let saved = zcMod.ATTEST_ZERO_CONF_ACTIVATION.regtest;
            zcMod.ATTEST_ZERO_CONF_ACTIVATION.regtest = -1;     // below regtest's mirror/widening 0
            let warn = sinon.stub(console, 'warn');
            try {
                new AttestationRound(makeHub({ network: 'regtest' }), makeProviderRegistry());
            } finally {
                zcMod.ATTEST_ZERO_CONF_ACTIVATION.regtest = saved;
                sinon.restore();
            }
            let lines = warn.getCalls().map(c => String(c.args[0]));
            expect(lines.some(l => l.indexOf('ordering violation') !== -1),
                'the regtest violation is reported, not raised').to.be.true;
        });

        it('is silent on a correctly ordered network and on a hub with no network', function () {
            let warn = sinon.stub(console, 'warn');
            new AttestationRound(makeHub({ network: 'regtest' }), makeProviderRegistry());
            new AttestationRound(makeHub({}), makeProviderRegistry());
            sinon.restore();
            let lines = warn.getCalls().map(c => String(c.args[0]));
            expect(lines.filter(l => l.indexOf('zero-conf') !== -1)).to.have.length(0);
        });
    });

    // ── the poll cadence default ────────────────────────────────────────────

    it('polls at 3 s by default, which is the floor on how long a request waits', function () {
        let ar = new AttestationRound(makeHub({ network: 'regtest' }), makeProviderRegistry());
        expect(ar.pollMs).to.equal(3000);
        // The seen window must still clear the consensus round timeout: the
        // Math.max floor binds at this cadence, so it is 120000 + 3000.
        expect(ar.retryAfterMs).to.equal(123000);
        expect(ar.retryAfterMs).to.be.above(120000);
    });
});
