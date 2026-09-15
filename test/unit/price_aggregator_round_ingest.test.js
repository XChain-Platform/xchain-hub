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
const PriceAggregator  = require('../../src/oracle/price_aggregator');
const { createMockHub } = require('../helpers/mockHub');

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


    // Four price-qualified validators → PBFT quorum 2*floor(3/3)+1 = 3
    const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];

    const PAIRS   = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];

    const BTC_HEIGHT = 799000;
  // the round's BTC anchor (distinct from block_index, the PRICE tx block)
    const PAYLOAD = buildPriceV0Payload(5, 1700000000, PAIRS, BTC_HEIGHT);


    // A legitimately signed round: 3 of the 4 qualified validators signed
    function makeRound(overrides = {}) {
        return {
            round: 5,
            timestamp: 1700000000,
            btc_block_height: BTC_HEIGHT,
            block_index: 800000,
            action_index: 42,
            pairs: PAIRS,
            sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(PAYLOAD) })),
            ...overrides
        };
    }


    function stubSnapshot(snapshot) {
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(snapshot) };
        return hub.capabilitySnapshot.getSnapshot;
    }


    function snapshotOf(validators) {
        return {
            capability: 'price',
            blockIndex: 800000,
            count:      validators.length,
            validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
        };
    }


    // doQuery stub: dedup SELECT misses, INSERTs are captured
    function stubDb() {
        let inserts = [];
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); return {}; }
            return [];
        });
        return inserts;
    }

function registerPriceaggregatorReceivevalidatedround1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
        stubSnapshot(snapshotOf(V));
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerPriceaggregatorReceivevalidatedround1Tests1() {

    it('rejects roundData that is null / missing round / has non-array or empty pairs', async function () {
        for (let bad of [null, { pairs: [] }, { round: 5 }, { round: 5, pairs: 'x' }]) {
            let result = await agg.receiveValidatedRound('BTC', bad);
            expect(result).to.deep.equal({ accepted: false, reason: 'invalid roundData' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a non-finite or negative round number', async function () {
        let r1 = await agg.receiveValidatedRound('BTC', makeRound({ round: -1 }));
        expect(r1).to.deep.equal({ accepted: false, reason: 'invalid round' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a round missing timestamp or block_index (both are signed/anchoring fields)', async function () {
        let r1 = await agg.receiveValidatedRound('BTC', makeRound({ timestamp: undefined }));
        expect(r1).to.deep.equal({ accepted: false, reason: 'invalid timestamp' });
        let r2 = await agg.receiveValidatedRound('BTC', makeRound({ block_index: undefined }));
        expect(r2).to.deep.equal({ accepted: false, reason: 'invalid block_index' });
        let r3 = await agg.receiveValidatedRound('BTC', makeRound({ btc_block_height: undefined }));
        expect(r3).to.deep.equal({ accepted: false, reason: 'invalid btc_block_height' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('HUB-RETRACT-4: rejects a stale round replay (generation <= watermark, action_index in the orphaned range)', async function () {
        let warn = sinon.stub(console, 'warn');
        stubDb();
        hub.db.getPriceIngestWatermark.resolves({ retraction_generation: 5, from_action_index: 100 });
        // A validly-signed round that reaches quorum but replays a rolled-back action_index at the
        // pre-reorg generation must be rejected before it re-inserts the orphaned round.
        let result = await agg.receiveValidatedRound('BTC', makeRound({ action_index: 120, push_generation: 5 }));
        expect(result).to.deep.equal({ accepted: false, reason: 'stale (retracted generation)' });
        let inserted = hub.db.doQuery.getCalls().some(c => /^INSERT INTO price_snapshots/.test(c.args[0]));
        expect(inserted).to.equal(false);
        // the v0 round path warns as loudly as the v1 path, naming the fence.
        expect(warn.calledOnce).to.equal(true);
        expect(warn.firstCall.args[0]).to.contain('PRICE v0 round');
        expect(warn.firstCall.args[0]).to.contain('price_ingest_watermarks');
    });

    it('rejects malformed pairs instead of silently skipping them', async function () {
        for (let pairs of [
            [{ pair: 'BTC/USD', price: '50000' }, null],
            [{ pair: 'NOPRICE' }],
            [{ price: '1' }],
            [{ pair: 'not a pair', price: '1' }],
            [{ pair: 'BTC/USD', price: 'NaN' }]
        ]) {
            let result = await agg.receiveValidatedRound('BTC', makeRound({ pairs }));
            expect(result, JSON.stringify(pairs)).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });
}

function registerPriceaggregatorReceivevalidatedround1Tests6() {

    it('rejects opaque/unstructured sigs (the historical blind-storage shape)', async function () {
        // Before hub-side verification existed, exactly this shape was stored
        // verbatim as a 'finalized' consensus proof with validator_count 2.
        for (let sigs of [undefined, [], ['sigA', 'sigB'], [{ pubkey: 'xx', sig: 'yy' }]]) {
            let result = await agg.receiveValidatedRound('BTC', makeRound({ sigs }));
            expect(result, JSON.stringify(sigs)).to.deep.equal({ accepted: false, reason: 'invalid sigs' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a duplicate round (a snapshot row already exists) before verification', async function () {
        hub.db.doQuery.onFirstCall().resolves([{ id: 1 }]);
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: false, reason: 'duplicate' });
        expect(hub.db.doQuery.callCount).to.equal(1); // dedup SELECT only
        expect(hub.capabilitySnapshot.getSnapshot.called).to.equal(false);
    });

    it('accepts a quorum-signed round, stores only verified sigs, and emits row:inserted per pair', async function () {
        let inserts = stubDb();
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveValidatedRound('BTC', makeRound());

        expect(result).to.deep.equal({ accepted: true });
        // The validator set was resolved for the price capability at the round's block
        expect(hub.capabilitySnapshot.getSnapshot.calledOnceWith('price', 800000)).to.equal(true);
        // One atomic multi-row INSERT for the whole round; inserts[0] is the flat
        // params array, first 11 entries = the first row (round/pair/price/…).
        expect(inserts).to.have.length(1);
        expect(inserts[0][0]).to.equal(5);             // round_number
        expect(inserts[0][1]).to.equal('BTC/USD');     // coin_pair
        expect(inserts[0][2]).to.equal('50000');       // price
        expect(inserts[0][3]).to.equal(800000);        // reference_block
        expect(inserts[0][4]).to.equal('BTC');         // reference_chain
        expect(inserts[0][5]).to.equal(1700000000);    // block_timestamp
        expect(inserts[0][6]).to.equal(3);             // validator_count = VERIFIED sigs
        // consensus_proof holds exactly the verified (pubkey, sig) pairs
        let proof = JSON.parse(inserts[0][7]);
        expect(proof.map(s => s.pubkey)).to.deep.equal(V.slice(0, 3).map(v => v.pubkey));
        expect(events).to.have.length(2);
        expect(events.every(e => e.table === 'price_snapshots')).to.equal(true);
        expect(events.map(e => e.row.coin_pair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
    });
}

function registerPriceaggregatorReceivevalidatedround1Tests9() {

    it("excludes 'skipped' placeholder rows from the dedup SELECT so a peer-salvaged round is not rejected", async function () {
        // A round this hub locally marked 'skipped' (no local submissions) must not
        // block a real validated round for the same round_number arriving from a
        // peer chain that reached quorum. The dedup SELECT therefore filters out
        // skipped rows; only a genuine finalized row counts as a duplicate.
        let dedupSql = null;
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) { dedupSql = sql; return []; }
            return {};
        });
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: true });
        expect(dedupSql).to.match(/status\s*!=\s*'skipped'/);
    });

    it('writes each pair as an upsert (ON DUPLICATE KEY UPDATE → finalized) so a skipped placeholder is overwritten, not collided', async function () {
        // With skipped rows excluded from the dedup, a skipped placeholder still
        // occupies the (round_number, coin_pair) unique key, so a plain INSERT would
        // collide. The write must upsert: overwrite the placeholder with finalized
        // data (and stay idempotent for an already-finalized row).
        let insertSqls = [];
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) { insertSqls.push(sql); return {}; }
            return {};
        });
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: true });
        // One atomic multi-row INSERT for the whole round (not one per pair).
        expect(insertSqls).to.have.length(1);
        insertSqls.forEach(sql => {
            expect(sql).to.match(/ON DUPLICATE KEY UPDATE/);
            expect(sql).to.match(/status\s*=\s*'finalized'/);
        });
    });

    it('rejects a round whose sigs are forged (well-formed hex but cryptographically invalid)', async function () {
        stubDb();
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: 'ab'.repeat(64) }))
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (0/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('rejects a round signed over a DIFFERENT payload (valid sigs, wrong data)', async function () {
        stubDb();
        // Validators signed round 5 at the real prices; attacker replays those
        // sigs on a round claiming BTC/USD = 1.
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            pairs: [{ pair: 'BTC/USD', price: '1' }]
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (0/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });
}

function registerPriceaggregatorReceivevalidatedround1Tests13() {

    it('rejects a round signed by keys outside the qualified price-capability set', async function () {
        stubDb();
        let outsiders = [makeValidator(), makeValidator(), makeValidator()];
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: outsiders.map(v => ({ pubkey: v.pubkey, sig: v.sign(PAYLOAD) }))
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (0/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('rejects a round below quorum and counts a duplicated pubkey only once', async function () {
        stubDb();
        // 2 distinct valid sigs < quorum 3
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: V.slice(0, 2).map(v => ({ pubkey: v.pubkey, sig: v.sign(PAYLOAD) }))
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (2/3)' });

        // Padding with a repeat of the same validator must not reach quorum
        let sig0 = { pubkey: V[0].pubkey, sig: V[0].sign(PAYLOAD) };
        let result2 = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: [sig0, sig0, { pubkey: V[1].pubkey, sig: V[1].sign(PAYLOAD) }]
        }));
        expect(result2).to.deep.equal({ accepted: false, reason: 'insufficient quorum (2/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('fails closed when the validator snapshot is unavailable', async function () {
        stubDb();
        stubSnapshot(null); // indexer unreachable
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: false, reason: 'validator snapshot unavailable' });

        hub.capabilitySnapshot = undefined; // no snapshot machinery at all
        let result2 = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result2).to.deep.equal({ accepted: false, reason: 'validator snapshot unavailable' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('accepts a single-validator round in a single-node set (quorum 1)', async function () {
        let inserts = stubDb();
        stubSnapshot(snapshotOf([V[0]]));
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: [{ pubkey: V[0].pubkey, sig: V[0].sign(PAYLOAD) }]
        }));
        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(1); // one atomic multi-row INSERT
        expect(inserts[0][6]).to.equal(1); // validator_count (first row)
    });
}

function registerPriceaggregatorReceivevalidatedround1Tests17() {

    // Finding 1257: validated-round price ingest now rejects non-positive prices
    // (the positive lower bound mirrors the governance-path check), so a
    // quorum-signed zero or all-zero round cannot finalize as a real price. The
    // rejection lands in the pairs loop before any DB access.
    it('rejects a zero price without touching the DB (non-positive lower bound)', async function () {
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            pairs: [{ pair: 'BTC/USD', price: '0' }]
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a negative price without touching the DB', async function () {
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            pairs: [{ pair: 'BTC/USD', price: '-1' }]
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('accepts a small positive boundary price (0.00000001)', async function () {
        let inserts = stubDb();
        let smallPairs = [{ pair: 'BTC/USD', price: '0.00000001' }];
        let payload = buildPriceV0Payload(5, 1700000000, smallPairs, BTC_HEIGHT);
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            pairs: smallPairs,
            sigs:  V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
        }));
        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(1);
        expect(inserts[0][2]).to.equal('0.00000001');   // price persisted verbatim
    });

    it('still rejects a price at/above the PRICE_MAX upper bound (guard untouched)', async function () {
        const { PRICE_MAX } = require('../../src/constants');
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            pairs: [{ pair: 'BTC/USD', price: String(PRICE_MAX) }]
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('returns a db error if a snapshot INSERT throws', async function () {
        let events = [];
        agg.on('row:inserted', e => events.push(e));
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) throw new Error('boom');
            return [];
        });
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: false, reason: 'db error' });
        expect(events).to.deep.equal([]); // aborts before emitting
    });

}

describe('PriceAggregator.receiveValidatedRound()', function () {
    registerPriceaggregatorReceivevalidatedround1Hooks();
    registerPriceaggregatorReceivevalidatedround1Tests1();
    registerPriceaggregatorReceivevalidatedround1Tests6();
    registerPriceaggregatorReceivevalidatedround1Tests9();
    registerPriceaggregatorReceivevalidatedround1Tests13();
    registerPriceaggregatorReceivevalidatedround1Tests17();
});
