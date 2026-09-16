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

const crypto           = require('crypto');
const sinon            = require('sinon');
const { expect }       = require('chai');
const PriceAggregator  = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');

// Mirror of the canonical PRICE v0 payload (xchain-indexer/src/consensus/ed25519.js)
// buildPriceV0Payload. Tests sign these exact bytes. The mockHub has no `network`,
// so the EQUIV header is OFF (unknown network) and this is the bare-JSON branch;
// btc_block_height still rides in the signed content (#4232).
function buildPriceV0Payload(round, timestamp, pairs, btcBlockHeight) {
    let sortedPairs = pairs
        .map(p => ({ pair: p.pair, price: String(p.price) }))
        .sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
    return JSON.stringify({
        round:            parseInt(round),
        timestamp:        parseInt(timestamp),
        btc_block_height: parseInt(btcBlockHeight),
        pairs:            sortedPairs
    });
}

// Generate a real Ed25519 validator keypair: { pubkey (64-hex), sign(payload) → 128-hex }
function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}



    let hub, agg;


    // Five price-qualified validators -> count quorum max(2*floor(4/3)+1, ceil(6/2)) = 3.
    // Stake is deliberately lopsided: the first two sources hold 45 each of S=100, so
    // TWO signers clear the strict 2/3 stake bar (3*90 > 2*100) while missing the
    // 3-signature count bar, and the three small sources together (30) clear the count
    // bar while missing the stake bar (3*30 < 2*100). The two rules genuinely disagree.
    const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator(), makeValidator()];

    const WEIGHTS = ['45', '45', '4', '3', '3'];

    const PAIRS = [{ pair: 'BTC/USD', price: '50000' }];


    const ABOVE = 962000;
   // >= STAKE_WEIGHTED_QUORUM mainnet (961000)
    const BELOW = 960999;
   // <  STAKE_WEIGHTED_QUORUM mainnet

    function roundAt(btcHeight, signers) {
        let payload = agg.buildPriceV0Payload(5, 1700000000, PAIRS, btcHeight);
        return {
            round: 5,
            timestamp: 1700000000,
            btc_block_height: btcHeight,
            block_index: 800000,
            action_index: 42,
            pairs: PAIRS,
            sigs: signers.map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
        };
    }


    function countSnapshot() {
        return {
            capability: 'price', blockIndex: 800000, count: V.length,
            validators: V.map(v => ({ pubkey: v.pubkey, amount: '100.00000000' }))
        };
    }


    function weightSnapshot(extra) {
        return Object.assign({
            capability: 'price', blockIndex: 800000, count: V.length, sourceCount: V.length,
            validators: V.map((v, i) => ({ pubkey: v.pubkey, source: 'src-' + i, weight: WEIGHTS[i] }))
        }, extra || {});
    }

function registerPriceaggregatorReceivevalidatedroundStakeWeightedQuorum1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        hub.network = 'mainnet';    // the only network where the gate has two sides
        agg = new PriceAggregator(hub);
        hub.capabilitySnapshot = {
            getSnapshot:       sinon.stub().resolves(countSnapshot()),
            getWeightSnapshot: sinon.stub().resolves(weightSnapshot())
        };
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            return [];
        });
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerPriceaggregatorReceivevalidatedroundStakeWeightedQuorum1Tests1() {

    it('at/above the gate: accepts two high-stake signers that the COUNT quorum would reject', async function () {
        let result = await agg.receiveValidatedRound('BTC', roundAt(ABOVE, [V[0], V[1]]));
        expect(result).to.deep.equal({ accepted: true });
        // The weight snapshot is the one resolved, keyed on the round's block_index
        // (the block the PRICE landed in), exactly as the indexer twin keys its weights.
        expect(hub.capabilitySnapshot.getWeightSnapshot.calledOnceWith('price', 800000)).to.equal(true);
        expect(hub.capabilitySnapshot.getSnapshot.called).to.equal(false);
    });

    it('at/above the gate: rejects a count-quorate round that misses the stake bar', async function () {
        let result = await agg.receiveValidatedRound('BTC', roundAt(ABOVE, [V[2], V[3], V[4]]));
        expect(result.accepted).to.equal(false);
        expect(result.reason).to.contain('insufficient signer stake');
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('at/above the gate: fails closed when the weight snapshot is unresolvable (never falls back to count)', async function () {
        hub.capabilitySnapshot.getWeightSnapshot.resolves(null);
        // These same three signers clear the count quorum, so a fallback would accept.
        let result = await agg.receiveValidatedRound('BTC', roundAt(ABOVE, [V[0], V[1], V[2]]));
        expect(result).to.deep.equal({ accepted: false, reason: 'validator snapshot unavailable' });
        expect(hub.capabilitySnapshot.getSnapshot.called).to.equal(false);
    });

    it('at/above the gate: fails closed on a TRUNCATED weight snapshot (dropped sources under-count S)', async function () {
        hub.capabilitySnapshot.getWeightSnapshot.resolves(weightSnapshot({ truncated: true }));
        let result = await agg.receiveValidatedRound('BTC', roundAt(ABOVE, [V[0], V[1]]));
        expect(result).to.deep.equal({ accepted: false, reason: 'validator snapshot truncated' });
    });

    it('at/above the gate: fails closed when the hub cannot resolve a weight snapshot at all', async function () {
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(countSnapshot()) };
        let result = await agg.receiveValidatedRound('BTC', roundAt(ABOVE, [V[0], V[1], V[2]]));
        expect(result).to.deep.equal({ accepted: false, reason: 'validator snapshot unavailable' });
    });

    it('below the gate: the legacy count quorum is preserved byte-for-byte', async function () {
        let two = await agg.receiveValidatedRound('BTC', roundAt(BELOW, [V[0], V[1]]));
        expect(two).to.deep.equal({ accepted: false, reason: 'insufficient quorum (2/3)' });

        let three = await agg.receiveValidatedRound('BTC', roundAt(BELOW, [V[2], V[3], V[4]]));
        expect(three).to.deep.equal({ accepted: true });
        expect(hub.capabilitySnapshot.getWeightSnapshot.called).to.equal(false);
        expect(hub.capabilitySnapshot.getSnapshot.calledWith('price', 800000)).to.equal(true);
    });

    it('a hub that cannot resolve its own network stays on the legacy count rule', async function () {
        hub.network = undefined;
        let result = await agg.receiveValidatedRound('BTC', roundAt(999999999, [V[0], V[1]]));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (2/3)' });
        expect(hub.capabilitySnapshot.getWeightSnapshot.called).to.equal(false);
    });

}

describe('PriceAggregator.receiveValidatedRound() stake-weighted quorum flag-day', function () {
    registerPriceaggregatorReceivevalidatedroundStakeWeightedQuorum1Hooks();
    registerPriceaggregatorReceivevalidatedroundStakeWeightedQuorum1Tests1();
});
