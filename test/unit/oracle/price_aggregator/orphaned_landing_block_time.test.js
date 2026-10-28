'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const prices = require('../../../../src/db/prices/index.js');
const { retractFromActionIndex } = require('../../../../src/oracle/price_aggregator/retract.js');

// The landing windows come from one source-chain range read; the self-finalized rows are then
// matched by literal round bounds and clock, so no statement joins price_snapshots to itself.
async function selectsThroughSourceActionIndex() {
    const doQuery = sinon.stub();
    doQuery.onCall(0).resolves([{ batch_block_time: 1700000000, first_round: 100, last_round: 105 }]);
    doQuery.onCall(1).resolves([{ round_number: 101 }]);
    doQuery.onCall(2).resolves([{ batch_block_time: 1700000000, first_round: 100, last_round: 105 }]);
    doQuery.onCall(3).resolves({ affectedRows: 1 });
    const found = await prices.findSelfFinalizedRoundsForBatchRetraction.call(
        { doQuery }, 'BTC', 40, 50, 7, true, true);
    const reset = await prices.resetSelfFinalizedBatchBlockTimeForRetraction.call(
        { doQuery }, 'BTC', 40, 50, 7, true, true);

    const [landingSql, landingArgs] = doQuery.firstCall.args;
    expect(landingSql).to.include('source_chain = ? AND source_action_index >= ? AND source_action_index <= ?');
    expect(landingSql).to.include('push_generation <= ?');
    expect(landingSql).to.include("'$.batch.first_round'");
    expect(landingArgs).to.deep.equal(['BTC', 40, 50, 7]);
    const [sql, args] = doQuery.secondCall.args;
    expect(sql).to.include('source_action_index IS NULL');
    expect(sql).to.include('round_number BETWEEN ? AND ? AND batch_block_time = ?');
    expect(args).to.deep.equal([100, 105, 1700000000]);
    const [resetSql, resetArgs] = doQuery.getCall(3).args;
    expect(resetSql).to.match(/^UPDATE price_snapshots SET batch_block_time = 0 WHERE /);
    expect(resetArgs).to.deep.equal(args);
    for (const call of doQuery.getCalls())
        expect(call.args[0], call.args[0]).not.to.match(/JOIN|AS self_finalized|AS batch_landed/);
    expect(found).to.deep.equal([{ round_number: 101 }]);
    expect(reset).to.deep.equal({ affectedRows: 1 });
}

async function resetsBeforeDelete() {
    const order = [];
    const resetRow = {
        round_number: 101,
        coin_pair: 'BTC/USD',
        source_action_index: null,
        batch_block_time: 0
    };
    const events = [];
    const publisher = { clearPublishedMarkers: sinon.stub().resolves() };
    const self = {
        hub: { oraclePublisher: publisher },
        fenceNetwork: () => 'mainnet',
        emit: (name, event) => events.push([name, event]),
        db: {
            bumpPriceIngestWatermark: async () => {},
            findBatchPriceSnapshotRoundsForRetraction: async () => [{ round_number: 101 }],
            findSelfFinalizedRoundsForBatchRetraction: async (...args) => {
                order.push(['find-reset', ...args]);
                return [{ round_number: 101 }, { round_number: '101' }];
            },
            resetSelfFinalizedBatchBlockTimeForRetraction: async (...args) => {
                order.push(['reset', ...args]);
                return { affectedRows: 1 };
            },
            findPriceSnapshotsForRound: async (round) => {
                order.push(['read-reset', round]);
                return [resetRow];
            },
            insertPriceTombstonesForRetraction: async () => {
                order.push(['tombstone']);
                return { affectedRows: 1 };
            },
            deletePriceSnapshotsForRetraction: async () => {
                order.push(['delete-snapshots']);
                return { affectedRows: 1 };
            },
            deleteOraclePricesForRetraction: async () => {
                order.push(['delete-oracle']);
                return { affectedRows: 0 };
            }
        }
    };

    const result = await retractFromActionIndex.call(self, 'BTC', 40, 50, 7);

    expect(order.map(entry => entry[0])).to.deep.equal([
        'find-reset', 'reset', 'read-reset', 'tombstone', 'delete-snapshots', 'delete-oracle'
    ]);
    expect(order[0].slice(1)).to.deep.equal(['BTC', 40, 50, 7, true, true]);
    expect(order[1].slice(1)).to.deep.equal(['BTC', 40, 50, 7, true, true]);
    expect(events).to.deep.equal([['row:inserted', {
        table: 'price_snapshots', row: resetRow, origin: 'chain-ingest'
    }], ['row:deleted', {
        table: 'price_snapshots', source_chain: 'BTC', from_action_index: 40,
        to_action_index: 50, retraction_generation: 7
    }]]);
    expect(result).to.deep.equal({ retracted: { price_snapshots: 1, oracle_prices: 0 } });
}

async function leavesLandingQueuedOnFailure() {
    sinon.stub(console, 'error');
    const self = {
        hub: { oraclePublisher: { clearPublishedMarkers: sinon.stub().resolves() } },
        fenceNetwork: () => 'mainnet',
        emit: sinon.stub(),
        db: {
            findBatchPriceSnapshotRoundsForRetraction: sinon.stub().resolves([{ round_number: 101 }]),
            findSelfFinalizedRoundsForBatchRetraction: sinon.stub().resolves([{ round_number: 101 }]),
            resetSelfFinalizedBatchBlockTimeForRetraction: sinon.stub().rejects(new Error('lock timeout')),
            insertPriceTombstonesForRetraction: sinon.stub(),
            deletePriceSnapshotsForRetraction: sinon.stub(),
            deleteOraclePricesForRetraction: sinon.stub()
        }
    };

    const result = await retractFromActionIndex.call(self, 'DOGE', 90);

    expect(result.error).to.equal('batch landing times not reset for DOGE (lock timeout)');
    expect(self.db.insertPriceTombstonesForRetraction.called).to.equal(false);
    expect(self.db.deletePriceSnapshotsForRetraction.called).to.equal(false);
    expect(self.emit.called).to.equal(false);
}

// A publisher without clearPublishedMarkers (or no publisher at all) still has
// self-finalized rows stamped by the orphaned landing, so the reset must not
// hang off the marker seam.
async function resetsWithoutMarkerSeam() {
    sinon.stub(console, 'warn');
    const order = [];
    const self = {
        hub: { oraclePublisher: {} },
        fenceNetwork: () => 'mainnet',
        emit: sinon.stub(),
        db: {
            findBatchPriceSnapshotRoundsForRetraction: sinon.stub().resolves([{ round_number: 101 }]),
            findSelfFinalizedRoundsForBatchRetraction: async (...args) => {
                order.push(['find-reset', ...args]);
                return [{ round_number: 101 }];
            },
            resetSelfFinalizedBatchBlockTimeForRetraction: async (...args) => {
                order.push(['reset', ...args]);
                return { affectedRows: 1 };
            },
            findPriceSnapshotsForRound: async () => [{ round_number: 101, source_action_index: null, batch_block_time: 0 }],
            insertPriceTombstonesForRetraction: async () => ({ affectedRows: 1 }),
            deletePriceSnapshotsForRetraction: async () => ({ affectedRows: 1 }),
            deleteOraclePricesForRetraction: async () => ({ affectedRows: 0 })
        }
    };

    const result = await retractFromActionIndex.call(self, 'LTC', 12);

    expect(order.map(entry => entry[0])).to.deep.equal(['find-reset', 'reset']);
    expect(order[1].slice(1, 3)).to.deep.equal(['LTC', 12]);
    expect(self.db.findBatchPriceSnapshotRoundsForRetraction.called).to.equal(false);
    expect(result).to.deep.equal({ retracted: { price_snapshots: 1, oracle_prices: 0 } });
}

async function keepsReLandEligible() {
    const doQuery = sinon.stub().resolves({ affectedRows: 1 });
    await prices.updatePriceSnapshotByRoundNumber.call({ doQuery }, 1700009999, 101, 1700009999);
    const [sql, args] = doQuery.firstCall.args;
    expect(sql).to.include('batch_block_time = 0 OR batch_block_time > ?');
    expect(args).to.deep.equal([1700009999, 101, 1700009999]);
}

describe('orphaned PRICE batch landing time retraction', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('selects self-finalized rows through the retracted source_action_index and batch_block_time', selectsThroughSourceActionIndex);

    it('resets and re-emits self-finalized rows before retractFromActionIndex deletes the landing', resetsBeforeDelete);

    it('leaves the landing queued when resetting batch_block_time fails', leavesLandingQueuedOnFailure);

    it('resets batch_block_time when the publisher cannot clear markers', resetsWithoutMarkerSeam);

    it('keeps the re-land path eligible to replace the reset zero clock', keepsReLandEligible);
});
