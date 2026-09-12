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
// price_snapshots.batch_block_time: the clock of the block a round's PRICE batch
// LANDED in. It is what lets an indexer tell a round the chain has shown it from a
// round its hub finalized minutes ago and no block carries yet, so fee pricing can
// stop diverging between a hub-connected node and a chain-only node.
//
// The case that matters most here is the DEDUPED round. On a validator, every round
// of its own batch is already finalized locally when the batch lands, so the ingest
// takes the duplicate branch for all of them: stamping only the rows this call
// INSERTS would leave the one node kind that produces rounds unable to tell a landed
// round from an unlanded one, on every round it ever produced.

const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../src/PriceAggregator');
const { createMockHub } = require('../helpers/mockHub');

function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}

describe('PriceAggregator batch landing clock (batch_block_time)', function () {

    const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];

    const FIRST_ROUND  = 200;
    const LAST_ROUND   = 201;
    const BATCH_ANCHOR = 799101;
    const BLOCK_INDEX  = 800500;      // landing block height on the landing chain
    const ACTION_INDEX = 91;
    const BLOCK_TIME   = 1700009000;  // the landing block's own clock

    function makeRounds() {
        let out = [];
        for (let i = 0; i < 2; i++) {
            out.push({
                round:            FIRST_ROUND + i,
                timestamp:        1700000000 + (i * 600),   // deliberately far from BLOCK_TIME
                btc_block_height: 799100 + i,
                pairs: [{ pair: 'BTC/USD', price: String(50000 + i) }]
            });
        }
        return out;
    }

    let hub, agg;

    function signBatch(rounds, signers = V.slice(0, 3)) {
        let payload = agg._buildPriceBatchPayload(
            FIRST_ROUND, LAST_ROUND, BATCH_ANCHOR,
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
        if (batch.sigs === undefined) batch.sigs = signBatch(rounds);
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

    // Record every statement, answer the dedupe SELECT from `finalizedRounds`, and
    // answer the stamp re-read from `stampedRows`.
    function stubDb(finalizedRounds = [], stampedRows = []) {
        let log = { inserts: [], updates: [], selects: [] };
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) {
                return finalizedRounds.includes(params[0]) ? [{ id: 7 }] : [];
            }
            if (/^UPDATE price_snapshots SET batch_block_time/.test(sql)) {
                log.updates.push({ sql, params });
                return {};
            }
            if (/^SELECT round_number, coin_pair/.test(sql)) {
                log.selects.push({ sql, params });
                return stampedRows.filter(r => r.round_number === params[0] &&
                                               r.batch_block_time === params[1]);
            }
            if (/^INSERT INTO price_snapshots/.test(sql)) {
                log.inserts.push({ sql, params });
                return {};
            }
            return [];
        });
        return log;
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

    it('writes the LANDING block clock, not the round clock and not the landing height', async function () {
        let log    = stubDb([]);
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch());
        expect(result.accepted).to.equal(true);
        expect(log.inserts.length).to.equal(2);

        // The statement declares the column, and the bound value is the batch's
        // block_time: distinct from the round's own timestamp and from the landing height.
        expect(log.inserts[0].sql).to.match(/batch_block_time/);
        expect(log.inserts[0].params).to.include(BLOCK_TIME);
        expect(log.inserts[0].params).to.not.include(BLOCK_INDEX + 1);

        // And the mirror stream carries it, or an indexer following this hub could never
        // tell a landed round from one finalized ahead of its batch.
        expect(events.length).to.equal(2);
        expect(events[0].row.batch_block_time).to.equal(BLOCK_TIME);
        expect(events[0].row.block_timestamp).to.equal(1700000000);
        expect(events[0].row.batch_block_time).to.not.equal(events[0].row.block_timestamp);
    });

    it('stamps a round that was ALREADY finalized here, which is the validator case', async function () {
        let stamped = [
            { round_number: FIRST_ROUND, coin_pair: 'BTC/USD', price: '50000',
              status: 'finalized', batch_block_time: BLOCK_TIME }
        ];
        let log    = stubDb([FIRST_ROUND, LAST_ROUND], stamped);
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch());

        // Nothing stored (both rounds were already finalized) and nothing lost.
        expect(result).to.deep.equal({ accepted: true, stored: 0, duplicates: 2, rejected: 0 });
        expect(log.inserts.length).to.equal(0);

        // Both rounds were stamped, keyed by round number and bounded so it can only
        // LOWER an existing clock.
        expect(log.updates.length).to.equal(2);
        expect(log.updates.map(u => u.params[1])).to.deep.equal([FIRST_ROUND, LAST_ROUND]);
        expect(log.updates[0].params[0]).to.equal(BLOCK_TIME);
        expect(log.updates[0].sql).to.match(/batch_block_time = 0 OR batch_block_time > \?/);
        expect(log.updates[0].params[2]).to.equal(BLOCK_TIME);

        // The rows it changed are re-emitted, so a mirror that already holds the
        // unstamped row converges instead of keeping a round marked as never landed.
        expect(events.length).to.equal(1);
        expect(events[0].table).to.equal('price_snapshots');
        expect(events[0].row.round_number).to.equal(FIRST_ROUND);
        expect(events[0].row.batch_block_time).to.equal(BLOCK_TIME);
    });

    it('re-emits nothing when an earlier batch already stamped the round lower', async function () {
        // The re-read finds no row carrying THIS clock, because the stored one is lower.
        let log    = stubDb([FIRST_ROUND, LAST_ROUND], []);
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch());
        expect(result.accepted).to.equal(true);
        expect(log.updates.length).to.equal(2);
        expect(log.selects.length).to.equal(2);
        expect(events.length).to.equal(0);
    });

    it('a stamp failure never rejects the batch', async function () {
        stubDb([FIRST_ROUND, LAST_ROUND]);
        hub.db.doQuery.withArgs(sinon.match(/^UPDATE price_snapshots SET batch_block_time/))
            .rejects(new Error('ER_LOCK_WAIT_TIMEOUT'));
        sinon.stub(console, 'error');

        let result = await agg.receiveValidatedBatch('DOGE', makeBatch());
        expect(result).to.deep.equal({ accepted: true, stored: 0, duplicates: 2, rejected: 0 });
        expect(console.error.called).to.equal(true);
    });

    it('_stampBatchLanding refuses a clock that is not a positive integer', async function () {
        let log = stubDb([]);
        expect(await agg._stampBatchLanding(FIRST_ROUND, 0)).to.equal(0);
        expect(await agg._stampBatchLanding(FIRST_ROUND, -1)).to.equal(0);
        expect(await agg._stampBatchLanding(FIRST_ROUND, 'later')).to.equal(0);
        expect(log.updates.length).to.equal(0);
    });
});
