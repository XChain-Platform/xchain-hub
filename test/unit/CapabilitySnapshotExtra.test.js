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
// Additional unit tests for CapabilitySnapshot that cover the branches
// not exercised by the existing CapabilitySnapshot.test.js:
//   - null / undefined blockIndex guard
//   - cache hit (no re-fetch)
//   - axios error → null
//   - result.error → null
//   - getActiveValidatorSnapshot()
//   - getQuorum()
//   - isInSnapshot()
//   - _prune() (cache eviction)

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

describe('CapabilitySnapshot (extra coverage)', function () {

    let axiosStub, CapabilitySnapshot;

    beforeEach(function () {
        axiosStub = { post: sinon.stub() };
        CapabilitySnapshot = proxyquire('../../src/CapabilitySnapshot', { axios: axiosStub });
    });

    afterEach(function () {
        sinon.restore();
    });

    function makeHub(opts) {
        return {
            capabilityRegistry:    (opts && opts.registry) || null,
            _resolveBtcIndexerUrl: (opts && opts.indexerUrl !== undefined)
                ? async () => opts.indexerUrl
                : async () => 'http://indexer.local/rpc',
            _btcIndexerHeaders:    () => ({})
        };
    }

    function okResult(extras) {
        return {
            data: {
                result: {
                    capability:   'attestation',
                    block_index:  100,
                    count:        2,
                    validators:   [
                        { pubkey: 'aabbcc', amount: '50000' },
                        { pubkey: 'ddeeff', amount: '30000' }
                    ],
                    ...(extras || {})
                }
            }
        };
    }

    // ── getSnapshot() – guard & caching ─────────────────────────────────────

    describe('getSnapshot() – null/undefined blockIndex', function () {
        it('returns null when blockIndex is null', async function () {
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getSnapshot('attestation', null)).to.be.null;
        });

        it('returns null when blockIndex is undefined', async function () {
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getSnapshot('attestation', undefined)).to.be.null;
        });
    });

    describe('getSnapshot() – returns null when indexer URL unavailable', function () {
        it('returns null when hub has no indexer URL', async function () {
            let snap = new CapabilitySnapshot(makeHub({ indexerUrl: null }));
            expect(await snap.getSnapshot('attestation', 100)).to.be.null;
        });
    });

    describe('getSnapshot() – cache hit', function () {
        it('does not re-fetch when a fresh cached entry exists', async function () {
            axiosStub.post.resolves(okResult());
            let snap = new CapabilitySnapshot(makeHub());
            snap.cacheTtlMs = 60000;

            // First fetch: populates cache
            await snap.getSnapshot('attestation', 100);
            // Second fetch: should use cache
            await snap.getSnapshot('attestation', 100);

            expect(axiosStub.post.callCount).to.equal(1);
        });
    });

    describe('getSnapshot() – error paths', function () {
        it('returns null when axios throws', async function () {
            axiosStub.post.rejects(new Error('network error'));
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getSnapshot('attestation', 100)).to.be.null;
        });

        it('returns null when result contains an error field', async function () {
            axiosStub.post.resolves({ data: { result: { error: 'not found' } } });
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getSnapshot('attestation', 100)).to.be.null;
        });

        it('returns null when result is null', async function () {
            axiosStub.post.resolves({ data: { result: null } });
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getSnapshot('attestation', 100)).to.be.null;
        });
    });

    describe('getSnapshot() – happy path fields', function () {
        it('returns snapshot with validators and count', async function () {
            axiosStub.post.resolves(okResult());
            let snap = new CapabilitySnapshot(makeHub());
            let result = await snap.getSnapshot('attestation', 100);
            expect(result).to.not.be.null;
            expect(result.validators).to.have.length(2);
            expect(result.count).to.equal(2);
            expect(result.capability).to.equal('attestation');
        });

        it('uses empty array when validators is absent in result', async function () {
            axiosStub.post.resolves({
                data: { result: { capability: 'attestation', block_index: 100, count: 0 } }
            });
            let snap = new CapabilitySnapshot(makeHub());
            let result = await snap.getSnapshot('attestation', 100);
            expect(result.validators).to.deep.equal([]);
        });
    });

    // ── getActiveValidatorSnapshot() ─────────────────────────────────────────

    describe('getActiveValidatorSnapshot()', function () {
        it('returns null for null blockIndex', async function () {
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getActiveValidatorSnapshot(null)).to.be.null;
        });

        it('returns null when no indexer URL is available', async function () {
            let snap = new CapabilitySnapshot(makeHub({ indexerUrl: null }));
            expect(await snap.getActiveValidatorSnapshot(100)).to.be.null;
        });

        it('calls getactivevalidators RPC and returns snapshot', async function () {
            axiosStub.post.resolves({
                data: {
                    result: {
                        capability: '*', block_index: 200,
                        count: 1, validators: [{ pubkey: 'aabbcc', amount: '100' }]
                    }
                }
            });
            let snap = new CapabilitySnapshot(makeHub());
            let result = await snap.getActiveValidatorSnapshot(200);
            expect(result).to.not.be.null;
            expect(result.capability).to.equal('*');
            let body = axiosStub.post.firstCall.args[1];
            expect(body.method).to.equal('getactivevalidators');
            expect(body.params.block_index).to.equal(200);
        });

        it('returns null when result has error', async function () {
            axiosStub.post.resolves({ data: { result: { error: 'fail' } } });
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getActiveValidatorSnapshot(200)).to.be.null;
        });

        it('returns null on axios error', async function () {
            axiosStub.post.rejects(new Error('timeout'));
            let snap = new CapabilitySnapshot(makeHub());
            expect(await snap.getActiveValidatorSnapshot(200)).to.be.null;
        });

        it('caches the result on the second call', async function () {
            axiosStub.post.resolves({
                data: { result: { capability: '*', block_index: 200, count: 1, validators: [] } }
            });
            let snap = new CapabilitySnapshot(makeHub());
            snap.cacheTtlMs = 60000;
            await snap.getActiveValidatorSnapshot(200);
            await snap.getActiveValidatorSnapshot(200);
            expect(axiosStub.post.callCount).to.equal(1);
        });
    });

    // ── getQuorum() ──────────────────────────────────────────────────────────

    describe('getQuorum()', function () {
        let snap;
        beforeEach(function () {
            snap = new CapabilitySnapshot(makeHub());
        });

        it('returns 0 for null snapshot', function () {
            expect(snap.getQuorum(null)).to.equal(0);
        });

        it('returns 0 when N <= 1 (single-node mode)', function () {
            expect(snap.getQuorum({ count: 0 })).to.equal(0);
            expect(snap.getQuorum({ count: 1 })).to.equal(0);
        });

        it('floors N=3 at the simple majority → quorum=2', function () {
            // 2f+1 at N=3 is 2*0+1 = 1; the majority floor ceil((3+1)/2) = 2
            // wins, so a single validator can never finalize alone.
            expect(snap.getQuorum({ count: 3 })).to.equal(2);
        });

        it('returns correct quorum for N=4', function () {
            // N=4: 2*floor(3/3)+1 = 2*1+1 = 3
            expect(snap.getQuorum({ count: 4 })).to.equal(3);
        });

        it('returns correct quorum for N=7', function () {
            // N=7: 2*floor(6/3)+1 = 2*2+1 = 5
            expect(snap.getQuorum({ count: 7 })).to.equal(5);
        });

        it('returns correct quorum for N=10', function () {
            // N=10: 2*floor(9/3)+1 = 2*3+1 = 7
            expect(snap.getQuorum({ count: 10 })).to.equal(7);
        });

        // #4479: a truncated snapshot (indexer hit VALIDATOR_QUERY_LIMIT) still
        // finalizes (alarm-and-proceed: the cap is cross-hub deterministic) but
        // raises a loud, throttled operator warning so the cap is not invisible.
        it('still computes quorum over a TRUNCATED snapshot (alarm-and-proceed)', function () {
            const err = sinon.stub(console, 'error');
            // Same N=7 set, but flagged truncated: quorum is unchanged.
            expect(snap.getQuorum({ count: 7, truncated: true, capability: '*', blockIndex: 100 })).to.equal(5);
            expect(err.calledOnce).to.equal(true);
            expect(err.firstCall.args[0]).to.contain('TRUNCATED');
        });

        it('throttles the truncated-snapshot warning to one per TTL', function () {
            const err = sinon.stub(console, 'error');
            const trunc = { count: 7, truncated: true, capability: '*', blockIndex: 100 };
            snap.getQuorum(trunc);
            snap.getQuorum(trunc);
            snap.getQuorum(trunc);
            expect(err.callCount).to.equal(1);
        });

        it('does NOT warn for a non-truncated snapshot', function () {
            const err = sinon.stub(console, 'error');
            snap.getQuorum({ count: 7, truncated: false, capability: '*', blockIndex: 100 });
            expect(err.called).to.equal(false);
        });
    });

    // ── isInSnapshot() ───────────────────────────────────────────────────────

    describe('isInSnapshot()', function () {
        let snap;
        let snapshot;

        beforeEach(function () {
            snap = new CapabilitySnapshot(makeHub());
            snapshot = {
                validators: [
                    { pubkey: 'aabbcc' },
                    { pubkey: 'DDEEFF' }  // uppercase to test normalisation
                ]
            };
        });

        it('returns false for null snapshot', function () {
            expect(snap.isInSnapshot(null, 'aabbcc')).to.be.false;
        });

        it('returns false for null pubkey', function () {
            expect(snap.isInSnapshot(snapshot, null)).to.be.false;
        });

        it('returns true for a pubkey in the snapshot (case-insensitive)', function () {
            expect(snap.isInSnapshot(snapshot, 'AABBCC')).to.be.true;
            expect(snap.isInSnapshot(snapshot, 'ddeeff')).to.be.true;
        });

        it('returns false for a pubkey not in the snapshot', function () {
            expect(snap.isInSnapshot(snapshot, 'ffffff')).to.be.false;
        });
    });

    // ── _prune() ─────────────────────────────────────────────────────────────

    describe('_prune()', function () {
        it('evicts expired cache entries', function () {
            let snap = new CapabilitySnapshot(makeHub());
            let now  = Date.now();
            snap.cache.set('old:1',  { expiresAt: now - 1 });
            snap.cache.set('fresh:2', { expiresAt: now + 10000 });
            snap._prune(now);
            expect(snap.cache.has('old:1')).to.be.false;
            expect(snap.cache.has('fresh:2')).to.be.true;
        });
    });
});
