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

let axiosStub, CapabilitySnapshot, logStub;

// Fake hub: resolves an indexer URL and (optionally) exposes a registry that
// serves the authoritative MIN_STAKE for a capability.
function makeHub(registry) {
        return {
            capabilityRegistry: registry,
            resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
            // getSnapshot attaches indexer auth headers to the RPC call; the real
            // hub builds these from BTC_INDEXER_API_KEY. Tests don't care about the
            // header value, only that the call is made; return an empty object.
            btcIndexerHeaders: () => ({})
        };
    }

function okResult() {
        return { data: { result: { capability: 'attestation', block_index: 100, count: 1, validators: [{ pubkey: 'ab', amount: '50000' }] } } };
    }

function installSuiteHooks1() {
    beforeEach(function () {
            axiosStub = { post: sinon.stub() };
            // The module logs through the observability singleton, so the logger is
            // injected rather than spied: proxyquire hands other suites their own
            // copy of that module, and a spy on this file's copy then sees nothing.
            logStub = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
            CapabilitySnapshot = proxyquire('../../../src/validators/capability_snapshot', {
                axios: axiosStub,
                // @global so the monitor module this one loads logs to the same stub;
                // its auth and ALERT lines are half of what these tests assert on.
                '../observability': { getLogger: () => logStub, '@global': true }
            });
        });
    afterEach(function () {
            sinon.restore();
        });
}

// A governance MIN_STAKE change must not be served a snapshot that was cached
// under the old threshold: the threshold controls which validators qualify, so
// two hubs caching contradictory sets for the same (capability, blockIndex)
// would lock different PBFT quorums for the same round. The fix folds the
// resolved min_stake into the cache key AND flushes the capability's entries
// when the threshold changes (XChainHub does this on 'proposal:finalized').

// okResult with a controllable validator set so old vs new is observable.
function resultWith(validators) {
            return { data: { result: { capability: 'attestation', block_index: 100, count: validators.length, validators } } };
        }

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

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
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
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
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
            logStub.error;
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            let result = await snap.getSnapshot('attestation', 106);
            expect(result).to.equal(null);
        });
it('rejects a snapshot whose echoed capability differs from the request (#6125)', async function () {
            // The other half of the request key. `capability` selects which stake rows
            // the indexer filters, so a mismatched echo is a validator set for the wrong
            // POPULATION - cached under the requested key for the full TTL and consumed
            // as the round's N. Refused (null), never cached, exactly like a block echo.
            axiosStub.post.resolves({ data: { result: {
                capability: 'oracle_publish', block_index: 100, count: 1,
                validators: [{ pubkey: 'ab', amount: '50000' }]
            } } });
            logStub.error;
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            expect(await snap.getSnapshot('attestation', 106)).to.equal(null);
            expect(snap.cache.size, 'a rejected snapshot is never cached').to.equal(0);
        });
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('getSnapshot()', function () {
it('rejects a snapshot with NO capability field at all (#6125)', async function () {
            // A stripped field is indistinguishable from a wrong one at this seam, so
            // the guard is strict about absence the way the block echo already is.
            axiosStub.post.resolves({ data: { result: {
                block_index: 100, count: 1, validators: [{ pubkey: 'ab', amount: '50000' }]
            } } });
            logStub.error;
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            expect(await snap.getSnapshot('attestation', 106)).to.equal(null);
        });
it('rejects a WEIGHT snapshot whose echoed capability differs from the request (#6125)', async function () {
            axiosStub.post.resolves({ data: { result: {
                capability: 'oracle_publish', block_index: 100, count: 1, source_count: 1,
                validators: [{ pubkey: 'ab', source: 'src1', weight: '50000' }]
            } } });
            logStub.error;
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            expect(await snap.getWeightSnapshot('attestation', 106)).to.equal(null);
        });
it('accepts a snapshot whose capability echo matches (#6125)', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns('25000') };
            let snap = new CapabilitySnapshot(makeHub(registry));

            let result = await snap.getSnapshot('attestation', 106);
            expect(result).to.not.equal(null);
            expect(result.capability).to.equal('attestation');
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
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('getSnapshot()', function () {
it('fails CLOSED when a LIVE registry has no threshold for the capability (#S-F3 fork guard)', async function () {
            // A wired registry that resolves NO threshold means the capability was
            // never put in HUB_CAPABILITY_CONFIG. Omitting min_stake would let each
            // indexer apply its own local threshold and fork the qualifying set, so
            // the snapshot must be refused (null) and the indexer never queried.
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(null) };
            let snap = new CapabilitySnapshot(makeHub(registry));
            let errStub = logStub.error;

            let result = await snap.getSnapshot('attestation', 106);

            expect(result).to.equal(null);
            expect(axiosStub.post.called).to.equal(false);
            expect(errStub.calledWithMatch(/NO configured MIN_STAKE/)).to.equal(true);
        });
it('fails CLOSED in getWeightSnapshot too when a live registry has no threshold', async function () {
            axiosStub.post.resolves(okResult());
            let registry = { getMinStake: sinon.stub().returns(null) };
            let snap = new CapabilitySnapshot(makeHub(registry));
            logStub.error;

            let result = await snap.getWeightSnapshot('attestation', 106);

            expect(result).to.equal(null);
            expect(axiosStub.post.called).to.equal(false);
        });
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('MIN_STAKE change invalidation', function () {
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

            // One row that satisfies BOTH RPC shapes: the same stub answers the count
            // fetch (amount) and the weight fetch (source+weight), and a weight
            // snapshot missing its weight is refused rather than cached. The stub
            // ECHOES the requested capability, like the real indexer: a static
            // 'attestation' echo is now rejected for the 'price' read by the
            // capability-echo guard (#6125), which is the guard doing its job rather
            // than anything about flushing.
            axiosStub.post.callsFake((url, body) => Promise.resolve({ data: { result: {
                capability:  body.params.capability,
                block_index: 100,
                count:       1,
                validators:  [{ pubkey: 'old', amount: '30000', source: 'src1', weight: '30000' }]
            } } }));
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
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('MIN_STAKE change invalidation', function () {
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
            //     (mirrors XChainHub.applyCapabilityGovernanceChange on the event).
            threshold = '50000';
            snap.flushCapability('attestation');

            // (c) the next read reflects the new validator set
            let after = await snap.getSnapshot('attestation', 106);
            expect(after.validators[0].pubkey).to.equal('new');
        });
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('L4 determinism: capability validator set', function () {
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
});
