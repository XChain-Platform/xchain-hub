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

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const CASES = [
    { method: 'getSnapshot', rpc: 'getcapabilityvalidators' },
    { method: 'getWeightSnapshot', rpc: 'getstakeweightsbycapability' },
];

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function rpcReply(body) {
    const weighted = body.method === 'getstakeweightsbycapability';
    const validator = weighted
        ? { pubkey: 'ab', source: 'source-a', weight: '50000' }
        : { pubkey: 'ab', amount: '50000' };
    return { data: { result: {
        capability: body.params.capability,
        block_index: body.params.block_index,
        count: 1,
        source_count: weighted ? 1 : undefined,
        validators: [validator],
    } } };
}

function fixture(resolveBtcIndexerUrl) {
    const axios = { post: sinon.stub() };
    const log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    const CapabilitySnapshot = proxyquire('../../../../src/validators/capability_snapshot.js', {
        axios,
        '../observability': { getLogger: () => log, '@global': true },
    });
    const hub = {
        resolveBtcIndexerUrl: resolveBtcIndexerUrl || sinon.stub().resolves('http://indexer.local/rpc'),
        btcIndexerHeaders: () => ({}),
    };
    return { axios, snapshot: new CapabilitySnapshot(hub) };
}

describe('CapabilitySnapshot single-flight success', function () {
    afterEach(function () { sinon.restore(); });

    for (const testCase of CASES) {
        it('shares one ' + testCase.rpc + ' fetch for concurrent ' + testCase.method + ' calls', async function () {
            const gate = deferred();
            const { axios, snapshot } = fixture();
            axios.post.returns(gate.promise);

            const calls = Array.from({ length: 8 }, () => snapshot[testCase.method]('attestation', 106));
            await Promise.resolve();
            expect(axios.post.callCount).to.equal(1);

            gate.resolve(rpcReply(axios.post.firstCall.args[1]));
            const values = await Promise.all(calls);
            expect(values.every(value => value === values[0])).to.equal(true);
        });
    }
});

describe('CapabilitySnapshot single-flight failure cleanup', function () {
    afterEach(function () { sinon.restore(); });

    for (const testCase of CASES) {
        it('shares a ' + testCase.method + ' failure and retries after it settles', async function () {
            const gate = deferred();
            const failure = new Error('indexer unavailable');
            let failing = true;
            const { axios, snapshot } = fixture();
            axios.post.callsFake((url, body) => failing ? gate.promise : Promise.resolve(rpcReply(body)));

            const calls = Array.from({ length: 6 }, () => snapshot[testCase.method]('attestation', 106));
            await Promise.resolve();
            gate.reject(failure);
            const failures = await Promise.all(calls);
            expect(failures.every(result => result === null)).to.equal(true);
            expect(snapshot.monitor.failures).to.equal(1);

            failing = false;
            expect(await snapshot[testCase.method]('attestation', 106)).not.to.equal(null);
            expect(axios.post.callCount).to.equal(2);
        });
    }
});

describe('CapabilitySnapshot single-flight key isolation', function () {
    afterEach(function () { sinon.restore(); });

    it('fetches different cache keys independently', async function () {
        const { axios, snapshot } = fixture();
        axios.post.callsFake((url, body) => Promise.resolve(rpcReply(body)));

        const values = await Promise.all([
            snapshot.getSnapshot('attestation', 106),
            snapshot.getSnapshot('attestation', 107),
        ]);

        expect(axios.post.callCount).to.equal(2);
        expect(values.map(value => value.blockIndex)).to.deep.equal([100, 101]);
    });
});
