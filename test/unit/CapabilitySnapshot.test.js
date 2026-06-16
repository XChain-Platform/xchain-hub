'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

describe('CapabilitySnapshot', function () {

    let axiosStub, CapabilitySnapshot;

    beforeEach(function () {
        axiosStub = { post: sinon.stub() };
        CapabilitySnapshot = proxyquire('../../src/CapabilitySnapshot', { axios: axiosStub });
    });

    afterEach(function () {
        sinon.restore();
    });

    // Fake hub: resolves an indexer URL and (optionally) exposes a registry that
    // serves the authoritative MIN_STAKE for a capability.
    function makeHub(registry) {
        return {
            capabilityRegistry: registry,
            _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
            // getSnapshot attaches indexer auth headers to the RPC call; the real
            // hub builds these from BTC_INDEXER_API_KEY. Tests don't care about the
            // header value, only that the call is made — return an empty object.
            _btcIndexerHeaders: () => ({})
        };
    }

    function okResult() {
        return { data: { result: { capability: 'attestation', block_index: 100, count: 1, validators: [{ pubkey: 'ab', amount: '50000' }] } } };
    }

    describe('getSnapshot()', function () {

        it('passes the hub registry MIN_STAKE as min_stake in the RPC payload', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 100);

            expect(axiosStub.post.calledOnce).to.equal(true);
            let body = axiosStub.post.firstCall.args[1];
            expect(body.method).to.equal('getcapabilityvalidators');
            expect(body.params.capability).to.equal('attestation');
            expect(body.params.block_index).to.equal(100);
            // The whole point of the fix: the hub's threshold rides along so the
            // indexer's local config can't be the divergence point.
            expect(body.params.min_stake).to.equal('25000');
            expect(registry.getMinStake.calledWith('attestation')).to.equal(true);
        });

        it('coerces a numeric MIN_STAKE to a string', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(25000) };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 100);

            expect(axiosStub.post.firstCall.args[1].params.min_stake).to.equal('25000');
        });

        it('omits min_stake when the registry is not ready (pre-startCapabilities)', async function () {
            axiosStub.post.resolves(okResult());
            let snap = new CapabilitySnapshot(makeHub(null));

            await snap.getSnapshot('attestation', 100);

            let body = axiosStub.post.firstCall.args[1];
            expect(Object.prototype.hasOwnProperty.call(body.params, 'min_stake')).to.equal(false);
        });

        it('omits min_stake when the registry has no threshold for the capability', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(null) };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 100);

            let body = axiosStub.post.firstCall.args[1];
            expect(Object.prototype.hasOwnProperty.call(body.params, 'min_stake')).to.equal(false);
        });
    });

    // Finding #4136/#4220: a 401 (hub BTC_INDEXER_API_KEY != indexer
    // INDEXER_API_KEY) must NOT be swallowed as an anonymous null snapshot — that
    // makes an auth misconfig indistinguishable from a dead indexer and silently
    // collapses every attestation + config-change quorum.
    describe('indexer auth failure (401/403)', function () {

        function err401(status) {
            let e = new Error('Request failed with status code ' + status);
            e.response = { status: status };
            return e;
        }

        it('returns null AND logs a distinct auth warning on a 401', async function () {
            axiosStub.post.rejects(err401(401));
            let spy = sinon.spy(console, 'error');
            let snap = new CapabilitySnapshot(makeHub(null));

            let result = await snap.getSnapshot('attestation', 100);

            expect(result).to.equal(null);
            expect(spy.calledOnce).to.equal(true);
            let msg = spy.firstCall.args[0];
            expect(msg).to.contain('BTC_INDEXER_API_KEY');
            expect(msg).to.contain('INDEXER_API_KEY');
            expect(msg).to.contain('401');
        });

        it('throttles repeated auth warnings (one per cache TTL window)', async function () {
            axiosStub.post.rejects(err401(401));
            let spy = sinon.spy(console, 'error');
            let snap = new CapabilitySnapshot(makeHub(null));

            // Distinct keys/methods so the 60s snapshot cache never short-circuits the call.
            await snap.getSnapshot('attestation', 100);
            await snap.getWeightSnapshot('attestation', 101);
            await snap.getActiveValidatorSnapshot(102);

            expect(spy.callCount).to.equal(1);                 // throttled to one inside the TTL window
        });

        it('does NOT log for a transport error (no HTTP status)', async function () {
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            let spy = sinon.spy(console, 'error');
            let snap = new CapabilitySnapshot(makeHub(null));

            let result = await snap.getSnapshot('attestation', 100);

            expect(result).to.equal(null);                     // still falls back
            expect(spy.called).to.equal(false);                // but not flagged as auth
        });
    });
});
