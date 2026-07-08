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

    function submit(sender, prices, round) {
        or._handleMessage({
            type: 'ORACLE_PRICE_SUBMIT',
            sender,
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

        submit('ws://forged-sender-xyz:10001', [{ coinPair: 'BTC/USD', price: '1' }], round);

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

        submit('ws://real-peer:10001', [{ coinPair: 'BTC/USD', price: '100001' }], round);

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
