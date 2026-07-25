/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/DerivedPairs.test.js
 *
 * DERIVED_PAIRS admission allow-list (, spec step 3d).
 *
 * XCHAIN is listed on no exchange, so its USD price is derived from
 * platform-realized fills rather than fetched. That makes it absent from
 * PriceFetcher.getCoinPairs(), which is exactly the set the canonical-pair
 * whitelist is built from - so without this allow-list the pair reads as
 * FABRICATED, and a fabricated pair does not merely get dropped: peer-submission
 * ingest filters it out and the PROPOSE gate withholds co-sign on the WHOLE round,
 * stalling all 36 pairs federation-wide.
 *
 * The distinction this file pins is ADMIT vs PRODUCE. Widening what a hub accepts
 * must not widen what it publishes or what it reports as a dropped pair.
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');
const OracleConsensus = require('../../src/OracleConsensus');

const { DERIVED_PAIRS } = require('../../src/constants.js');
const PriceFetcher      = require('../../src/PriceFetcher.js');

describe('DERIVED_PAIRS admission allow-list @regression', function () {

    let hub, or, OracleRound;

    beforeEach(function () {
        OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher': function () { return { fetchPrices: sinon.stub().resolves([]) }; }
        });
        hub = createMockHub({ p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' } });
        or  = new OracleRound(hub);
    });

    afterEach(function () { sinon.restore(); });

    describe('the constant', function () {
        it('is exactly the XCHAIN/USD pair', function () {
            expect(DERIVED_PAIRS).to.deep.equal(['XCHAIN/USD']);
        });

        it('names a pair the fee path actually asks for', function () {
            // xchain-indexer utility.getFeeOraclePrices looks up this literal beside
            // <COIN>/USD. A typo here is a pair nothing consumes.
            expect(DERIVED_PAIRS[0]).to.equal('XCHAIN/USD');
        });
    });

    describe('admit vs produce', function () {
        it('is NOT in the produced set, so no hub starts submitting it', function () {
            // getCoinPairs() drives fetching and the skipped-row markers. The derived
            // pair has no API source, so it must stay out until the derived source
            // lands (spec step 2); this constant is permissive only.
            expect(PriceFetcher.getCoinPairs()).to.not.include('XCHAIN/USD');
        });

        it('IS in the admission whitelist, so ingest and co-sign accept it', function () {
            expect(or.canonicalPairs.has('XCHAIN/USD')).to.equal(true);
        });

        it('keeps every one of the 36 API pairs admissible', function () {
            // The union must be additive. Losing a pair here would drop it on ingest
            // and withhold co-sign on every round carrying it.
            const produced = PriceFetcher.getCoinPairs();
            expect(produced.length).to.equal(36);
            for (const pair of produced)
                expect(or.canonicalPairs.has(pair), pair + ' must stay admissible').to.equal(true);
        });

        it('admits exactly the produced set plus the derived pairs, nothing else', function () {
            expect(or.canonicalPairs.size).to.equal(PriceFetcher.getCoinPairs().length + DERIVED_PAIRS.length);
            expect(or.canonicalPairs.has('BTC/ZZZ')).to.equal(false);
            expect(or.canonicalPairs.has('XCHAIN/EUR')).to.equal(false);
        });

        it('does not admit a near-miss of the derived pair', function () {
            // The whitelist is exact-membership, not a prefix or ticker match, so a
            // Byzantine leader cannot ride the derived entry into other XCHAIN pairs.
            for (const near of ['XCHAIN/GBP', 'XCHAIN.SUB/USD', 'xchain/usd', 'XCHAIN/USDT'])
                expect(or.canonicalPairs.has(near), near).to.equal(false);
        });
    });

    describe('the whitelist the PROPOSE gate reads', function () {
        it('is the same Set object OracleConsensus consults', function () {
            // OracleConsensus reads this.oracleRound.canonicalPairs specifically so the
            // ingest and co-sign views cannot drift. If this stops being one shared Set,
            // a pair could be ingestable but not co-signable, which withholds the round.
            expect(or.canonicalPairs).to.be.instanceOf(Set);
            expect(or.canonicalPairs.size).to.be.greaterThan(0);
        });

        it('is non-empty, so the gate never falls back to fail-open', function () {
            // OracleConsensus treats an empty/absent whitelist as "skip the membership
            // check" so a stale source cannot freeze honest followers. A silently empty
            // Set here would therefore disable fabricated-pair rejection entirely.
            expect(or.canonicalPairs.size).to.equal(37);
        });
    });

    // The claim the allow-list exists to support, driven through the real gate rather
    // than asserted about the Set: a follower must stop calling the derived pair
    // fabricated. The companion case proves the rollout hazard is not hypothetical.
    describe('through the real PROPOSE co-sign gate', function () {
        const ROUND = 1;
        let oc, leader, pm, gateHub;

        function build(canonicalPairs) {
            gateHub = createMockHub();
            pm = gateHub._peerManager;
            pm.validatorPubkeys = new Set();          // size 0 -> any sender is known
            const oracleRound = { getSubmissions: sinon.stub().returns(new Map()), canonicalPairs };
            oc = new OracleConsensus(gateHub, oracleRound);
            oc.setValidatorSet(VALIDATORS_3);
            leader = oc._getLeader(ROUND);
            pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: pm.validatorAddr, prices: [
                    { coinPair: 'BTC/USD',    price: '100000' },
                    { coinPair: 'XCHAIN/USD', price: '2.00000000' },   // this follower derived it too
                ] }
            ]));
        }

        function propose(prices) {
            return { sender: leader.addr, data: {
                round: ROUND, prices, digest: oc._digest(ROUND, prices),
                btcBlockHeight: 100, btcBlockTime: 1700000000
            } };
        }

        it('no longer calls XCHAIN/USD a fabricated pair', async function () {
            build(new Set([...PriceFetcher.getCoinPairs(), ...DERIVED_PAIRS]));
            const rejects = [];
            oc.on('oracle:propose-rejected', e => rejects.push(e));
            await oc._handlePropose(propose([
                { coinPair: 'BTC/USD',    price: '100000' },
                { coinPair: 'XCHAIN/USD', price: '2.00000000' },
            ]));
            expect(rejects.filter(e => e.reason === 'non-canonical-pair')).to.deep.equal([]);
        });

        it('an un-upgraded hub rejects the SAME proposal, taking BTC/USD down with it', async function () {
            // This is the deploy-ordering constraint made concrete. The whitelist is the
            // only difference between the two cases, and _handlePropose returns on the
            // first rejection, so the whole round is withheld - BTC/USD included - not
            // just the pair the hub does not recognize. Widen every hub BEFORE any
            // leader proposes the pair.
            build(new Set(PriceFetcher.getCoinPairs()));
            const rejects = [];
            oc.on('oracle:propose-rejected', e => rejects.push(e));
            await oc._handlePropose(propose([
                { coinPair: 'BTC/USD',    price: '100000' },
                { coinPair: 'XCHAIN/USD', price: '2.00000000' },
            ]));
            expect(rejects.map(e => e.reason)).to.include('non-canonical-pair');
            expect(rejects[rejects.length - 1].coinPair).to.equal('XCHAIN/USD');
        });
    });
});
