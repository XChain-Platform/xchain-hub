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
// Item 5833: the slash gate measures RAW submissions against the CLAMPED published
// price, so a genuine move past the clamp put every honest submitter outside the 5%
// band and recorded price_deviation against the whole federation. The band is widened
// by the pair's clamp allowance ONLY in a round where that pair actually clamped.

const sinon            = require('sinon');
const { expect }       = require('chai');
const SlashDetector    = require('../../src/SlashDetector');
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub }   = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

describe('SlashDetector clamped-round band (item 5833)', function () {

    let hub, pm, sd, oc;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Map(VALIDATORS_3.map(v => [v.addr, v.pubkey]));
        oc  = new OracleConsensus(hub, { getSubmissions: sinon.stub().returns(new Map()) });
        hub.oracleConsensus = oc;
        sd  = new SlashDetector(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // Put the engine in the state _storeSnapshot leaves it in for `round`: the clamp
    // basis retained, the cache already moved on to the round just stored.
    function withClampBasis(round, pair, lastFinalized) {
        oc._updateLastFinalizedPrices([{ coinPair: pair, price: lastFinalized }], round - 1);
        oc._clampReference = { round: round, prices: new Map(oc._lastFinalizedPrices) };
    }

    function insertedProposals() {
        return hub.db.doQuery.getCalls().filter(c => String(c.args[0]).includes('slash_proposals'));
    }

    it('a clamped XCHAIN/USD round does not slash the honest submitters', async function () {
        // Genuine +20% move: every hub submits 1.20*L, the median is 1.20*L, and the
        // 10% XCHAIN/USD clamp publishes 1.10*L. Each submission is then 9.09% from the
        // published price, over the 5% band but inside the clamp allowance.
        withClampBasis(9, 'XCHAIN/USD', '1.00000000');
        let finalized = [{ coinPair: 'XCHAIN/USD', price: '1.10000000' }];
        let subs = buildSubmissions(VALIDATORS_3.map(v => ({
            sender: v.addr, prices: [{ coinPair: 'XCHAIN/USD', price: '1.20000000' }]
        })));

        await sd._checkDeviations(9, subs, finalized);
        expect(insertedProposals()).to.have.length(0);
    });

    it('the same round still slashes a submitter outside the widened band', async function () {
        withClampBasis(9, 'XCHAIN/USD', '1.00000000');
        let finalized = [{ coinPair: 'XCHAIN/USD', price: '1.10000000' }];
        // 1.20 is inside 5% + 10% = 15% of 1.10; 1.30 (18.18%) is not.
        let subs = buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'XCHAIN/USD', price: '1.20000000' }] },
            { sender: VALIDATORS_3[1].addr, prices: [{ coinPair: 'XCHAIN/USD', price: '1.30000000' }] }
        ]);

        await sd._checkDeviations(9, subs, finalized);
        let calls = insertedProposals();
        expect(calls).to.have.length(1);
        expect(calls[0].args[1][0]).to.equal(VALIDATORS_3[1].pubkey);
        expect(calls[0].args[1][1]).to.equal('price_deviation');
        // Evidence still cites the published price, so the body (and its hash) is
        // exactly what an un-widened hub would have written for this submitter.
        let evidence = JSON.parse(calls[0].args[1][3]);
        expect(evidence.pairs[0].finalized).to.equal(1.1);
    });

    it('an UNCLAMPED round keeps the tight band', async function () {
        // Published price sits inside the bounds, so nothing is widened.
        withClampBasis(9, 'BTC/USD', '100000.00000000');
        let finalized = [{ coinPair: 'BTC/USD', price: '101000.00000000' }];
        let subs = buildSubmissions([{
            sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '107000.00000000' }]
        }]);

        await sd._checkDeviations(9, subs, finalized);
        expect(insertedProposals()).to.have.length(1);
    });

    it('widens only the pair that clamped, not its neighbours in the same round', async function () {
        oc._updateLastFinalizedPrices([
            { coinPair: 'XCHAIN/USD', price: '1.00000000' },
            { coinPair: 'BTC/USD',    price: '100000.00000000' }
        ], 8);
        oc._clampReference = { round: 9, prices: new Map(oc._lastFinalizedPrices) };
        let finalized = [
            { coinPair: 'XCHAIN/USD', price: '1.10000000' },        // clamped
            { coinPair: 'BTC/USD',    price: '101000.00000000' }    // not clamped
        ];
        let subs = buildSubmissions([{
            sender: VALIDATORS_3[0].addr, prices: [
                { coinPair: 'XCHAIN/USD', price: '1.20000000' },      // 9.09%, inside 15%
                { coinPair: 'BTC/USD',    price: '107000.00000000' }  // 5.94%, outside 5%
            ]
        }]);

        await sd._checkDeviations(9, subs, finalized);
        let calls = insertedProposals();
        expect(calls).to.have.length(1);
        let evidence = JSON.parse(calls[0].args[1][3]);
        expect(evidence.pairs.map(p => p.coinPair)).to.deep.equal(['BTC/USD']);
    });

    it('a round with no retained basis behaves exactly as before', async function () {
        // The engine holds a basis for round 9 only; round 10 gets the tight band.
        withClampBasis(9, 'XCHAIN/USD', '1.00000000');
        let finalized = [{ coinPair: 'XCHAIN/USD', price: '1.10000000' }];
        let subs = buildSubmissions([{
            sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'XCHAIN/USD', price: '1.20000000' }]
        }]);

        await sd._checkDeviations(10, subs, finalized);
        expect(insertedProposals()).to.have.length(1);
    });

    it('the generic 25% clamp allowance applies to a generic pair', async function () {
        withClampBasis(9, 'BTC/USD', '100000.00000000');
        let finalized = [{ coinPair: 'BTC/USD', price: '125000.00000000' }];   // clamped at +25%
        let subs = buildSubmissions([
            // 160000 is 28% from 125000: inside 5% + 25% = 30%.
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '160000.00000000' }] },
            // 170000 is 36%: outside it.
            { sender: VALIDATORS_3[1].addr, prices: [{ coinPair: 'BTC/USD', price: '170000.00000000' }] }
        ]);

        await sd._checkDeviations(9, subs, finalized);
        let calls = insertedProposals();
        expect(calls).to.have.length(1);
        expect(calls[0].args[1][0]).to.equal(VALIDATORS_3[1].pubkey);
    });

    it('a downward clamp widens the band too', async function () {
        withClampBasis(9, 'XCHAIN/USD', '1.00000000');
        let finalized = [{ coinPair: 'XCHAIN/USD', price: '0.90000000' }];     // clamped at -10%
        let subs = buildSubmissions([{
            sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'XCHAIN/USD', price: '0.80000000' }]
        }]);

        await sd._checkDeviations(9, subs, finalized);
        expect(insertedProposals()).to.have.length(0);
    });

    it('no consensus engine on the hub leaves the tight band in force', async function () {
        let bare = createMockHub();
        bare._peerManager.validatorPubkeys = new Map(VALIDATORS_3.map(v => [v.addr, v.pubkey]));
        let lone = new SlashDetector(bare);
        let finalized = [{ coinPair: 'XCHAIN/USD', price: '1.10000000' }];
        let subs = buildSubmissions([{
            sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'XCHAIN/USD', price: '1.20000000' }]
        }]);

        await lone._checkDeviations(9, subs, finalized);
        expect(bare.db.doQuery.getCalls().filter(c => String(c.args[0]).includes('slash_proposals')))
            .to.have.length(1);
    });
});
