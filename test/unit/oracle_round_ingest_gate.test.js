'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: OracleRound ingest gate.
//   - Unregistered senders must not enter the aggregate (Sybil stuffing).
//   - Non-canonical coin pairs must not enter the aggregate (pair injection).

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMockHub } = require('../helpers/mockHub');
const { pubkeyForTestSender } = require('../helpers/fixtures');

describe('OracleRound ingest gate (stress-sweep 2026-07-08)', function () {

    let hub, pm, or, OracleRound;

    beforeEach(function () {
        let mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };
        OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher': function () { return mockPriceFetcher; }
        });
        hub = createMockHub({
            p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' }
        });
        pm = hub._peerManager;
        or = new OracleRound(hub);
    });

    afterEach(function () { sinon.restore(); });

    // sigPubkey defaults to a key unique to this sender. Admission keys on the
    // PROVEN signing key now, so an envelope without one is never counted.
    function submit(sender, prices, round, sigPubkey) {
        or._handleMessage({
            type: 'ORACLE_PRICE_SUBMIT',
            sender,
            sig_pubkey: sigPubkey || pubkeyForTestSender(sender),
            data: { round, prices, sources: 1, timestamp: Date.now() }
        });
    }

    it('drops a submission from an unregistered sender when the registry is populated', async function () {
        await or._executeRound();
        let round = or.currentRound;
        // Registry populated with only the self validator + one real peer.
        pm.validatorPubkeys = new Map([
            [pm.validatorAddr, 'aa'.repeat(32)],
            ['ws://real-peer:10001', 'bb'.repeat(32)]
        ]);

        submit('ws://forged-sender-xyz:10001', [{ coinPair: 'BTC/USD', price: '1' }], round,
            'ee'.repeat(32));   // a key neither the chain nor the registry attributes

        let subs = or.submissions.get(round);
        expect(subs.has('ws://forged-sender-xyz:10001')).to.equal(false);
    });

    it('accepts a submission from a registered sender', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map([
            [pm.validatorAddr, 'aa'.repeat(32)],
            ['ws://real-peer:10001', 'bb'.repeat(32)]
        ]);

        submit('ws://real-peer:10001', [{ coinPair: 'BTC/USD', price: '100001' }], round, 'bb'.repeat(32));

        expect(or.submissions.get(round).has('ws://real-peer:10001')).to.equal(true);
    });

    it('bootstrap (empty registry) still accepts submissions', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map(); // empty => permissive bootstrap
        submit('ws://anyone:10001', [{ coinPair: 'BTC/USD', price: '100001' }], round);
        expect(or.submissions.get(round).has('ws://anyone:10001')).to.equal(true);
    });

    it('drops a fabricated (non-canonical) coin pair on ingest', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map(); // bootstrap: sender gate open, isolate the pair gate
        submit('ws://peer:10001', [{ coinPair: 'BTC/ZZZ', price: '5' }], round);
        // Only a bogus pair => no valid prices => no submission recorded.
        expect(or.submissions.get(round).has('ws://peer:10001')).to.equal(false);
    });

    it('drops a price whose spelling parseFloat would admit as a prefix', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map();   // bootstrap: isolate the price gate
        // parseFloat('100junk') is 100 and clears every bound, while bcmath.bcnum
        // reads the same string as 0: admitting it puts two numbers in the round.
        submit('ws://peer:10001', [{ coinPair: 'BTC/USD', price: '100junk' }], round);
        expect(or.submissions.get(round).has('ws://peer:10001')).to.equal(false);
    });

    it('never lets a malformed price reach the persisted audit row', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map([['ws://peer:10001', 'bb'.repeat(32)]]);
        let persist = sinon.spy(or, '_persistSubmissions');
        submit('ws://peer:10001', [
            { coinPair: 'BTC/USD', price: '100junk' },
            { coinPair: 'LTC/USD', price: '90' }
        ], round, 'bb'.repeat(32));
        expect(persist.calledOnce).to.equal(true);
        let persisted = persist.firstCall.args[2].map(p => p.price);
        expect(persisted).to.deep.equal(['90']);
    });

    it('drops a non-scalar price a coercing gate would admit', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map();
        // parseFloat(['100']) is 100, so an array-valued price cleared the old gate.
        submit('ws://peer:10001', [{ coinPair: 'BTC/USD', price: ['100'] }], round);
        expect(or.submissions.get(round).has('ws://peer:10001')).to.equal(false);
    });

    it('keeps an honest bcformat price spelling byte-identical', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map();
        submit('ws://peer:10001', [{ coinPair: 'BTC/USD', price: '100000.00000000' }], round);
        let sub = or.submissions.get(round).get('ws://peer:10001');
        expect(sub).to.exist;
        expect(sub.prices[0].price).to.equal('100000.00000000');
    });

    it('keeps canonical pairs and strips only the bogus ones from a mixed submission', async function () {
        await or._executeRound();
        let round = or.currentRound;
        pm.validatorPubkeys = new Map();
        submit('ws://peer:10001', [
            { coinPair: 'BTC/ZZZ', price: '5' },
            { coinPair: 'LTC/USD', price: '90' }
        ], round);
        let sub = or.submissions.get(round).get('ws://peer:10001');
        expect(sub).to.exist;
        let pairs = sub.prices.map(p => p.coinPair);
        expect(pairs).to.deep.equal(['LTC/USD']);
    });
});
