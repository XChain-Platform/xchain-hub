'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const Database = require('../../../../../src/db');
const finalize = require('../../../../../src/cross_chain/dex/finalize.js');

function matchRow(){
    return {
        match_id: 'f'.repeat(64), snapshot_block: 150, network: 'regtest',
        a_chain: 'LTC', a_action_index: 1, a_push_generation: 2,
        a_kind: 'swap', a_tick: 'XCH', a_amount: '100', a_filled_before: '0',
        a_ownership: 0, a_payout_addr: 'La',
        b_chain: 'DOGE', b_action_index: 2, b_push_generation: 2,
        b_kind: 'swap', b_tick: 'XCH', b_amount: '500', b_filled_before: '0',
        b_ownership: 0, b_payout_addr: 'Db', effective_time: 1700000000
    };
}

function recordingDb(row){
    const db = Object.create(Database.prototype);
    let releaseInsert;
    const insertEntered = new Promise(resolve => { db.signalInsert = resolve; });
    db.releaseInsert = () => releaseInsert();
    db.insertEntered = insertEntered;
    db.calls = [];
    db.doQuery = async (sql, params) => {
        db.calls.push({ sql, params });
        if(sql.startsWith('INSERT IGNORE INTO cross_chain_matches')){
            db.signalInsert();
            return new Promise(resolve => { releaseInsert = () => resolve({ affectedRows: 1 }); });
        }
        if(sql.startsWith('SELECT match_id, a_chain')) return [row];
        if(sql.startsWith("UPDATE cross_chain_matches SET status = 'retracted'")) return { affectedRows: 1 };
        return [];
    };
    return db;
}

function engineFor(row){
    const db = recordingDb(row);
    const engine = Object.assign({
        db,
        broadcaster: { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() },
        consensus: { forgetFinalized: sinon.stub() },
        _inflight: new Set([row.match_id]),
        persistCapabilitySnapshot: sinon.stub().resolves(1),
        resolveBtcChainId: sinon.stub().resolves('a'.repeat(64)),
        applyCommit: sinon.stub(),
        emit: sinon.stub()
    }, finalize);
    return engine;
}

describe('CrossChainDexEngine insert-window retraction fence', function(){
    afterEach(function(){ sinon.restore(); });

    it('waits for a covered insert and retracts it before capacity or mirror can remain live', async function(){
        const row = matchRow();
        const engine = engineFor(row);
        const writing = engine.writeFinalizedMatch({ row, signatures: [], view: 0 });
        await engine.db.insertEntered;

        let retractionFinished = false;
        const retracting = engine.retractMatchesForReorg('LTC', 1, 1, 2)
            .then(() => { retractionFinished = true; });
        await Promise.resolve();
        expect(retractionFinished, 'the database scan must wait for the covered insert').to.equal(false);

        engine.db.releaseInsert();
        await Promise.all([writing, retracting]);
        expect(engine.db.calls.some(call =>
            call.sql.startsWith("UPDATE cross_chain_matches SET status = 'retracted'"))).to.equal(true);
        expect(engine.applyCommit.called, 'capacity must remain unchanged').to.equal(false);
        expect(engine.broadcaster.broadcastRow.called).to.equal(false);
        expect(engine.broadcaster.broadcastDeletion.calledOnce).to.equal(true);
        expect(engine.consensus.forgetFinalized.called).to.equal(true);
    });
});
