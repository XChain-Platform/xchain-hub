'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: a follower must refuse to co-sign a proposed price whose SPELLING the
// chain's v0 price form refuses, even when its numeric value sits inside the deviation band.
// '1e5' against a local 100000 is the case that slipped through: deviation 0, co-signed,
// finalized verbatim, and then refused inside the atomic signed batch.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../../../../src/oracle/consensus');
const { createMockHub } = require('../../../../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions, makeCapabilitySnapshotStub } = require('../../../../helpers/fixtures');

const ROUND = 1;

// Spellings parseFloat reads as about 100000 but the chain's v0 price pattern refuses.
const NON_CANONICAL = [
    '1e5',
    '+100000',
    ' 100000',
    '100000 ',
    '100000.',
    '0100000',
    '100000.123456789',
    '100000.' + '0'.repeat(40),
    ['100000'],
    null,
    true,
];

// Spellings an honest leader can produce, which must keep co-signing.
const CANONICAL = ['100000', '100000.00000000', '100000.5', 100000];

describe('OracleConsensus: follower refuses a non-canonical proposed price spelling', function () {
    let hub, pm, oc, oracleRound, leader;

    function proposeEnvelope(prices) {
        return { sender: leader.addr, sig_pubkey: leader.pubkey, data: {
            round: ROUND, prices, digest: oc.digest(ROUND, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } };
    }

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        leader = oc.getLeader(ROUND);
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
        // This follower's own locally observed BTC/USD is 100000, so every value below is
        // inside the deviation band and only the spelling can withhold it.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
    });

    afterEach(function () { sinon.restore(); });

    for (let price of NON_CANONICAL) {
        it('withholds co-sign on ' + JSON.stringify(price) + ' with reason non-canonical-price', async function () {
            let events = [];
            oc.on('oracle:propose-rejected', e => events.push(e));
            await oc.handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price }]));
            expect(oc.pendingRounds.has(ROUND), 'a non-canonical spelling must not co-sign').to.be.false;
            expect(pm.broadcast.called, 'no PREPARE for a non-canonical spelling').to.be.false;
            expect(events.map(e => e.reason)).to.deep.equal(['non-canonical-price']);
        });
    }

    for (let price of CANONICAL) {
        it('still co-signs the canonical spelling ' + JSON.stringify(price), async function () {
            let events = [];
            oc.on('oracle:propose-rejected', e => events.push(e));
            await oc.handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price }]));
            expect(oc.pendingRounds.has(ROUND), 'an honest spelling must co-sign').to.be.true;
            expect(events).to.deep.equal([]);
        });
    }

    it('keeps the out-of-range reason for a canonical spelling at PRICE_MAX', async function () {
        let events = [];
        oc.on('oracle:propose-rejected', e => events.push(e));
        oracleRound.getSubmissions.returns(new Map());
        await oc.handlePropose(proposeEnvelope([{ coinPair: 'BTC/KRW', price: '10000000000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(events.map(e => e.reason)).to.deep.equal(['out-of-range']);
    });
});
