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

function makeHub(registry) {
        return {
            capabilityRegistry: registry,
            _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
            btcIndexerHeaders: () => ({})
        };
    }

function okResult() {
        return { data: { result: { capability: 'attestation', block_index: 100, count: 1, validators: [{ pubkey: 'ab', amount: '50000' }] } } };
    }

function installSuiteHooks1() {
    beforeEach(function () {
            axiosStub = { post: sinon.stub() };
            logStub = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
            CapabilitySnapshot = proxyquire('../../src/validators/capability_snapshot', {
                axios: axiosStub,
                '../observability': { getLogger: () => logStub, '@global': true }
            });
        });
    afterEach(function () {
            sinon.restore();
        });
}

// -----------------------------------------------------------------
// Weightless row on a WEIGHT snapshot
//
// stake_weighted_quorum fails closed on a row with no weight, but it never
// sees one: every consumer re-maps the snapshot through
// `String(v.weight != null ? v.weight : '0')`, which turns the missing
// weight into a real zero. The source then sits in the quorum's dedupe map
// carrying no stake, so the denominator S shrinks while a signer keeps the
// full numerator, and a smaller real stake clears 3*tally > 2*S. The
// rejection therefore has to happen where the wire row enters the hub.
// A live regtest sweep (BTC/LTC/DOGE, every capability, several block
// boundaries) found zero weightless rows, so this can only fire on a
// corrupt or hostile indexer answer.
// -----------------------------------------------------------------

function dataResult(result) { return { data: { result: result } }; }

let weightMethods = [
            { name: 'getWeightSnapshot',       call: (s) => s.getWeightSnapshot('attestation', 106), base: { capability: 'attestation', block_index: 100, count: 2, source_count: 2 } },
            { name: 'getActiveWeightSnapshot', call: (s) => s.getActiveWeightSnapshot(106),          base: { block_index: 100, count: 2, source_count: 2 } }
        ];

// Each bad second row is one way a weight can go missing on the wire.
let badWeights = [
            { label: 'weight is absent',   row: { pubkey: 'cd', source: 'src2' } },
            { label: 'weight is null',     row: { pubkey: 'cd', source: 'src2', weight: null } },
            { label: 'weight is empty',    row: { pubkey: 'cd', source: 'src2', weight: '' } },
            { label: 'weight is blank',    row: { pubkey: 'cd', source: 'src2', weight: '   ' } },
            { label: 'weight is garbage',  row: { pubkey: 'cd', source: 'src2', weight: 'lots' } },
            { label: 'weight is NaN-ish',  row: { pubkey: 'cd', source: 'src2', weight: 'NaN' } }
        ];

let good = { pubkey: 'ab', source: 'src1', weight: '50000' };

// -----------------------------------------------------------------
// Reorg-depth buffer
//
// Callers pass a tip-derived height, but stake state AT tip is not
// reorg-safe: a shallow reorg can rewrite it while the 60s cache keeps
// serving the pre-reorg set. Every getter must therefore resolve the
// snapshot at (requested - buffer), clamped at 0, and label the snapshot
// with the buried height it truly represents.
// -----------------------------------------------------------------

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

function installSuiteHooks2() {
    afterEach(function () {
                delete process.env.HUB_SNAPSHOT_REORG_BUFFER;
            });
}

// #4167: a VALID but non-canonical buffer is the dangerous case. It is
// subtracted before the cache key and the indexer RPC are formed, so a
// hub carrying its own value locks a different block than its peers for
// the same round and quorum N forks with nothing logged.
function networkedHub(network) {
                let hub = makeHub(null);
                hub.network = network;
                return hub;
            }

function installSuiteHooks3() {
    afterEach(function () {
                    delete process.env.XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT;
                });
}

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('weightless weight-snapshot row', function () {
for (let m of weightMethods) {
            for (let bad of badWeights) {
                it(m.name + ' returns null when ' + bad.label, async function () {
                    axiosStub.post.resolves(dataResult(Object.assign({}, m.base, { validators: [good, bad.row] })));
                    let snap = new CapabilitySnapshot(makeHub(null));
                    expect(await m.call(snap)).to.equal(null);
                });
            }

            it(m.name + ' rejects the WHOLE snapshot, never just the bad row', async function () {
                // Dropping the row instead of refusing the snapshot shrinks S by
                // exactly the amount the missing weight would have contributed -
                // the same defect wearing a different hat.
                axiosStub.post.resolves(dataResult(Object.assign({}, m.base, { validators: [good, { pubkey: 'cd', source: 'src2' }] })));
                let snap = new CapabilitySnapshot(makeHub(null));
                expect(await m.call(snap)).to.equal(null);
            });

            it(m.name + ' still accepts a LEGITIMATE zero weight', async function () {
                // A source qualified at MIN_STAKE 0 really can weigh 0. That is a
                // value, not an absence, and the predicate handles it.
                axiosStub.post.resolves(dataResult(Object.assign({}, m.base, { validators: [good, { pubkey: 'cd', source: 'src2', weight: '0' }] })));
                let snap = new CapabilitySnapshot(makeHub(null));
                let out = await m.call(snap);
                expect(out).to.not.equal(null);
                expect(out.validators).to.be.an('array').with.lengthOf(2);
            });

            it(m.name + ' accepts a decimal weight', async function () {
                axiosStub.post.resolves(dataResult(Object.assign({}, m.base, { validators: [good, { pubkey: 'cd', source: 'src2', weight: '12345.67890000' }] })));
                let snap = new CapabilitySnapshot(makeHub(null));
                expect(await m.call(snap)).to.not.equal(null);
            });
        }
it('leaves the COUNT snapshot lenient (it carries amount, not weight)', async function () {
            // getSnapshot feeds the count quorum, which never reads a weight, so
            // holding it to the weight contract would halt the count path for no
            // safety gain.
            axiosStub.post.resolves(dataResult({ capability: 'attestation', block_index: 100, count: 1, validators: [{ pubkey: 'ab', amount: '50000' }] }));
            let snap = new CapabilitySnapshot(makeHub(null));
            let out = await snap.getSnapshot('attestation', 106);
            expect(out).to.not.equal(null);
            expect(out.validators).to.be.an('array').with.lengthOf(1);
        });
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('reorg-depth buffer (#S-F7)', function () {
    installSuiteHooks2();
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
            let errStub = logStub.error;
            let snap = new CapabilitySnapshot(makeHub(null));
            expect(snap.reorgBufferBlocks).to.equal(6);
            expect(errStub.calledWithMatch(/HUB_SNAPSHOT_REORG_BUFFER/)).to.equal(true);
        });
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('reorg-depth buffer (#S-F7)', function () {
    installSuiteHooks2();
it('rejects a negative override', function () {
            process.env.HUB_SNAPSHOT_REORG_BUFFER = '-3';
            logStub.error;
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

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('reorg-depth buffer (#S-F7)', function () {
    installSuiteHooks2();
describe('canonical-value assertion (#4167)', function () {
    installSuiteHooks3();
for (let network of ['mainnet', 'testnet']) {
                it('refuses to construct on ' + network + ' when the buffer diverges', function () {
                    process.env.HUB_SNAPSHOT_REORG_BUFFER = '0';
                    let thrown = null;
                    try { new CapabilitySnapshot(networkedHub(network)); } catch (e) { thrown = e; }
                    expect(thrown).to.be.an('error');
                    expect(thrown.code).to.equal('REORG_BUFFER_MISMATCH');
                });
            }
it('accepts the canonical 6 stated explicitly on mainnet', function () {
                process.env.HUB_SNAPSHOT_REORG_BUFFER = '6';
                let snap = new CapabilitySnapshot(networkedHub('mainnet'));
                expect(snap.reorgBufferBlocks).to.equal(6);
            });
it('accepts an unset buffer on mainnet', function () {
                let snap = new CapabilitySnapshot(networkedHub('mainnet'));
                expect(snap.reorgBufferBlocks).to.equal(6);
            });
it('warns and accepts on regtest so venues can run deliberate depths', function () {
                process.env.HUB_SNAPSHOT_REORG_BUFFER = '0';
                let warnStub = logStub.warn;
                let snap = new CapabilitySnapshot(networkedHub('regtest'));
                expect(snap.reorgBufferBlocks).to.equal(0);
                expect(warnStub.calledWithMatch(/HUB_SNAPSHOT_REORG_BUFFER/)).to.equal(true);
            });
it('warns and accepts in standalone mode (no network declared)', function () {
                process.env.HUB_SNAPSHOT_REORG_BUFFER = '12';
                logStub.warn;
                let snap = new CapabilitySnapshot(makeHub(null));
                expect(snap.reorgBufferBlocks).to.equal(12);
            });
it('honors the loud one-off bypass on mainnet', function () {
                process.env.HUB_SNAPSHOT_REORG_BUFFER = '0';
                process.env.XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT = '1';
                let warnStub = logStub.warn;
                let snap = new CapabilitySnapshot(networkedHub('mainnet'));
                expect(snap.reorgBufferBlocks).to.equal(0);
                expect(warnStub.calledWithMatch(/XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT/)).to.equal(true);
            });
it('still falls back to the canonical default on a typo, without throwing', function () {
                process.env.HUB_SNAPSHOT_REORG_BUFFER = 'lots';
                logStub.error;
                let snap = new CapabilitySnapshot(networkedHub('mainnet'));
                expect(snap.reorgBufferBlocks).to.equal(6);
            });
});
});
});
