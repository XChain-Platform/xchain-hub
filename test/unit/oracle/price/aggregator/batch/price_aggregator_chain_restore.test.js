'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const PriceAggregator = require('../../../../../../src/oracle/price_aggregator');
const chainRestoreDb = require('../../../../../../src/db/prices/chain_restore');
const { createMockHub } = require('../../../../../helpers/mockHub');

function validator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return { pubkey, sign: payload => crypto.sign(null, Buffer.from(payload), privateKey).toString('hex') };
}

function signedPayload(agg, validators, badSignature) {
    let rounds = [{ round: 300, timestamp: 1700000000, btc_block_height: 799200,
        pairs: [{ pair: 'BTC/USD', price: '50000.00' }] }];
    let canonical = agg.buildPriceBatchPayload(300, 300, 799200,
        rounds.map(r => ({ round: r.round, timestamp: r.timestamp,
            btcBlockHeight: r.btc_block_height, pairs: r.pairs })));
    let sigs = validators.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(canonical) }));
    if (badSignature) sigs[0].sig = 'ff'.repeat(64);
    return { source_chain: 'DOGE', first_round: 300, last_round: 300,
        btc_block_height: 799200, rounds, block_time: 1700000600, sigs,
        action_index: 90, block_index: 800000, push_generation: 4 };
}

function installPublisher(hub, payload, response) {
    hub.oraclePublisher = {
        fetchLandedBatches: sinon.stub().resolves({ batches: [{ first_round: 300,
            last_round: 300, action_index: 90 }], truncated: false }),
        fetchLandedBatchPayload: sinon.stub().resolves(response || { payload })
    };
}

describe('PriceAggregator active-chain PRICE repair', function () {
    let hub, agg, validators;

    beforeEach(function () {
        hub = createMockHub({ network: 'mainnet' });
        agg = new PriceAggregator(hub);
        validators = [validator(), validator(), validator(), validator()];
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({ capability: 'price',
            blockIndex: 799200, count: 4,
            validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' })) }) };
        hub.db.findPriceSnapshotRowsForRounds = sinon.stub().resolves([]);
        hub.db.getPriceIngestWatermark = sinon.stub().resolves(null);
        hub.db.setBatchPriceSnapshotRound = sinon.stub().resolves({ affectedRows: 1 });
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
    });

    afterEach(function () { sinon.restore(); });

    it('restores a missing round through the same verified batch ingest used by pushpricebatch', async function () {
        let payload = signedPayload(agg, validators, false);
        installPublisher(hub, payload);

        let result = await agg.repairPriceRoundsFromChain([{ first: 300, last: 300 }]);

        expect(result).to.include({ ran: true, restored: 1, refused: 0 });
        expect(hub.db.setBatchPriceSnapshotRound.calledOnce).to.equal(true);
        expect(hub.db.setBatchPriceSnapshotRound.firstCall.args[0]).to.equal(300);
    });

    it('refuses a restored batch with a bad signature exactly like a pushed batch', async function () {
        let payload = signedPayload(agg, validators, true);
        installPublisher(hub, payload);

        let result = await agg.repairPriceRoundsFromChain([{ first: 300, last: 300 }]);

        expect(result).to.include({ ran: true, restored: 0, refused: 1 });
        expect(hub.db.setBatchPriceSnapshotRound.called).to.equal(false);
    });

    it('backs off an old indexer, logs once per disarm and re-arms without a restart', async function () {
        let now = 1000;
        sinon.stub(agg, 'priceRestoreNow').callsFake(() => now);
        installPublisher(hub, null, { unsupported: true });

        let first = await agg.repairPriceRoundsFromChain([{ first: 300, last: 300 }]);
        let callsAtDisarm = hub.oraclePublisher.fetchLandedBatchPayload.callCount;
        let warningsAtDisarm = console.warn.callCount;
        let backedOff = await agg.repairPriceRoundsFromChain([{ first: 300, last: 300 }]);

        expect(first).to.deep.equal({ ran: false, reason: 'indexer method unavailable' });
        expect(backedOff).to.deep.equal({ ran: false, reason: 'indexer method unavailable' });
        expect(hub.oraclePublisher.fetchLandedBatchPayload.callCount).to.equal(callsAtDisarm);
        expect(console.warn.callCount).to.equal(warningsAtDisarm);
        expect(hub.db.setBatchPriceSnapshotRound.called).to.equal(false);

        now += 30 * 60 * 1000;
        hub.oraclePublisher.fetchLandedBatchPayload.resolves({ payload: signedPayload(agg, validators, false) });
        let retried = await agg.repairPriceRoundsFromChain([{ first: 300, last: 300 }]);
        expect(retried).to.include({ ran: true, restored: 1 });
        expect(hub.oraclePublisher.fetchLandedBatchPayload.callCount).to.equal(callsAtDisarm + 1);
    });

    it('refuses a payload whose source chain or action index does not match the request', async function () {
        let payload = signedPayload(agg, validators, false);
        installPublisher(hub, Object.assign({}, payload, { source_chain: 'LTC' }));
        let wrongChain = await agg.repairPriceRoundsFromChain([{ first: 300, last: 300 }]);
        hub.oraclePublisher.fetchLandedBatchPayload.resolves({ payload: Object.assign({}, payload,
            { action_index: 91 }) });
        let wrongAction = await agg.repairPriceRoundsFromChain([{ first: 300, last: 300 }]);

        expect(wrongChain).to.include({ ran: true, restored: 0, refused: 1 });
        expect(wrongAction).to.include({ ran: true, restored: 0, refused: 1 });
        expect(hub.db.setBatchPriceSnapshotRound.called).to.equal(false);
    });

    it('queues a retracted window behind an active pass and runs it next', async function () {
        let release;
        let blocked = new Promise(resolve => { release = resolve; });
        hub.oraclePublisher = {
            fetchLandedBatches: sinon.stub()
                .onFirstCall().returns(blocked)
                .onSecondCall().resolves({ batches: [], truncated: false })
        };
        let first = agg.repairPriceRoundsFromChain([{ first: 1, last: 1 }]);
        let queued = agg.repairPriceRoundsFromChain([{ first: 9, last: 9 }]);
        release({ batches: [], truncated: false });

        expect(await first).to.include({ ran: true, considered: 0 });
        expect(await queued).to.include({ ran: true, considered: 0 });
        expect(hub.oraclePublisher.fetchLandedBatches.args.map(args => args.slice(0, 2)))
            .to.deep.equal([[1, 1], [9, 9]]);
    });

    it('does not enqueue repeated background work while a slow pass is active', async function () {
        let tick, release;
        let blocked = new Promise(resolve => { release = resolve; });
        agg.priceRestoreSetInterval = fn => {
            tick = fn;
            return { unref() {} };
        };
        agg.priceRestoreClearInterval = () => {};
        sinon.stub(agg, 'runPriceChainRestorePass').returns(blocked);

        expect(agg.startPriceChainRestore()).to.equal(true);
        tick();
        for (let i = 0; i < 20; i++) tick();
        expect(agg.runPriceChainRestorePass.calledOnce).to.equal(true);
        expect(agg._priceRestoreQueue.length).to.be.at.most(1);

        release({ ran: true, considered: 0, restored: 0 });
        await agg._lastPriceRestoreBackground;
        agg.stopPriceChainRestore();
    });

    it('stops queued work and makes a running pass stop before its next database read', async function () {
        let release;
        let blocked = new Promise(resolve => { release = resolve; });
        hub.oraclePublisher = {
            fetchLandedBatches: sinon.stub()
                .onFirstCall().returns(blocked)
                .onSecondCall().resolves({ batches: [], truncated: false })
        };
        let first = agg.repairPriceRoundsFromChain([{ first: 1, last: 1 }]);
        let queued = agg.repairPriceRoundsFromChain([{ first: 9, last: 9 }]);

        agg.stopPriceChainRestore();
        release({ batches: [{ first_round: 1, last_round: 1, action_index: 10 }], truncated: false });

        expect(await first).to.deep.equal({ ran: false, reason: 'repair stopped' });
        expect(await queued).to.deep.equal({ ran: false, reason: 'repair stopped' });
        expect(hub.db.findPriceSnapshotRowsForRounds.called).to.equal(false);
        expect(hub.oraclePublisher.fetchLandedBatches.calledOnce).to.equal(true);
        expect(await agg.repairPriceRoundsFromChain([{ first: 20, last: 20 }]))
            .to.deep.equal({ ran: false, reason: 'repair stopped' });
        expect(agg._priceRestoreRunning).to.equal(false);
    });

    it('releases the running latch when the drain throws unexpectedly', async function () {
        agg._priceRestoreQueue = {
            get length() { throw new Error('unexpected queue failure'); }
        };
        let failure;
        try {
            await agg.drainPriceChainRestoreQueue();
        } catch (e) {
            failure = e;
        }
        expect(failure).to.be.an('error').with.property('message', 'unexpected queue failure');
        expect(agg._priceRestoreRunning).to.equal(false);
    });

    it('starts a background walk from a bounded recent cursor and pages at the round cap', async function () {
        hub.db.findLatestPriceSnapshotRound = sinon.stub().resolves(10000);
        hub.db.findOldestPriceSnapshotRound = sinon.stub().resolves(100);
        hub.oraclePublisher = {
            fetchLandedBatches: sinon.stub().resolves({ batches: [], truncated: false })
        };
        await agg.repairPriceRoundsFromChain();
        expect(hub.oraclePublisher.fetchLandedBatches.calledOnceWithExactly(5905,
            Number.MAX_SAFE_INTEGER, 256)).to.equal(true);
    });

    it('walks backward after the recent window and reaches an older hole', async function () {
        const hole = 5000;
        hub.db.findLatestPriceSnapshotRound = sinon.stub().resolves(10000);
        hub.db.findOldestPriceSnapshotRound = sinon.stub().resolves(100);
        hub.oraclePublisher = {
            fetchLandedBatches: sinon.stub().callsFake(async (first, last) => ({
                batches: hole >= first && hole <= last
                    ? [{ first_round: hole, last_round: hole, action_index: 90 }]
                    : [],
                truncated: false
            })),
            fetchLandedBatchPayload: sinon.stub().resolves({ payload: {
                source_chain: 'DOGE', action_index: 90, rounds: [{ round: hole }], sigs: []
            } })
        };
        sinon.stub(agg, 'receiveValidatedBatch').resolves({ accepted: true, stored: 1,
            duplicates: 0, rejected: 0 });

        let result;
        for (let pass = 0; pass < 6 && (!result || result.restored === 0); pass++)
            result = await agg.repairPriceRoundsFromChain();

        expect(result).to.include({ ran: true, restored: 1 });
        expect(hub.oraclePublisher.fetchLandedBatches.callCount).to.be.at.most(6);
        expect(hub.db.findPriceSnapshotRowsForRounds.calledOnce).to.equal(true);
    });

    it('uses one price_snapshots presence read for both two and two hundred rounds', async function () {
        async function run(count) {
            let rounds = Array.from({ length: count }, (_, i) => ({ round: i + 1 }));
            hub.oraclePublisher = {
                fetchLandedBatches: sinon.stub().resolves({ batches: [{ first_round: 1,
                    last_round: count, action_index: 90 }], truncated: false }),
                fetchLandedBatchPayload: sinon.stub().resolves({ payload: { source_chain: 'DOGE',
                    action_index: 90, rounds, sigs: [] } })
            };
            hub.db.doQuery = sinon.stub().resolves([]);
            hub.db.findPriceSnapshotRowsForRounds = chainRestoreDb.findPriceSnapshotRowsForRounds;
            let ingest = sinon.stub(agg, 'receiveValidatedBatch').callsFake(async (chain, payload, options) =>
                ({ accepted: true, stored: options.targetRounds.size, duplicates: 0, rejected: 0 }));
            let result = await agg.repairPriceRoundsFromChain([{ first: 1, last: count }]);
            ingest.restore();
            return { result, statements: hub.db.doQuery.callCount,
                sql: hub.db.doQuery.firstCall && hub.db.doQuery.firstCall.args[0] };
        }

        let small = await run(2);
        let large = await run(200);
        expect(small.result.restored).to.equal(2);
        expect(large.result.restored).to.equal(200);
        expect([small.statements, large.statements]).to.deep.equal([1, 1]);
        expect(small.sql).not.to.match(/SELECT \*/);
    });
});
