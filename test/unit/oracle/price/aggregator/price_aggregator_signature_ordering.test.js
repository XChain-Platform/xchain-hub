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


    // Three price-qualified validators -> PBFT quorum max(2*floor(2/3)+1, ceil(4/2)) = 2
    const V = [makeValidator(), makeValidator(), makeValidator()];

    const PAIRS = [{ pair: 'BTC/USD', price: '50000' }];

    const GARBAGE_SIG = 'e'.repeat(128);


    // Build a round anchored at `btcHeight`, signing the payload the aggregator
    // itself would build for that anchor and this hub's network (the EQUIV header
    // gate also keys on the anchor, so the bytes differ either side of 961000; the
    // payload shape is pinned by the suite above, this block pins tally ordering).
    function roundAt(btcHeight, sigsFor) {
        let payload = agg._buildPriceV0Payload(5, 1700000000, PAIRS, btcHeight);
        return {
            round: 5,
            timestamp: 1700000000,
            btc_block_height: btcHeight,
            block_index: 800000,
            action_index: 42,
            pairs: PAIRS,
            sigs: sigsFor(payload)
        };
    }

function registerPriceaggregatorReceivevalidatedroundSignatureTallyOrdering1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        hub.network = 'mainnet';    // the only network where the gate has two sides
        agg = new PriceAggregator(hub);
        // Every height this block exercises (962999+) is at/above STAKE_WEIGHTED_QUORUM
        // on mainnet (961000), so the round finalizes on summed signer STAKE, exactly as
        // the indexer twin does at those heights. The weights are 50/50/1 over three
        // distinct sources so that the accept/reject verdict of each case below still
        // turns on WHICH signers the tally counted, which is this block's subject:
        // V[0]+V[1] clears the strict 2/3 bar (3*100 > 2*101) and any single signer
        // misses it. getSnapshot stays stubbed for the below-SWQ / unknown-network case.
        hub.capabilitySnapshot = {
            getSnapshot: sinon.stub().resolves({
                capability: 'price',
                blockIndex: 800000,
                count:      V.length,
                validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
            }),
            getWeightSnapshot: sinon.stub().resolves({
                capability:  'price',
                blockIndex:  800000,
                count:       V.length,
                sourceCount: V.length,
                validators: [
                    { pubkey: V[0].pubkey, source: 'src-0', weight: '50' },
                    { pubkey: V[1].pubkey, source: 'src-1', weight: '50' },
                    { pubkey: V[2].pubkey, source: 'src-2', weight: '1'  }
                ]
            })
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

function registerPriceaggregatorReceivevalidatedroundSignatureTallyOrdering1Tests1() {

    it('at/above the gate: a garbage sig ordered AHEAD of a member\'s real one still reaches quorum', async function () {
        let result = await agg.receiveValidatedRound('BTC', roundAt(963000, payload => [
            { pubkey: V[0].pubkey, sig: GARBAGE_SIG },     // slot-stealer, first on the wire
            { pubkey: V[0].pubkey, sig: V[0].sign(payload) },
            { pubkey: V[1].pubkey, sig: V[1].sign(payload) },
        ]));
        expect(result.accepted).to.equal(true);
    });

    it('at/above the gate: only the VERIFIED signature is stored as the proof', async function () {
        let stored = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) { stored = params; return {}; }
            return [];
        });
        await agg.receiveValidatedRound('BTC', roundAt(963000, payload => [
            { pubkey: V[0].pubkey, sig: GARBAGE_SIG },
            { pubkey: V[0].pubkey, sig: V[0].sign(payload) },
            { pubkey: V[1].pubkey, sig: V[1].sign(payload) },
        ]));
        let proof = JSON.stringify(stored);
        expect(proof).to.not.contain(GARBAGE_SIG,
            'the garbage entry must never ride into the stored consensus proof');
    });

    it('at/above the gate: a member with ONLY garbage entries still does not count', async function () {
        // V[0] contributes nothing verifiable, so only V[1] counts: 1 of quorum 2.
        let result = await agg.receiveValidatedRound('BTC', roundAt(963000, payload => [
            { pubkey: V[0].pubkey, sig: GARBAGE_SIG },
            { pubkey: V[0].pubkey, sig: GARBAGE_SIG },
            { pubkey: V[1].pubkey, sig: V[1].sign(payload) },
        ]));
        expect(result.accepted).to.equal(false);
        expect(result.reason).to.contain('insufficient signer stake (1 verified signers)');
    });

    it('at/above the gate: a repeated VALID member still counts exactly once', async function () {
        let result = await agg.receiveValidatedRound('BTC', roundAt(963000, payload => [
            { pubkey: V[0].pubkey, sig: V[0].sign(payload) },
            { pubkey: V[0].pubkey, sig: V[0].sign(payload) },
        ]));
        expect(result.accepted).to.equal(false);
        expect(result.reason).to.contain('insufficient signer stake (1 verified signers)');
    });
}

function registerPriceaggregatorReceivevalidatedroundSignatureTallyOrdering1Tests5() {

    it('below the gate: the legacy mark-then-verify verdict is preserved verbatim', async function () {
        let result = await agg.receiveValidatedRound('BTC', roundAt(962999, payload => [
            { pubkey: V[0].pubkey, sig: GARBAGE_SIG },
            { pubkey: V[0].pubkey, sig: V[0].sign(payload) },
            { pubkey: V[1].pubkey, sig: V[1].sign(payload) },
        ]));
        expect(result.accepted).to.equal(false);
        expect(result.reason).to.contain('insufficient signer stake (1 verified signers)',
            'below the flag-day the garbage entry must still consume V[0]\'s dedupe slot');
    });

    it('fails closed on a hub with no network: legacy ordering, never a unilateral flip', async function () {
        // A hub that cannot resolve its own network must not be the one node in the
        // federation tallying under the new rule.
        hub.network = undefined;
        let result = await agg.receiveValidatedRound('BTC', roundAt(999999999, payload => [
            { pubkey: V[0].pubkey, sig: GARBAGE_SIG },
            { pubkey: V[0].pubkey, sig: V[0].sign(payload) },
            { pubkey: V[1].pubkey, sig: V[1].sign(payload) },
        ]));
        expect(result.accepted).to.equal(false);
        expect(result.reason).to.contain('insufficient quorum (1/2)');
    });

}

describe('PriceAggregator.receiveValidatedRound() signature-tally ordering flag-day', function () {
    registerPriceaggregatorReceivevalidatedroundSignatureTallyOrdering1Hooks();
    registerPriceaggregatorReceivevalidatedroundSignatureTallyOrdering1Tests1();
    registerPriceaggregatorReceivevalidatedroundSignatureTallyOrdering1Tests5();
});
