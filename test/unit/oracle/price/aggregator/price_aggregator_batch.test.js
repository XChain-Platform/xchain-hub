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
// PRICE v0 (batch) ingest: PriceAggregator.receiveValidatedBatch, spec
// spec section 5.7, decisions D8, D13, D14, D23, D28.
//
// The canonical payload itself is pinned elsewhere (priceV2PayloadTwinParity.test.js
// asserts buildPriceBatchPayload is byte-identical to the indexer and OracleConsensus
// twins), so these tests sign whatever that builder emits and pin what INGEST does
// with a batch: per-round dedupe, column semantics, the block_time-keyed pair flag
// day, the WS mirror re-emit, the reorg fence and the publisher marker clear.

const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');
const { CANONICAL_REORG_BUFFER } = require('../../../../../src/consensus/snapshot_reorg_buffer.js');
// The pair-name flag day's own map. Every shipped network is genesis-on since the
// 2026-09-09 ruling, so the D14 case below straddles a threshold it installs itself.
const { PRICE_PAIR_WIDEN_ACTIVATION } = require('../../../../../src/consensus/gates/price_pair_gate.js');

// Generate a real Ed25519 validator keypair: { pubkey (64-hex), sign(payload) -> 128-hex }
function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}



    // Four price-qualified validators -> PBFT quorum 2*floor(3/3)+1 = 3
    const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];


    const FIRST_ROUND  = 100;

    const LAST_ROUND   = 105;

    const BATCH_ANCHOR = 799005;
      // the BATCH's BTC anchor: every flag day resolves on this
    const BLOCK_INDEX  = 800000;
      // the LANDING block on the landing chain (D8)
    const ACTION_INDEX = 42;

    const BLOCK_TIME   = 1700004000;
  // the landing block's own clock (D14)

    // Six full-body rounds, each with its own timestamp, its own BTC anchor and its
    // own pairs. BATCH_ANCHOR equals the LAST round's anchor because §4 requires it,
    // and it stays different from the other five and from BLOCK_INDEX, so a test that
    // confuses the batch anchor with a per-round anchor or with the landing block is
    // still visible.
    function makeRounds() {
        let out = [];
        for (let i = 0; i < 6; i++) {
            out.push({
                round:            FIRST_ROUND + i,
                timestamp:        1700000000 + (i * 600),
                btc_block_height: 799000 + i,
                pairs: [
                    { pair: 'BTC/USD', price: String(50000 + i) },
                    { pair: 'LTC/USD', price: String(80 + i) }
                ]
            });
        }
        return out;
    }


    let hub, agg;


    // The canonical the validators sign: exactly the bytes the aggregator rebuilds.
    function signBatch(rounds, signers = V.slice(0, 3), overrides = {}) {
        let payload = agg.buildPriceBatchPayload(
            overrides.first_round      !== undefined ? overrides.first_round      : FIRST_ROUND,
            overrides.last_round       !== undefined ? overrides.last_round       : LAST_ROUND,
            overrides.btc_block_height !== undefined ? overrides.btc_block_height : BATCH_ANCHOR,
            rounds.map(r => ({ round: r.round, timestamp: r.timestamp,
                               btcBlockHeight: r.btc_block_height, pairs: r.pairs }))
        );
        return signers.map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }));
    }


    function makeBatch(overrides = {}) {
        let rounds = overrides.rounds || makeRounds();
        let batch = {
            first_round:      FIRST_ROUND,
            last_round:       LAST_ROUND,
            btc_block_height: BATCH_ANCHOR,
            rounds:           rounds,
            block_time:       BLOCK_TIME,
            action_index:     ACTION_INDEX,
            block_index:      BLOCK_INDEX,
            push_generation:  0,
            ...overrides
        };
        if (batch.sigs === undefined) batch.sigs = signBatch(rounds, overrides.signers);
        return batch;
    }


    function snapshotOf(validators) {
        return {
            capability: 'price',
            blockIndex: BLOCK_INDEX,
            count:      validators.length,
            validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
        };
    }


    // doQuery stub. `finalizedRounds` names round_numbers that already have a
    // non-'skipped' row, i.e. the dedupe SELECT hits for them.
    function stubDb(finalizedRounds = []) {
        let inserts = [];
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id FROM price_snapshots/.test(sql))
                return finalizedRounds.includes(params[0]) ? [{ id: 7 }] : [];
            if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); return {}; }
            return [];
        });
        return inserts;
    }


    // Decode one multi-row INSERT's flat params back into per-row objects, in the
    // column order the statement declares.
    // The three admission columns ride LAST, after created_at, so every positional reader
    // of the INSERT keeps its index; a legacy round writes them as NULL, never 0.
    const COLS = ['round_number', 'coin_pair', 'price', 'reference_block', 'reference_chain',
                  'block_timestamp', 'validator_count', 'consensus_proof', 'source_chain',
                  'source_action_index', 'push_generation', 'batch_block_time', 'created_at',
                  'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];

    function decodeInsert(params) {
        let rows = [];
        for (let i = 0; i < params.length; i += COLS.length) {
            let row = {};
            COLS.forEach((c, j) => { row[c] = params[i + j]; });
            rows.push(row);
        }
        return rows;
    }


    // ---- §4: the header anchor is constrained to the LAST round's own anchor ----

    // THE ATTACK, driven end to end. Both quorum gates resolve on the header anchor
    // and the straddle rule inspects only the per-round anchors, so an unconstrained
    // header lets a colluding signing quorum choose WHICH consensus rule judges its
    // own batch. Below, four validators hold wildly uneven stake: two of them are 2
    // signatures short of the count quorum of 3, but carry ~99.999% of the stake, so
    // the same batch is refused under the count rule and accepted under the
    // stake-weighted one. The per-round anchors sit honestly below mainnet's
    // stake-weighted gate (961000); only the HEADER claims to be above it.
    const ATTACK_ROUND_ANCHOR = 960990;
   // rounds 960990..960995, all below the gate
    const ATTACK_HEADER       = 961500;
   // the header alone claims the far side

    function attackRounds() {
        return makeRounds().map((r, i) => ({ ...r, btc_block_height: ATTACK_ROUND_ANCHOR + i }));
    }


    // A weight snapshot the two colluding signers dominate: 3*200000 > 2*200002.
    function stakeSnapshotOf(validators) {
        return {
            capability: 'price',
            blockIndex: BLOCK_INDEX,
            count:      validators.length,
            validators: validators.map((v, i) => ({
                pubkey: v.pubkey, source: 'src' + i, weight: i < 2 ? '100000' : '1'
            }))
        };
    }


    // ---- The validator snapshot resolves on the BATCH'S SIGNED BTC ANCHOR ----
    //
    // Capability staking is Bitcoin-only, so the qualifying set is BTC-anchored for
    // every chain: the hub asks the BTC indexer at a BTC height, and the indexer twin
    // reads the mirrored capability_snapshots whose snapshot_block IS a BTC height.
    // Resolving on the landing block instead made the hub agree with the chain only on
    // Bitcoin, where the two heights are the same number. Measured on a live Dogecoin
    // regtest federation: three of three batches validated on chain, all three refused
    // here as 'validator snapshot unavailable', and not one round rebuilt.
    //
    // A resolver keyed on a BTC height, exactly as the real CapabilitySnapshot is: it
    // answers only for the batch anchor and refuses anything else, so a landing-chain
    // height gets the null the live hub got.
    function btcKeyedSnapshotResolver(anchor, validators) {
        return sinon.stub().callsFake(async (capability, blockIndex) => {
            if (capability !== 'price' || Number(blockIndex) !== anchor) return null;
            return { ...snapshotOf(validators), blockIndex: anchor };
        });
    }


    // A Dogecoin landing height, of the order the live run measured: far above the BTC
    // regtest tip and naming no BTC block at all.
    const DOGE_LANDING_BLOCK = 2784;

function registerPriceaggregatorReceivevalidatedbatch1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(snapshotOf(V)) };
        sinon.stub(console, 'log');
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerPriceaggregatorReceivevalidatedbatch1Tests1() {

    // ---- D13: per-round dedupe, the defect this row exists to prevent ----

    it('stores the five good rounds of a six-round batch when ONE round is already finalized (D13)', async function () {
        let inserts = stubDb([102]);                 // round 102 already has a finalized row
        let events  = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveValidatedBatch('BTC', makeBatch());

        expect(result).to.deep.equal({ accepted: true, stored: 5, duplicates: 1, rejected: 0 });

        // Five INSERTs, one per stored round, and NONE for the deduped round.
        expect(inserts.length).to.equal(5);
        let storedRounds = inserts.map(p => decodeInsert(p)[0].round_number);
        expect(storedRounds).to.deep.equal([100, 101, 103, 104, 105]);

        // The whole-call early return this replaces would have lost five rounds no
        // other action carries.
        expect(storedRounds).to.not.include(102);
        expect(events.length).to.equal(10);          // 5 rounds x 2 pairs, on the WS mirror stream
    });

    it('stores every round when none is a duplicate, and reports zero duplicates', async function () {
        let inserts = stubDb([]);
        let result  = await agg.receiveValidatedBatch('BTC', makeBatch());
        expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        expect(inserts.length).to.equal(6);
    });

    it('accepts a fully-duplicate re-push without storing anything (failover double-publish)', async function () {
        let inserts = stubDb([100, 101, 102, 103, 104, 105]);
        let result  = await agg.receiveValidatedBatch('BTC', makeBatch());
        expect(result).to.deep.equal({ accepted: true, stored: 0, duplicates: 6, rejected: 0 });
        expect(inserts.length).to.equal(0);
    });
}

function registerPriceaggregatorReceivevalidatedbatch1Tests4() {

    // ---- Column semantics (D8, D23) ----

    it('writes the ROUND timestamp as block_timestamp and the PUSH block_index as reference_block (D8)', async function () {
        let inserts = stubDb([]);
        let rounds  = makeRounds();

        await agg.receiveValidatedBatch('BTC', makeBatch({ rounds }));

        expect(inserts.length).to.equal(6);
        inserts.forEach((params, i) => {
            let rows = decodeInsert(params);
            rows.forEach(row => {
                // block_timestamp is the ROUND's own timestamp, the field the fee path reads
                expect(row.block_timestamp, 'round ' + rounds[i].round + ' block_timestamp')
                    .to.equal(rounds[i].timestamp);
                // reference_block is the LANDING block, identical to the v0 ingest path,
                // and NOT the round's BTC anchor: two consensus readers read this column
                // and a v2 row that differed here would fork them.
                expect(row.reference_block, 'round ' + rounds[i].round + ' reference_block')
                    .to.equal(BLOCK_INDEX);
                expect(row.reference_block).to.not.equal(rounds[i].btc_block_height);
                expect(row.reference_block).to.not.equal(BATCH_ANCHOR);
                expect(row.source_chain).to.equal('BTC');
                expect(row.source_action_index).to.equal(ACTION_INDEX);
            });
        });
    });

    it('writes consensus_proof as {batch:{first_round,last_round,btc_block_height},sigs:[...]} in that key order (D23)', async function () {
        let inserts = stubDb([]);
        let batch   = makeBatch();

        await agg.receiveValidatedBatch('BTC', batch);

        let proof = decodeInsert(inserts[0])[0].consensus_proof;
        // Byte-exact, because a cross-node comparison of the SERIALIZED value is part
        // of the acceptance test: a reordering reads as a mismatch on identical content.
        let expected = JSON.stringify({
            batch: { first_round: FIRST_ROUND, last_round: LAST_ROUND, btc_block_height: BATCH_ANCHOR },
            sigs:  batch.sigs.map(s => ({ pubkey: s.pubkey.toLowerCase(), sig: s.sig.toLowerCase() }))
        });
        expect(proof).to.equal(expected);
        expect(proof.indexOf('{"batch":{"first_round":')).to.equal(0);
        // Every round of the batch carries the SAME proof: one signature set, one window.
        inserts.forEach(p => decodeInsert(p).forEach(row => expect(row.consensus_proof).to.equal(proof)));
    });
}

describe('PriceAggregator.receiveValidatedBatch()', function () {
    registerPriceaggregatorReceivevalidatedbatch1Hooks();
    registerPriceaggregatorReceivevalidatedbatch1Tests1();
    registerPriceaggregatorReceivevalidatedbatch1Tests4();
});
