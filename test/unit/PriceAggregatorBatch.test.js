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
// asserts _buildPriceBatchPayload is byte-identical to the indexer and OracleConsensus
// twins), so these tests sign whatever that builder emits and pin what INGEST does
// with a batch: per-round dedupe, column semantics, the block_time-keyed pair flag
// day, the WS mirror re-emit, the reorg fence and the publisher marker clear.

const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../src/PriceAggregator');
const { createMockHub } = require('../helpers/mockHub');
const { CANONICAL_REORG_BUFFER } = require('../../src/snapshot_reorg_buffer.js');

// Generate a real Ed25519 validator keypair: { pubkey (64-hex), sign(payload) -> 128-hex }
function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}

describe('PriceAggregator.receiveValidatedBatch()', function () {

    // Four price-qualified validators -> PBFT quorum 2*floor(3/3)+1 = 3
    const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];

    const FIRST_ROUND  = 100;
    const LAST_ROUND   = 105;
    const BATCH_ANCHOR = 799005;      // the BATCH's BTC anchor: every flag day resolves on this
    const BLOCK_INDEX  = 800000;      // the LANDING block on the landing chain (D8)
    const ACTION_INDEX = 42;
    const BLOCK_TIME   = 1700004000;  // the landing block's own clock (D14)

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
        let payload = agg._buildPriceBatchPayload(
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
    const COLS = ['round_number', 'coin_pair', 'price', 'reference_block', 'reference_chain',
                  'block_timestamp', 'validator_count', 'consensus_proof', 'source_chain',
                  'source_action_index', 'push_generation', 'created_at'];
    function decodeInsert(params) {
        let rows = [];
        for (let i = 0; i < params.length; i += COLS.length) {
            let row = {};
            COLS.forEach((c, j) => { row[c] = params[i + j]; });
            rows.push(row);
        }
        return rows;
    }

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(snapshotOf(V)) };
        sinon.stub(console, 'log');
    });

    afterEach(function () {
        sinon.restore();
    });

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
            'status', 'source_chain', 'source_action_index', 'push_generation', 'created_at'
        ]);
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

    it('rejects a batch whose first and last rounds straddle an armed oracle flag day (D7)', async function () {
        hub.network = 'mainnet';                      // sig-tally 963000, stake-weighted 961000
        let inserts = stubDb([]);
        let rounds  = makeRounds();
        rounds[0].btc_block_height = 960999;          // below stake-weighted quorum
        rounds[5].btc_block_height = 961001;          // above it
        // The header anchor tracks the last round, so the straddle rule is what fires
        // here rather than the anchor check that precedes it.
        let sigs = signBatch(rounds, V.slice(0, 3), { btc_block_height: 961001 });

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({ rounds, sigs, btc_block_height: 961001 }));

        expect(result.accepted).to.equal(false);
        expect(result.reason).to.match(/straddles/);
        expect(inserts.length).to.equal(0);
    });

    // ---- §4: the header anchor is constrained to the LAST round's own anchor ----

    // THE ATTACK, driven end to end. Both quorum gates resolve on the header anchor
    // and the straddle rule inspects only the per-round anchors, so an unconstrained
    // header lets a colluding signing quorum choose WHICH consensus rule judges its
    // own batch. Below, four validators hold wildly uneven stake: two of them are 2
    // signatures short of the count quorum of 3, but carry ~99.999% of the stake, so
    // the same batch is refused under the count rule and accepted under the
    // stake-weighted one. The per-round anchors sit honestly below mainnet's
    // stake-weighted gate (961000); only the HEADER claims to be above it.
    const ATTACK_ROUND_ANCHOR = 960990;   // rounds 960990..960995, all below the gate
    const ATTACK_HEADER       = 961500;   // the header alone claims the far side

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

    it('refuses a batch whose header anchor is not the last round anchor, before either quorum gate resolves', async function () {
        hub.network = 'mainnet';                      // stake-weighted 961000, sig-tally 963000
        let inserts = stubDb([]);
        let weightSnap = sinon.stub().resolves(stakeSnapshotOf(V));
        hub.capabilitySnapshot = {
            getSnapshot:       sinon.stub().resolves(snapshotOf(V)),
            getWeightSnapshot: weightSnap
        };

        let rounds = attackRounds();
        // Otherwise perfect: the quorum really signed this header, so nothing but the
        // anchor rule can tell the batch apart from an honest one.
        let sigs = signBatch(rounds, V.slice(0, 2), { btc_block_height: ATTACK_HEADER });

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({
            rounds, sigs, btc_block_height: ATTACK_HEADER
        }));

        expect(result.accepted).to.equal(false);
        expect(result.reason).to.equal('batch anchor does not match the last round');
        expect(result.stored).to.equal(0);
        expect(result.rejected).to.equal(6);
        expect(inserts.length).to.equal(0);
        // The check has to run BEFORE the gates or it protects nothing: no snapshot was
        // ever fetched, so neither quorum rule was selected.
        expect(weightSnap.called, 'the stake-weighted gate must never have resolved').to.equal(false);
        expect(hub.capabilitySnapshot.getSnapshot.called).to.equal(false);
    });

    it('judges the SAME signature set under the honest count rule once the header is truthful', async function () {
        // The control that makes the case above an attack rather than a typo: with the
        // header pinned to the last round's own anchor, the batch resolves under the
        // count rule its per-round anchors really sit under, and two of four signers is
        // short of quorum. The lie was worth telling.
        hub.network = 'mainnet';
        let inserts = stubDb([]);
        hub.capabilitySnapshot = {
            getSnapshot:       sinon.stub().resolves(snapshotOf(V)),
            getWeightSnapshot: sinon.stub().resolves(stakeSnapshotOf(V))
        };

        let rounds = attackRounds();
        let honest = rounds[rounds.length - 1].btc_block_height;
        let sigs   = signBatch(rounds, V.slice(0, 2), { btc_block_height: honest });

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({
            rounds, sigs, btc_block_height: honest
        }));

        expect(result.accepted).to.equal(false);
        expect(result.reason).to.equal('insufficient quorum (2/3)');
        expect(inserts.length).to.equal(0);
    });

    it('accepts an honest batch whose header anchor equals the last round anchor', async function () {
        let inserts = stubDb([]);
        let rounds  = attackRounds();
        let honest  = rounds[rounds.length - 1].btc_block_height;
        let sigs    = signBatch(rounds, V.slice(0, 3), { btc_block_height: honest });

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({
            rounds, sigs, btc_block_height: honest
        }));

        expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        expect(inserts.length).to.equal(6);
    });

    it('refuses a header anchor that is off by one in either direction', async function () {
        // No tolerance: the rule is equality, so the nearest possible lie is refused.
        stubDb([]);
        let rounds = attackRounds();
        let last   = rounds[rounds.length - 1].btc_block_height;
        for (let header of [last - 1, last + 1]) {
            let sigs   = signBatch(rounds, V.slice(0, 3), { btc_block_height: header });
            let result = await agg.receiveValidatedBatch('BTC', makeBatch({
                rounds, sigs, btc_block_height: header
            }));
            expect(result.reason, 'header ' + header).to.equal('batch anchor does not match the last round');
        }
    });

    // ---- D14: the pair-name flag day keys on the batch's block_time ----

    it('keys the pair-name flag day on the batch block_time, not on the round timestamps (D14)', async function () {
        // Mainnet widening is the unarmed 9999999999 sentinel. The rounds are stamped
        // far below it and the landing block is above it, which is exactly the ~70
        // minute hub/chain skew batching creates: keyed on the round timestamps the hub
        // would refuse a whole hour the chain accepted.
        hub.network = 'mainnet';
        let inserts = stubDb([]);
        let rounds  = makeRounds().map(r => ({
            ...r,
            btc_block_height: 799000,                 // one side of every mainnet flag day
            pairs: [{ pair: 'XCHAIN/USD', price: '0.05' }]   // 6-character ticker, widened bound only
        }));
        // Every round shares anchor 799000, so the header anchor is 799000 too (§4).
        let sigs = signBatch(rounds, V.slice(0, 3), { btc_block_height: 799000 });

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({
            rounds, sigs, btc_block_height: 799000, block_time: 10000000000
        }));

        expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        expect(decodeInsert(inserts[0])[0].coin_pair).to.equal('XCHAIN/USD');

        // Same batch, landing block BELOW the widening: the legacy 5-character bound
        // applies and the pair is refused.
        let below = await agg.receiveValidatedBatch('BTC', makeBatch({
            rounds, sigs, btc_block_height: 799000, block_time: 1700004000
        }));
        expect(below.accepted).to.equal(false);
        expect(below.reason).to.equal('invalid pairs');
    });

    // ---- Reorg fence ----

    it('drops a batch whose push generation sits at or below a kept retraction generation', async function () {
        let inserts = stubDb([]);
        hub.db.getPriceIngestWatermark.resolves({ retraction_generation: 3, from_action_index: 10 });
        sinon.stub(console, 'warn');

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({ push_generation: 3 }));

        expect(result.accepted).to.equal(false);
        expect(result.reason).to.equal('stale (retracted generation)');
        expect(result.rejected).to.equal(6);
        expect(inserts.length).to.equal(0);
        // Never silent: a rebuilt indexer trips this fence on every push.
        expect(console.warn.calledOnce).to.equal(true);
        expect(console.warn.firstCall.args[0]).to.match(/PRICE batch/);
    });

    it('accepts the re-published batch at a higher generation and stamps it on every row', async function () {
        let inserts = stubDb([]);
        hub.db.getPriceIngestWatermark.resolves({ retraction_generation: 3, from_action_index: 10 });

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({ push_generation: 4 }));

        expect(result.accepted).to.equal(true);
        expect(decodeInsert(inserts[0])[0].push_generation).to.equal(4);
    });

    it('fails closed when the validator snapshot is unavailable or truncated', async function () {
        stubDb([]);
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(null) };
        let r1 = await agg.receiveValidatedBatch('BTC', makeBatch());
        expect(r1.reason).to.equal('validator snapshot unavailable');

        hub.network = 'regtest';                       // stake-weighted quorum active at genesis
        hub.capabilitySnapshot = {
            getWeightSnapshot: sinon.stub().resolves({ ...snapshotOf(V), truncated: true })
        };
        let r2 = await agg.receiveValidatedBatch('BTC', makeBatch());
        expect(r2.reason).to.equal('validator snapshot truncated');
    });

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

    it('resolves the snapshot at the signed BTC anchor, so an off-Bitcoin batch is ACCEPTED', async function () {
        let inserts = stubDb([]);
        let getSnapshot = btcKeyedSnapshotResolver(BATCH_ANCHOR, V);
        hub.capabilitySnapshot = { getSnapshot };

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch({ block_index: DOGE_LANDING_BLOCK }));

        expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        expect(getSnapshot.calledOnceWithExactly('price', BATCH_ANCHOR)).to.equal(true);
        // The landing height is never handed to the resolver: it is not a BTC height.
        expect(getSnapshot.calledWith('price', DOGE_LANDING_BLOCK)).to.equal(false);

        // reference_block still records the LANDING block (D8). The anchor keys the
        // validator set; it does not change what the row says the batch landed on.
        expect(inserts.length).to.equal(6);
        expect(decodeInsert(inserts[0])[0].reference_block).to.equal(DOGE_LANDING_BLOCK);
    });

    it('resolves the stake-weighted snapshot at the same anchor, so the two reads name ONE validator set', async function () {
        // The weight read and the membership read must key alike, or the tally is drawn
        // from one set and the threshold computed from another.
        hub.network = 'regtest';                       // stake-weighted quorum active at genesis
        stubDb([]);
        let getWeightSnapshot = sinon.stub().callsFake(async (capability, blockIndex) => {
            if (capability !== 'price' || Number(blockIndex) !== BATCH_ANCHOR) return null;
            return {
                capability: 'price',
                blockIndex: BATCH_ANCHOR,
                count:      V.length,
                validators: V.map((v, i) => ({ pubkey: v.pubkey, source: 'src' + i, weight: '100000' }))
            };
        });
        hub.capabilitySnapshot = { getWeightSnapshot };

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch({ block_index: DOGE_LANDING_BLOCK }));

        expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        expect(getWeightSnapshot.calledOnceWithExactly('price', BATCH_ANCHOR)).to.equal(true);
    });

    it('is a NO-OP on Bitcoin, where the landing block IS the BTC anchor', async function () {
        // On Bitcoin the batch lands in the block its anchor names, so block_index and
        // btc_block_height are the same number and the old key and the new key are the
        // same read. Driven with a resolver that would refuse any other height.
        let inserts = stubDb([]);
        let getSnapshot = btcKeyedSnapshotResolver(BATCH_ANCHOR, V);
        hub.capabilitySnapshot = { getSnapshot };

        let result = await agg.receiveValidatedBatch('BTC', makeBatch({ block_index: BATCH_ANCHOR }));

        expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        expect(getSnapshot.calledOnceWithExactly('price', BATCH_ANCHOR)).to.equal(true);
        expect(decodeInsert(inserts[0])[0].reference_block).to.equal(BATCH_ANCHOR);
    });

    it('still FAILS CLOSED when the anchor resolves no snapshot, even with one at the landing block', async function () {
        // The half that makes the change safe. The set is unresolvable at the anchor
        // and perfectly resolvable at the landing height, and the batch is refused
        // anyway: no fallback to a height that names a different chain's block, or a
        // Byzantine pusher could pick a landing block whose set it controls.
        let inserts = stubDb([]);
        let getSnapshot = sinon.stub().callsFake(async (capability, blockIndex) => {
            if (Number(blockIndex) === DOGE_LANDING_BLOCK) return snapshotOf(V);
            return null;
        });
        hub.capabilitySnapshot = { getSnapshot };

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch({ block_index: DOGE_LANDING_BLOCK }));

        expect(result).to.deep.equal({
            accepted: false, stored: 0, duplicates: 0, rejected: 6,
            reason: 'validator snapshot unavailable'
        });
        expect(inserts.length).to.equal(0);
    });

    it('buries a BTC height by the canonical reorg buffer, off Bitcoin as well as on it', async function () {
        // CapabilitySnapshot subtracts CANONICAL_REORG_BUFFER before it resolves
        // anything, because stake state at the tip is not reorg-safe. That subtraction
        // only ever meant BTC confirmations; keyed on the landing block it was six
        // Dogecoin blocks taken off a number that was never a BTC height. This resolver
        // buries exactly as the real one does and holds the set at BTC heights only, so
        // it answers for the buried anchor and for nothing derived from the landing block.
        let inserts = stubDb([]);
        let buriedAsked = [];
        let getSnapshot = sinon.stub().callsFake(async (capability, blockIndex) => {
            let buried = Math.max(0, Number(blockIndex) - CANONICAL_REORG_BUFFER);
            buriedAsked.push(buried);
            if (buried !== BATCH_ANCHOR - CANONICAL_REORG_BUFFER) return null;
            return { ...snapshotOf(V), blockIndex: buried };
        });
        hub.capabilitySnapshot = { getSnapshot };

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch({ block_index: DOGE_LANDING_BLOCK }));

        expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        expect(buriedAsked).to.deep.equal([BATCH_ANCHOR - CANONICAL_REORG_BUFFER]);
        expect(inserts.length).to.equal(6);
    });
});

describe('PriceAggregator.retractFromActionIndex() batch marker clear (D28)', function () {

    let hub, agg, publisher;

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
        publisher = { clearPublishedMarkers: sinon.stub().resolves() };
        hub.oraclePublisher = publisher;
        sinon.stub(console, 'log');
    });

    afterEach(function () {
        sinon.restore();
    });

    // Batch-sourced rows carry the {"batch":...} consensus_proof of D23; a v0 row's
    // proof is a bare signature array, which is what the LIKE prefix separates.
    function stubDb(batchRoundRows) {
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT DISTINCT round_number/.test(sql)) return batchRoundRows;
            return { affectedRows: batchRoundRows.length ? 4 : 2 };
        });
    }

    it('clears the publisher marker for every round a retracted batch carried', async function () {
        stubDb([{ round_number: 100 }, { round_number: 101 }, { round_number: 102 }]);

        await agg.retractFromActionIndex('BTC', 500, 600, 3);

        // The rounds are read BEFORE the DELETE, bounded and fenced exactly as the
        // DELETE is, so a row outside the retraction never clears a live marker.
        let select = hub.db.doQuery.getCalls().find(c => /^SELECT DISTINCT round_number/.test(c.args[0]));
        expect(select, 'batch-round lookup issued').to.exist;
        expect(select.args[0]).to.match(/consensus_proof LIKE '\{"batch":%'/);
        expect(select.args[1]).to.deep.equal(['BTC', 500, 600, 3]);
        expect(hub.db.doQuery.firstCall.args[0]).to.match(/^SELECT DISTINCT round_number/);

        expect(publisher.clearPublishedMarkers.calledOnce).to.equal(true);
        expect(publisher.clearPublishedMarkers.firstCall.args[0]).to.deep.equal([100, 101, 102]);
    });

    it('does not touch the publisher when the retraction removed no batch-sourced rows', async function () {
        stubDb([]);
        await agg.retractFromActionIndex('BTC', 500);
        expect(publisher.clearPublishedMarkers.called).to.equal(false);
    });

    it('completes the retraction when the marker clear throws', async function () {
        stubDb([{ round_number: 100 }]);
        publisher.clearPublishedMarkers.rejects(new Error('marker table down'));
        sinon.stub(console, 'error');

        let result = await agg.retractFromActionIndex('BTC', 500);

        // The rows are already gone; a publisher failure must never report the
        // retraction as failed.
        expect(result.retracted.price_snapshots).to.equal(4);
        expect(console.error.calledOnce).to.equal(true);
    });

    it('issues no extra query and stays a two-statement path when no publisher is wired', async function () {
        delete hub.oraclePublisher;
        hub.db.doQuery.resolves({ affectedRows: 1 });

        await agg.retractFromActionIndex('LTC', 10);

        let calls = hub.db.doQuery.getCalls();
        expect(calls.length).to.equal(2);
        expect(calls.every(c => /^DELETE FROM/.test(c.args[0]))).to.equal(true);
    });

    it('names the missing half out loud when a publisher is wired without the clear seam', async function () {
        hub.oraclePublisher = {};                     // no clearPublishedMarkers
        hub.db.doQuery.resolves({ affectedRows: 1 });
        sinon.stub(console, 'warn');

        await agg.retractFromActionIndex('BTC', 500);

        expect(console.warn.calledOnce).to.equal(true);
        expect(console.warn.firstCall.args[0]).to.match(/clearPublishedMarkers/);
    });
});
