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
            // header value, only that the call is made; return an empty object.
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

    // A governance MIN_STAKE change must not be served a snapshot that was cached
    // under the old threshold: the threshold controls which validators qualify, so
    // two hubs caching contradictory sets for the same (capability, blockIndex)
    // would lock different PBFT quorums for the same round. The fix folds the
    // resolved min_stake into the cache key AND flushes the capability's entries
    // when the threshold changes (XChainHub does this on 'proposal:finalized').
    describe('MIN_STAKE change invalidation', function () {

        // okResult with a controllable validator set so old vs new is observable.
        function resultWith(validators) {
            return { data: { result: { capability: 'attestation', block_index: 100, count: validators.length, validators } } };
        }

        it('does NOT serve a snapshot cached under a different min_stake', async function () {
            // Mutable threshold: simulates a governance change between the two reads.
            let threshold = '25000';
            let registry = { getMinStake: () => threshold };
            let snap = new CapabilitySnapshot(makeHub(registry));

            axiosStub.post.onFirstCall().resolves(resultWith([{ pubkey: 'old', amount: '30000' }]));
            axiosStub.post.onSecondCall().resolves(resultWith([{ pubkey: 'new', amount: '60000' }]));

            let first = await snap.getSnapshot('attestation', 100);
            expect(first.validators[0].pubkey).to.equal('old');

            // Governance raises the threshold; the cache key now differs, so the
            // stale entry is unreachable and a fresh indexer query runs.
            threshold = '50000';
            let second = await snap.getSnapshot('attestation', 100);

            expect(axiosStub.post.calledTwice).to.equal(true);
            expect(second.validators[0].pubkey).to.equal('new');
        });

        it('flushCapability drops both count- and weight-keyed entries, forcing a re-fetch', async function () {
            let registry = { getMinStake: () => '25000' };
            let snap = new CapabilitySnapshot(makeHub(registry));

            axiosStub.post.resolves(resultWith([{ pubkey: 'old', amount: '30000' }]));
            await snap.getSnapshot('attestation', 100);
            await snap.getWeightSnapshot('attestation', 100);
            // A different capability's entry must survive the flush.
            await snap.getSnapshot('price', 100);
            expect(snap.cache.size).to.equal(3);

            let removed = snap.flushCapability('attestation');
            expect(removed).to.equal(2);
            expect(snap.cache.size).to.equal(1);

            // Next read for the flushed capability hits the indexer again, not cache.
            axiosStub.post.resetHistory();
            await snap.getSnapshot('attestation', 100);
            expect(axiosStub.post.calledOnce).to.equal(true);
        });

        it('end-to-end: a MIN_STAKE governance change yields the new validator set, not the stale one', async function () {
            // Registry whose threshold is mutated by the governance apply path.
            let threshold = '25000';
            let registry = { getMinStake: () => threshold };
            let snap = new CapabilitySnapshot(makeHub(registry));

            axiosStub.post.onFirstCall().resolves(resultWith([{ pubkey: 'old', amount: '30000' }]));
            axiosStub.post.onSecondCall().resolves(resultWith([{ pubkey: 'new', amount: '60000' }]));

            // (a) prime the cache under the old threshold
            let before = await snap.getSnapshot('attestation', 100);
            expect(before.validators[0].pubkey).to.equal('old');

            // (b) governance MIN_STAKE change lands: registry updates, hub flushes
            //     (mirrors XChainHub._applyCapabilityGovernanceChange on the event).
            threshold = '50000';
            snap.flushCapability('attestation');

            // (c) the next read reflects the new validator set
            let after = await snap.getSnapshot('attestation', 100);
            expect(after.validators[0].pubkey).to.equal('new');
        });
    });

    // Finding #4136/#4220: a 401 (hub BTC_INDEXER_API_KEY != indexer
    // INDEXER_API_KEY) must NOT be swallowed as an anonymous null snapshot; that
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

    // -----------------------------------------------------------------
    // Malformed result → null (FINDING #5334)
    //
    // A bad-shape `validators` field must return null (routing the consensus
    // caller through its fail-closed gate), NOT { validators: [] } which would
    // collapse to quorum=0 and look like single-node. A LEGITIMATE empty or
    // truncated array still yields a real snapshot.
    // -----------------------------------------------------------------

    describe('malformed indexer result (#5334)', function () {

        function dataResult(result) {
            return { data: { result: result } };
        }

        // Each fetch method paired with a base valid result for its RPC.
        let methods = [
            { name: 'getSnapshot',                 call: (s) => s.getSnapshot('attestation', 100),    base: { capability: 'attestation', block_index: 100, count: 1 } },
            { name: 'getWeightSnapshot',           call: (s) => s.getWeightSnapshot('attestation', 100), base: { capability: 'attestation', block_index: 100, count: 1, source_count: 1 } },
            { name: 'getActiveValidatorSnapshot',  call: (s) => s.getActiveValidatorSnapshot(100),     base: { block_index: 100, count: 1 } },
            { name: 'getActiveWeightSnapshot',     call: (s) => s.getActiveWeightSnapshot(100),        base: { block_index: 100, count: 1, source_count: 1 } }
        ];

        // (d) malformed shapes return null on every fetch path.
        let badShapes = [
            { label: 'missing validators field', validators: undefined },
            { label: 'validators is an object',  validators: { 0: { pubkey: 'ab' } } },
            { label: 'validators is a string',   validators: 'ab,cd' },
            { label: 'validators is a number',   validators: 3 }
        ];

        for (let m of methods) {
            for (let bad of badShapes) {
                it(m.name + ' returns null when ' + bad.label, async function () {
                    let result = Object.assign({}, m.base);
                    if (bad.validators === undefined) delete result.validators;
                    else result.validators = bad.validators;
                    axiosStub.post.resolves(dataResult(result));
                    let snap = new CapabilitySnapshot(makeHub(null));
                    expect(await m.call(snap)).to.equal(null);
                });
            }

            it(m.name + ' returns a real snapshot for a VALID validators array', async function () {
                let result = Object.assign({}, m.base, { validators: [{ pubkey: 'ab', amount: '50000' }] });
                axiosStub.post.resolves(dataResult(result));
                let snap = new CapabilitySnapshot(makeHub(null));
                let out = await m.call(snap);
                expect(out).to.not.equal(null);
                expect(out.validators).to.be.an('array').with.lengthOf(1);
            });

            it(m.name + ' keeps a LEGITIMATE empty validators array (not null)', async function () {
                // Empty-after-filter (no qualifying stakers at this block) is a real
                // snapshot the consensus layer treats as valid, not a parse failure.
                let result = Object.assign({}, m.base, { count: 0, validators: [] });
                axiosStub.post.resolves(dataResult(result));
                let snap = new CapabilitySnapshot(makeHub(null));
                let out = await m.call(snap);
                expect(out).to.not.equal(null);
                expect(out.validators).to.be.an('array').with.lengthOf(0);
            });
        }
    });
});
