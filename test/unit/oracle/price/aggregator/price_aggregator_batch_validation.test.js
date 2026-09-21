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
// The canonical payload itself is pinned elsewhere (price_v0_batch_canonical_parity.test.js
// asserts all three buildPriceBatchPayload implementations are byte-identical, including
// the OracleConsensus and PriceAggregator production twins), so these tests sign whatever
// that builder emits and pin what INGEST does
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

    it('re-emits every stored row on the WS mirror stream in the v0 row shape', async function () {
        stubDb([]);
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        await agg.receiveValidatedBatch('BTC', makeBatch());

        expect(events.length).to.equal(12);
        expect(events.every(e => e.table === 'price_snapshots')).to.equal(true);
        let first = events[0].row;
        expect(Object.keys(first)).to.deep.equal([
            'round_number', 'coin_pair', 'price', 'reference_block', 'reference_chain',
            'block_timestamp', 'validator_count', 'consensus_round', 'consensus_proof',
            'status', 'source_chain', 'source_action_index', 'push_generation',
            'batch_block_time', 'created_at', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'
        ]);
        // A legacy round (every round below the activation) mirrors NULL admission columns.
        expect([first.admit_block_btc, first.admit_block_ltc, first.admit_block_doge]).to.deep.equal([null, null, null]);
        // The landing clock is the LANDING BLOCK's own time, which is neither the round's
        // pricing timestamp nor a height: that distinction is the only reason the column
        // exists, so assert it here rather than only that the key is present.
        expect(first.batch_block_time).to.equal(BLOCK_TIME);
        expect(first.batch_block_time).to.not.equal(BLOCK_INDEX);
        expect(first.batch_block_time).to.not.equal(first.block_timestamp);
        expect(first.round_number).to.equal(100);
        expect(first.status).to.equal('finalized');
        expect(first.consensus_round).to.equal(1);
        expect(first.validator_count).to.equal(3);
    });

    // ---- Whole-batch rejection: signatures and structure are atomic ----

    it('rejects the WHOLE batch when the signature set is short of quorum, storing nothing', async function () {
        let inserts = stubDb([]);
        let batch   = makeBatch({ signers: V.slice(0, 2) });   // 2 of 4, quorum is 3

        let result = await agg.receiveValidatedBatch('BTC', batch);

        expect(result.accepted).to.equal(false);
        expect(result.stored).to.equal(0);
        expect(result.duplicates).to.equal(0);
        expect(result.rejected).to.equal(6);
        expect(result.reason).to.match(/insufficient quorum/);
        expect(inserts.length).to.equal(0);
    });
}

function registerPriceaggregatorReceivevalidatedbatch1Tests3() {

    it('rejects the WHOLE batch when one round was tampered with after signing', async function () {
        let inserts = stubDb([]);
        let rounds  = makeRounds();
        let sigs    = signBatch(rounds);
        rounds[3].pairs[0].price = '99999';           // repriced after the validators signed

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({ rounds, sigs }));

        expect(result.accepted).to.equal(false);
        expect(result.rejected).to.equal(6);
        expect(inserts.length).to.equal(0);
    });

    it('rejects a batch whose rounds are not strictly ascending, or fall outside the declared window', async function () {
        let inserts = stubDb([]);

        let dupRounds = makeRounds();
        dupRounds[2].round = dupRounds[1].round;      // repeated round number
        let r1 = await agg.receiveValidatedBatch('BTC', makeBatch({ rounds: dupRounds }));
        expect(r1.accepted).to.equal(false);
        expect(r1.reason).to.match(/ascending/);

        let outside = makeRounds();
        outside[5].round = LAST_ROUND + 9;            // beyond last_round
        let r2 = await agg.receiveValidatedBatch('BTC', makeBatch({ rounds: outside }));
        expect(r2.accepted).to.equal(false);
        expect(r2.reason).to.match(/outside window/);

        expect(inserts.length).to.equal(0);
    });

    it('rejects a batch with an empty round list, a bad window or a missing block_time', async function () {
        stubDb([]);
        let empty = await agg.receiveValidatedBatch('BTC', makeBatch({ rounds: [] }));
        expect(empty).to.deep.equal({ accepted: false, stored: 0, duplicates: 0, rejected: 0, reason: 'invalid batchData' });

        let inverted = await agg.receiveValidatedBatch('BTC', makeBatch({ first_round: 200 }));
        expect(inverted.accepted).to.equal(false);
        expect(inverted.reason).to.equal('invalid round window');

        let noTime = await agg.receiveValidatedBatch('BTC', makeBatch({ block_time: undefined }));
        expect(noTime.accepted).to.equal(false);
        expect(noTime.reason).to.equal('invalid block_time');

        // A coerced-to-zero block_time would read as "before every flag day"; refused.
        let zeroTime = await agg.receiveValidatedBatch('BTC', makeBatch({ block_time: 0 }));
        expect(zeroTime.reason).to.equal('invalid block_time');
    });
}

describe('PriceAggregator.receiveValidatedBatch()', function () {
    registerPriceaggregatorReceivevalidatedbatch1Hooks();
    registerPriceaggregatorReceivevalidatedbatch1Tests1();
    registerPriceaggregatorReceivevalidatedbatch1Tests3();
});
