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
            CapabilitySnapshot = proxyquire('../../../src/validators/capability_snapshot', {
                axios: axiosStub,
                '../observability': { getLogger: () => logStub, '@global': true }
            });
        });
    afterEach(function () {
            sinon.restore();
        });
}

// Finding #4136/#4220: a 401 (hub BTC_INDEXER_API_KEY != indexer
// INDEXER_API_KEY) must NOT be swallowed as an anonymous null snapshot; that
// makes an auth misconfig indistinguishable from a dead indexer and silently
// collapses every attestation + config-change quorum.
function err401(status) {
            let e = new Error('Request failed with status code ' + status);
            e.response = { status: status };
            return e;
        }

// -----------------------------------------------------------------
// Malformed result → null (FINDING #5334)
//
// A bad-shape `validators` field must return null (routing the consensus
// caller through its fail-closed gate), NOT { validators: [] } which would
// collapse to quorum=0 and look like single-node. A LEGITIMATE empty or
// truncated array still yields a real snapshot.
// -----------------------------------------------------------------

function dataResult(result) {
            return { data: { result: result } };
        }

// Each fetch method paired with a base valid result for its RPC, and with a
// row of the shape THAT RPC actually returns: the count RPCs answer
// {pubkey, amount}, the source-keyed weight RPCs answer {pubkey, source,
// weight}. The distinction matters: a weight RPC row carrying
// no `weight` is rejected as malformed rather than read as zero stake.
let countRow  = { pubkey: 'ab', amount: '50000' };

let weightRow = { pubkey: 'ab', source: 'bc1qsource', weight: '50000' };

let methods = [
            { name: 'getSnapshot',                 call: (s) => s.getSnapshot('attestation', 106),    base: { capability: 'attestation', block_index: 100, count: 1 }, row: countRow },
            { name: 'getWeightSnapshot',           call: (s) => s.getWeightSnapshot('attestation', 106), base: { capability: 'attestation', block_index: 100, count: 1, source_count: 1 }, row: weightRow },
            { name: 'getActiveValidatorSnapshot',  call: (s) => s.getActiveValidatorSnapshot(106),     base: { block_index: 100, count: 1 }, row: countRow },
            { name: 'getActiveWeightSnapshot',     call: (s) => s.getActiveWeightSnapshot(106),        base: { block_index: 100, count: 1, source_count: 1 }, row: weightRow }
        ];

// (d) malformed shapes return null on every fetch path.
let badShapes = [
            { label: 'missing validators field', validators: undefined },
            { label: 'validators is an object',  validators: { 0: { pubkey: 'ab' } } },
            { label: 'validators is a string',   validators: 'ab,cd' },
            { label: 'validators is a number',   validators: 3 }
        ];

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('indexer auth failure (401/403)', function () {
it('returns null AND logs a distinct auth warning on a 401', async function () {
            axiosStub.post.rejects(err401(401));
            // The auth and alert lines are written through the logger now.
            let spy = logStub.error;
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
            let spy = logStub.error;
            let snap = new CapabilitySnapshot(makeHub(null));

            // Distinct keys/methods so the 60s snapshot cache never short-circuits the call.
            await snap.getSnapshot('attestation', 106);
            await snap.getWeightSnapshot('attestation', 101);
            await snap.getActiveValidatorSnapshot(102);

            // One throttled auth line inside the TTL window. The third failure
            // also crosses the alert threshold, which escalates ONCE per
            // outage; that line is the alert, not a repeat of the auth warning.
            let authLines  = spy.getCalls().filter(c => String(c.args[0]).indexOf('(auth)') !== -1);
            let alertLines = spy.getCalls().filter(c => String(c.args[0]).indexOf('ALERT:') === 0);
            expect(authLines.length).to.equal(1);
            expect(alertLines.length).to.equal(1);
        });
it('logs a transport error as unreachable, NOT as auth', async function () {
            // A transport error was once treated as the silent case: it returned
            // null with no log at all, so an unreachable indexer looked exactly
            // like a healthy hub with nothing to do. It must now be surfaced,
            // and still be distinguishable from an auth mismatch.
            axiosStub.post.rejects(new Error('ECONNREFUSED'));
            let spy = logStub.error;
            let snap = new CapabilitySnapshot(makeHub(null));

            let result = await snap.getSnapshot('attestation', 106);

            expect(result).to.equal(null);                     // still falls back
            expect(spy.callCount).to.equal(1);
            let msg = spy.firstCall.args[0];
            expect(msg).to.contain('(unreachable)');
            expect(msg).to.contain('ECONNREFUSED');
            expect(msg).to.not.contain('BTC_INDEXER_API_KEY');
            expect(snap.monitor.byReason.unreachable).to.equal(1);
        });
});
});

describe('CapabilitySnapshot', function () {
    installSuiteHooks1();
describe('malformed indexer result (#5334)', function () {
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
                let result = Object.assign({}, m.base, { validators: [m.row] });
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
