/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * db.js bridge_transfers writers and readers, over a recording driver so the
 * SQL and its parameters are what is asserted.
 *
 * transfer_id is a pure function of the source leg, so a leg reorged out and
 * re-mined ALWAYS lands on its retracted row's id, and the revive branch of
 * insertBridgeTransfer is the write path every re-mined leg takes. A revive
 * that kept the retracted round's snapshot_block would leave a row whose new
 * signature set no indexer can verify against the capability snapshot the row
 * names, so every leader-choice column must move with the signatures.
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const Database = require('../../src/db.js');

function recordingDb(answers){
    const db = Object.create(Database.prototype);
    db.calls = [];
    db.doQuery = async function(sql, params){
        db.calls.push({ sql, params: params || [] });
        return answers(sql, params || [], db.calls.length);
    };
    return db;
}

function finalizedRow(over){
    return Object.assign({
        transfer_id: 'b'.repeat(64), snapshot_block: 1618, network: 'regtest',
        src_chain: 'BTC', src_action_index: 123, src_address: 'mSrc',
        dest_chain: 'DOGE', dest_address: 'nDest', tick: 'XCHAIN', decimals: 8,
        amount: '30.00000000', effective_time: 1789265000, finalizing_view: 2,
        validator_signatures: '[{"pubkey":"a","sig":"b"}]', push_generation: 3,
        btc_chain_id: 'f'.repeat(64)
    }, over);
}

describe('db.js bridge_transfers', function(){

    describe('insertBridgeTransfer', function(){

        it('returns true on a fresh insert and never reaches the revive', async function(){
            const db = recordingDb(() => ({ affectedRows: 1 }));
            expect(await db.insertBridgeTransfer(finalizedRow())).to.equal(true);
            expect(db.calls).to.have.length(1);
            expect(db.calls[0].sql).to.match(/^INSERT IGNORE INTO bridge_transfers/);
        });

        it('revives a retracted row with EVERY column the new round chose', async function(){
            const db = recordingDb((sql) => sql.startsWith('INSERT IGNORE') ? { affectedRows: 0 } : { affectedRows: 1 });
            const row = finalizedRow();
            expect(await db.insertBridgeTransfer(row)).to.equal(true);
            expect(db.calls).to.have.length(2);
            const revive = db.calls[1];
            expect(revive.sql).to.match(/^UPDATE bridge_transfers SET status = 'finalized'/);
            expect(revive.sql).to.contain("WHERE transfer_id = ? AND status = 'retracted'");
            // Each leader-choice column is assigned, and its parameter is the row's own value
            // in the position the statement names it.
            for(const col of ['validator_signatures', 'finalizing_view', 'effective_time',
                              'snapshot_block', 'push_generation', 'btc_chain_id']){
                const at = revive.sql.indexOf(col + ' = ?');
                expect(at, col + ' must be assigned by the revive').to.be.greaterThan(-1);
                const position = (revive.sql.slice(0, at).match(/\?/g) || []).length;
                expect(revive.params[position], col + ' parameter').to.equal(row[col]);
            }
            expect(revive.params[revive.params.length - 1]).to.equal(row.transfer_id);
        });

        it('returns false when the row is already finalized (a duplicate finalize is a no-op)', async function(){
            const db = recordingDb(() => ({ affectedRows: 0 }));
            expect(await db.insertBridgeTransfer(finalizedRow())).to.equal(false);
            expect(db.calls).to.have.length(2);
        });
    });

    describe('getBridgeTransferSourceIndexes', function(){

        it('asks once, for the deduplicated integer subset, filtered to non-retracted rows', async function(){
            const db = recordingDb(() => [{ src_action_index: 41 }, { src_action_index: '43' }]);
            const held = await db.getBridgeTransferSourceIndexes('regtest', 'BTC', [41, 42, 41, 43, NaN, 4.5, undefined]);
            expect(db.calls).to.have.length(1);
            expect(db.calls[0].sql).to.contain("status <> 'retracted'");
            expect(db.calls[0].sql).to.contain('src_action_index IN (?, ?, ?)');
            expect(db.calls[0].params).to.deep.equal(['regtest', 'BTC', 41, 42, 43]);
            expect([...held]).to.deep.equal([41, 43]);
        });

        it('answers an empty page without a query', async function(){
            const db = recordingDb(() => { throw new Error('must not query'); });
            expect((await db.getBridgeTransferSourceIndexes('regtest', 'BTC', [])).size).to.equal(0);
            expect((await db.getBridgeTransferSourceIndexes('regtest', 'BTC', [NaN])).size).to.equal(0);
            expect(db.calls).to.have.length(0);
        });
    });
});
