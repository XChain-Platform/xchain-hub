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

    describe('getQuorum()', function () {

        it('coerces a STRING count instead of string-concatenating it (DoS guard)', function () {
            // Regression: `Math.ceil((N + 1) / 2)` with N a string "5" concatenates
            // ("5" + 1 -> "51"), exploding quorum to 26-of-5 -> permanent halt. A
            // string count must coerce identically to the numeric one.
            let snap = new CapabilitySnapshot(makeHub(null));
            let numeric = snap.getQuorum({ count: 5, validators: [] });
            let asString = snap.getQuorum({ count: '5', validators: [] });
            expect(asString).to.equal(numeric);
            expect(asString).to.equal(3); // max(2*floor(4/3)+1, ceil(6/2)) = max(3,3)
        });

        it('falls back to the membership-set size when count is non-numeric (no single-node bypass)', function () {
            // A malformed/absent count must NOT silently drop quorum to 0 (which
            // would bypass consensus). Derive N from the actual validator set.
            let snap = new CapabilitySnapshot(makeHub(null));
            let validators = [1,2,3,4].map(i => ({ pubkey: 'k' + i }));
            expect(snap.getQuorum({ count: 'garbage', validators })).to.equal(3);
        });
    });

    describe('getSnapshot()', function () {

        it('passes the hub registry MIN_STAKE as min_stake in the RPC payload', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 106);

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

        it('rejects a snapshot whose echoed block_index differs from the request (freshness guard)', async function () {
            // The indexer fail-closes on an un-indexed block and echoes the requested
            // block on success, so a mismatch means it answered for a different height.
            // Locking that snapshot would let two hubs use different validator sets for
            // the same round, so it must be refused (null) rather than cached.
            axiosStub.post.resolves({ data: { result: {
                capability: 'attestation', block_index: 99, count: 1,
                validators: [{ pubkey: 'ab', amount: '50000' }]
            } } });
            sinon.stub(console, 'error');
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            let result = await snap.getSnapshot('attestation', 106);
            expect(result).to.equal(null);
        });

        it('coerces a numeric MIN_STAKE to a string', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(25000) };
            let snap = new CapabilitySnapshot(makeHub(registry));

            await snap.getSnapshot('attestation', 106);

            expect(axiosStub.post.firstCall.args[1].params.min_stake).to.equal('25000');
        });

        it('omits min_stake when the registry is not ready (pre-startCapabilities)', async function () {
            axiosStub.post.resolves(okResult());
            let snap = new CapabilitySnapshot(makeHub(null));

            await snap.getSnapshot('attestation', 106);

            let body = axiosStub.post.firstCall.args[1];
            expect(Object.prototype.hasOwnProperty.call(body.params, 'min_stake')).to.equal(false);
        });

        it('fails CLOSED when a LIVE registry has no threshold for the capability (#S-F3 fork guard)', async function () {
            // A wired registry that resolves NO threshold means the capability was
            // never put in HUB_CAPABILITY_CONFIG. Omitting min_stake would let each
            // indexer apply its own local threshold and fork the qualifying set, so
            // the snapshot must be refused (null) and the indexer never queried.
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(null) };
            let snap = new CapabilitySnapshot(makeHub(registry));
            let errStub = sinon.stub(console, 'error');

            let result = await snap.getSnapshot('attestation', 106);

            expect(result).to.equal(null);
            expect(axiosStub.post.called).to.equal(false);
            expect(errStub.calledWithMatch(/NO configured MIN_STAKE/)).to.equal(true);
        });

        it('fails CLOSED in getWeightSnapshot too when a live registry has no threshold', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(null) };
            let snap = new CapabilitySnapshot(makeHub(registry));
            sinon.stub(console, 'error');

            let result = await snap.getWeightSnapshot('attestation', 106);

            expect(result).to.equal(null);
            expect(axiosStub.post.called).to.equal(false);
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

            let first = await snap.getSnapshot('attestation', 106);
            expect(first.validators[0].pubkey).to.equal('old');

            // Governance raises the threshold; the cache key now differs, so the
            // stale entry is unreachable and a fresh indexer query runs.
            threshold = '50000';
            let second = await snap.getSnapshot('attestation', 106);

            expect(axiosStub.post.calledTwice).to.equal(true);
            expect(second.validators[0].pubkey).to.equal('new');
        });

        it('flushCapability drops both count- and weight-keyed entries, forcing a re-fetch', async function () {
            let registry = { getMinStake: () => '25000' };
            let snap = new CapabilitySnapshot(makeHub(registry));

            axiosStub.post.resolves(resultWith([{ pubkey: 'old', amount: '30000' }]));
            await snap.getSnapshot('attestation', 106);
            await snap.getWeightSnapshot('attestation', 106);
            // A different capability's entry must survive the flush.
            await snap.getSnapshot('price', 106);
            expect(snap.cache.size).to.equal(3);

            let removed = snap.flushCapability('attestation');
            expect(removed).to.equal(2);
            expect(snap.cache.size).to.equal(1);

            // Next read for the flushed capability hits the indexer again, not cache.
            axiosStub.post.resetHistory();
            await snap.getSnapshot('attestation', 106);
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
            let before = await snap.getSnapshot('attestation', 106);
            expect(before.validators[0].pubkey).to.equal('old');

            // (b) governance MIN_STAKE change lands: registry updates, hub flushes
            //     (mirrors XChainHub._applyCapabilityGovernanceChange on the event).
            threshold = '50000';
            snap.flushCapability('attestation');

            // (c) the next read reflects the new validator set
            let after = await snap.getSnapshot('attestation', 106);
            expect(after.validators[0].pubkey).to.equal('new');
        });
    });

    // -----------------------------------------------------------------
    // L4 determinism: capability validator set (spec §6 / validator-test-spec)
    //
    // The validator-specific risk is quiet divergence: two hubs resolving the
    // SAME (capability, block_index) with the SAME governed MIN_STAKE must lock
    // the SAME qualified validator set (members AND order) and derive the SAME
    // quorum N, or their PBFT rounds fork. getcapabilityvalidators is the
    // federation source of truth for that set; these pin the contract across two
    // independently-constructed CapabilitySnapshot instances (the capability-set
    // half of spec §6 "Determinism (L4)" item 1).
    // -----------------------------------------------------------------
    describe('L4 determinism: capability validator set', function () {

        // A fixed, ordered qualified set. Both hubs query the same deterministic
        // indexer, modelling identical on-chain stake state at the block boundary.
        const QUALIFIED = [
            { pubkey: 'aa', amount: '90000' },
            { pubkey: 'bb', amount: '60000' },
            { pubkey: 'cc', amount: '30000' }
        ];

        function deterministicIndexer() {
            // Echoes the requested (buried) block and returns the same ordered set
            // on every call, with FRESH copies so matching output proves content
            // determinism, not a shared object reference.
            axiosStub.post.callsFake(async (url, body) => ({
                data: { result: {
                    capability:  body.params.capability,
                    block_index: body.params.block_index,
                    count:       QUALIFIED.length,
                    validators:  QUALIFIED.map(v => ({ ...v }))
                } }
            }));
        }

        it('two independent hubs at the same block lock an identical qualified set and quorum N', async function () {
            deterministicIndexer();
            const registry = { getMinStake: () => '25000' };
            const a = new CapabilitySnapshot(makeHub(registry));
            const b = new CapabilitySnapshot(makeHub(registry));

            const sa = await a.getSnapshot('attestation', 200);
            const sb = await b.getSnapshot('attestation', 200);

            expect(sa.validators).to.deep.equal(sb.validators);   // same members AND order
            expect(sa.blockIndex).to.equal(sb.blockIndex);        // same buried height
            expect(a.getQuorum(sa)).to.equal(b.getQuorum(sb));    // same 2f+1
            expect(a.getQuorum(sa)).to.equal(2);                  // N=3: max(2*floor(2/3)+1, ceil(4/2)) = max(1,2)
        });

        it('quorum N over the locked set is order-independent (depends only on |set|)', async function () {
            deterministicIndexer();
            const registry = { getMinStake: () => '25000' };
            const snap = new CapabilitySnapshot(makeHub(registry));
            const s = await snap.getSnapshot('attestation', 200);
            // Reversing the very same members must not change N: quorum is a
            // function of the set SIZE, so a divergent order can never fork N.
            const reversed = Object.assign({}, s, { validators: s.validators.slice().reverse() });
            expect(snap.getQuorum(reversed)).to.equal(snap.getQuorum(s));
        });

        it('the qualified set is driven by the hub-governed MIN_STAKE, not the indexer local config', async function () {
            deterministicIndexer();
            // Two hubs whose registries resolve the SAME governed threshold send the
            // SAME min_stake param, so the indexer can never be the divergence point.
            const a = new CapabilitySnapshot(makeHub({ getMinStake: () => '25000' }));
            const b = new CapabilitySnapshot(makeHub({ getMinStake: () => '25000' }));
            await a.getSnapshot('attestation', 200);
            await b.getSnapshot('attestation', 200);
            expect(axiosStub.post.getCall(0).args[1].params.min_stake)
                .to.equal(axiosStub.post.getCall(1).args[1].params.min_stake);
            expect(axiosStub.post.getCall(0).args[1].params.min_stake).to.equal('25000');
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

            let result = await snap.getSnapshot('attestation', 106);

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
            await snap.getSnapshot('attestation', 106);
            await snap.getWeightSnapshot('attestation', 101);
            await snap.getActiveValidatorSnapshot(102);

            expect(spy.callCount).to.equal(1);                 // throttled to one inside the TTL window
        });

        it('does NOT log for a transport error (no HTTP status)', async function () {
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            let spy = sinon.spy(console, 'error');
            let snap = new CapabilitySnapshot(makeHub(null));

            let result = await snap.getSnapshot('attestation', 106);

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
            { name: 'getSnapshot',                 call: (s) => s.getSnapshot('attestation', 106),    base: { capability: 'attestation', block_index: 100, count: 1 } },
            { name: 'getWeightSnapshot',           call: (s) => s.getWeightSnapshot('attestation', 106), base: { capability: 'attestation', block_index: 100, count: 1, source_count: 1 } },
            { name: 'getActiveValidatorSnapshot',  call: (s) => s.getActiveValidatorSnapshot(106),     base: { block_index: 100, count: 1 } },
            { name: 'getActiveWeightSnapshot',     call: (s) => s.getActiveWeightSnapshot(106),        base: { block_index: 100, count: 1, source_count: 1 } }
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

    // -----------------------------------------------------------------
    // Reorg-depth buffer (#S-F7 / )
    //
    // Callers pass a tip-derived height, but stake state AT tip is not
    // reorg-safe: a shallow reorg can rewrite it while the 60s cache keeps
    // serving the pre-reorg set. Every getter must therefore resolve the
    // snapshot at (requested - buffer), clamped at 0, and label the snapshot
    // with the buried height it truly represents.
    // -----------------------------------------------------------------

    describe('reorg-depth buffer (#S-F7)', function () {

        function echoingIndexer() {
            // Indexer stub that echoes back whatever block was requested, like
            // the real one does on success.
            axiosStub.post.callsFake(async (url, body) => ({
                data: { result: {
                    capability:  body.params.capability || '*',
                    block_index: body.params.block_index,
                    count:       1,
                    validators:  [{ pubkey: 'ab', amount: '50000' }]
                } }
            }));
        }

        afterEach(function () {
            delete process.env.HUB_SNAPSHOT_REORG_BUFFER;
        });

        it('defaults to a 6-block buffer', function () {
            let snap = new CapabilitySnapshot(makeHub(null));
            expect(snap.reorgBufferBlocks).to.equal(6);
        });

        it('resolves getSnapshot at (tip - buffer), not at tip', async function () {
            echoingIndexer();
            let snap = new CapabilitySnapshot(makeHub(null));
            let out = await snap.getSnapshot('attestation', 100);
            expect(axiosStub.post.firstCall.args[1].params.block_index).to.equal(94);
            expect(out.blockIndex).to.equal(94);
        });

        it('applies the buffer on every getter (weight, active, active-weight)', async function () {
            echoingIndexer();
            let snap = new CapabilitySnapshot(makeHub(null));
            await snap.getWeightSnapshot('attestation', 100);
            await snap.getActiveValidatorSnapshot(100);
            await snap.getActiveWeightSnapshot(100);
            for (let call of axiosStub.post.getCalls()) {
                expect(call.args[1].params.block_index).to.equal(94);
            }
        });

        it('clamps the buried height at 0 near genesis', async function () {
            echoingIndexer();
            let snap = new CapabilitySnapshot(makeHub(null));
            await snap.getSnapshot('attestation', 3);
            expect(axiosStub.post.firstCall.args[1].params.block_index).to.equal(0);
        });

        it('honors a HUB_SNAPSHOT_REORG_BUFFER override', async function () {
            process.env.HUB_SNAPSHOT_REORG_BUFFER = '12';
            echoingIndexer();
            let snap = new CapabilitySnapshot(makeHub(null));
            expect(snap.reorgBufferBlocks).to.equal(12);
            await snap.getSnapshot('attestation', 100);
            expect(axiosStub.post.firstCall.args[1].params.block_index).to.equal(88);
        });

        it('allows a 0 buffer (regtest opt-out)', async function () {
            process.env.HUB_SNAPSHOT_REORG_BUFFER = '0';
            echoingIndexer();
            let snap = new CapabilitySnapshot(makeHub(null));
            await snap.getSnapshot('attestation', 100);
            expect(axiosStub.post.firstCall.args[1].params.block_index).to.equal(100);
        });

        it('rejects a malformed override loudly and falls back to the default', function () {
            process.env.HUB_SNAPSHOT_REORG_BUFFER = 'lots';
            let errStub = sinon.stub(console, 'error');
            let snap = new CapabilitySnapshot(makeHub(null));
            expect(snap.reorgBufferBlocks).to.equal(6);
            expect(errStub.calledWithMatch(/HUB_SNAPSHOT_REORG_BUFFER/)).to.equal(true);
        });

        it('rejects a negative override', function () {
            process.env.HUB_SNAPSHOT_REORG_BUFFER = '-3';
            sinon.stub(console, 'error');
            let snap = new CapabilitySnapshot(makeHub(null));
            expect(snap.reorgBufferBlocks).to.equal(6);
        });

        it('still returns null for a null/undefined/non-numeric height', async function () {
            let snap = new CapabilitySnapshot(makeHub(null));
            expect(await snap.getSnapshot('attestation', null)).to.equal(null);
            expect(await snap.getSnapshot('attestation', undefined)).to.equal(null);
            expect(await snap.getSnapshot('attestation', 'tip')).to.equal(null);
            expect(axiosStub.post.called).to.equal(false);
        });

        it('two tip heights burying to the same block share one cache entry', async function () {
            // The cache is keyed on the BURIED height, so distinct tip reads that
            // resolve to the same buried block must not double-fetch.
            echoingIndexer();
            process.env.HUB_SNAPSHOT_REORG_BUFFER = '6';
            let snap = new CapabilitySnapshot(makeHub(null));
            let a = await snap.getSnapshot('attestation', 100.4); // floors to 100 -> 94
            let b = await snap.getSnapshot('attestation', 100);   // -> 94
            expect(axiosStub.post.callCount).to.equal(1);
            expect(a.blockIndex).to.equal(94);
            expect(b.blockIndex).to.equal(94);
        });
    });
});
