'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const prices = require('../../../../src/db/prices/index.js');
const { retractFromActionIndex } = require('../../../../src/oracle/price_aggregator/retract.js');

describe('orphaned PRICE batch landing time retraction', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('selects self-finalized rows through the retracted source_action_index and batch_block_time', async function () {
        const doQuery = sinon.stub().resolves([]);
        await prices.findSelfFinalizedRoundsForBatchRetraction.call(
            { doQuery }, 'BTC', 40, 50, 7, true, true);
        await prices.resetSelfFinalizedBatchBlockTimeForRetraction.call(
            { doQuery }, 'BTC', 40, 50, 7, true, true);

        const [sql, args] = doQuery.firstCall.args;
        const [resetSql, resetArgs] = doQuery.secondCall.args;
        expect(sql).to.include('self_finalized.source_action_index IS NULL');
        expect(sql).to.include('self_finalized.batch_block_time = batch_landed.batch_block_time');
        expect(sql).to.include('batch_landed.source_action_index >= ? AND batch_landed.source_action_index <= ?');
        expect(sql).to.include('batch_landed.push_generation <= ?');
        expect(sql).to.include("'$.batch.first_round'");
        expect(sql).to.include("'$.batch.last_round'");
        expect(args).to.deep.equal(['BTC', 40, 50, 7]);
        expect(resetSql).to.include('SET self_finalized.batch_block_time = 0');
        expect(resetSql).to.include('batch_landed.source_chain = ?');
        expect(resetArgs).to.deep.equal(args);
    });

    it('resets and re-emits self-finalized rows before retractFromActionIndex deletes the landing', async function () {
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
    });

    it('leaves the landing queued when resetting batch_block_time fails', async function () {
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
    });

    it('keeps the re-land path eligible to replace the reset zero clock', async function () {
        const doQuery = sinon.stub().resolves({ affectedRows: 1 });
        await prices.updatePriceSnapshotByRoundNumber.call({ doQuery }, 1700009999, 101, 1700009999);
        const [sql, args] = doQuery.firstCall.args;
        expect(sql).to.include('batch_block_time = 0 OR batch_block_time > ?');
        expect(args).to.deep.equal([1700009999, 101, 1700009999]);
    });
});
