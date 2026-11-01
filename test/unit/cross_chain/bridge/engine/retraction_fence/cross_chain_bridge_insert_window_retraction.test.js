'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const Database = require('../../../../../../src/db');
const persist = require('../../../../../../src/cross_chain/bridge/persist.js');

function transferRow(){
    return {
        transfer_id: 'b'.repeat(64), snapshot_block: 150, network: 'regtest',
        src_chain: 'BTC', src_action_index: 41, src_address: 'mSrc',
        dest_chain: 'DOGE', dest_address: 'nDest', tick: 'XCHAIN', decimals: 8,
        amount: '5.00000000', effective_time: 1757000000, push_generation: 2
    };
}

function recordingDb(row){
    const db = Object.create(Database.prototype);
    let releaseInsert;
    let inserted = false;
    db.insertEntered = new Promise(resolve => { db.signalInsert = resolve; });
    db.releaseInsert = () => releaseInsert();
    db.calls = [];
    db.doQuery = async (sql, params) => {
        db.calls.push({ sql, params });
        if(sql.startsWith('INSERT IGNORE INTO bridge_transfers')){
            db.signalInsert();
            return new Promise(resolve => {
                releaseInsert = () => {
                    inserted = true;
                    resolve({ affectedRows: 1 });
                };
            });
        }
        if(sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE'))
            return inserted ? [{ transfer_id: row.transfer_id }] : [];
        if(sql.startsWith("UPDATE bridge_transfers SET status = 'retracted'")) return { affectedRows: 1 };
        return [];
    };
    return db;
}

function engineFor(row){
    const broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() };
    return Object.assign({
        db: recordingDb(row), broadcaster,
        transferConsensus: { forgetFinalized: sinon.stub() },
        _inflight: new Set([row.transfer_id]), _sourceLegGuards: new Map(),
        persistCapabilitySnapshot: sinon.stub().resolves(1),
        resolveBtcChainId: sinon.stub().resolves('a'.repeat(64)),
        releaseSourceLegGuard: sinon.stub(), emit: sinon.stub()
    }, persist);
}

describe('CrossChainBridgeEngine insert-window retraction fence', function(){
    afterEach(function(){ sinon.restore(); });

    it('waits for a covered insert and retracts it before it can be mirrored', async function(){
        const row = transferRow();
        const engine = engineFor(row);
        const writing = engine.writeFinalizedTransfer({ row, signatures: [], view: 0 });
        await engine.db.insertEntered;

        let retractionFinished = false;
        const retracting = engine.retractTransfersForReorg('BTC', 41, 41, 2)
            .then(() => { retractionFinished = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(retractionFinished, 'the database scan must wait for the covered insert').to.equal(false);

        engine.db.releaseInsert();
        await Promise.all([writing, retracting]);
        expect(engine.db.calls.some(call =>
            call.sql.startsWith("UPDATE bridge_transfers SET status = 'retracted'"))).to.equal(true);
        expect(engine.broadcaster.broadcastRow.called).to.equal(false);
        expect(engine.broadcaster.broadcastDeletion.calledOnce).to.equal(true);
        expect(engine.transferConsensus.forgetFinalized.called).to.equal(true);
    });

    it('loses the zero-row scan when the covered-write wait is disabled', async function(){
        const row = transferRow();
        const engine = engineFor(row);
        engine.waitForCoveredWrites = sinon.stub().resolves();
        const writing = engine.writeFinalizedTransfer({ row, signatures: [], view: 0 });
        await engine.db.insertEntered;

        const retracted = await engine.retractTransfersForReorg('BTC', 41, 41, 2);
        expect(retracted).to.equal(0);
        engine.db.releaseInsert();
        await writing;

        expect(engine.db.calls.some(call =>
            call.sql.startsWith("UPDATE bridge_transfers SET status = 'retracted'"))).to.equal(false);
        expect(engine.db.calls.some(call =>
            call.sql.startsWith('INSERT IGNORE INTO bridge_transfers'))).to.equal(true);
    });
});
