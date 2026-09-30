'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const sinon = require('sinon');
const { expect } = require('chai');
const OracleConsensus = require('../../../../../src/oracle/consensus');
const { createMockHub } = require('../../../../helpers/mockHub');

const ROUND = 17;
const SIGNATURES = [
    ['pubkey-c', 'signature-c'],
    ['pubkey-a', 'signature-a'],
    ['pubkey-b', 'signature-b']
];
const EXPECTED_PROOF = [
    { pubkey: 'pubkey-a', sig: 'signature-a' },
    { pubkey: 'pubkey-b', sig: 'signature-b' },
    { pubkey: 'pubkey-c', sig: 'signature-c' }
];

function makeConsensus() {
    return new OracleConsensus(createMockHub(), {
        getSubmissions: sinon.stub().returns(new Map())
    });
}

function makePending(commits, signatures) {
    return {
        prepares: new Set(['pubkey-a', 'pubkey-b', 'pubkey-c']),
        commits: new Set(commits),
        signatures: new Map(signatures),
        prices: [{ coinPair: 'BTC/USD', price: '100000' }],
        btcBlockHeight: 900000,
        btcBlockTime: 1700000000,
        finalized: true
    };
}

describe('OracleConsensus stored signature proof', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('stores a canonical signature proof regardless of vote arrival order', async function () {
        let first = makeConsensus();
        let second = makeConsensus();
        let firstStore = sinon.stub(first, 'storeSnapshot').resolves();
        let secondStore = sinon.stub(second, 'storeSnapshot').resolves();
        let emitted = [];
        first.on('round:finalized', event => emitted.push(event.signatures));
        second.on('round:finalized', event => emitted.push(event.signatures));

        first.pendingRounds.set(ROUND, makePending(
            ['pubkey-a', 'pubkey-b', 'pubkey-c'], SIGNATURES));
        second.pendingRounds.set(ROUND, makePending(
            ['pubkey-c', 'pubkey-a', 'pubkey-b'], [SIGNATURES[1], SIGNATURES[2], SIGNATURES[0]]));

        await first.finalizeCommittedRound(ROUND);
        await second.finalizeCommittedRound(ROUND);

        let firstProof = firstStore.firstCall.args[3];
        let secondProof = secondStore.firstCall.args[3];
        expect(firstProof).to.equal(secondProof);
        expect(JSON.parse(firstProof)).to.deep.equal(EXPECTED_PROOF);
        expect(JSON.parse(firstProof).some(entry => typeof entry === 'string')).to.be.false;
        expect(emitted).to.deep.equal([EXPECTED_PROOF, EXPECTED_PROOF]);
    });
});
