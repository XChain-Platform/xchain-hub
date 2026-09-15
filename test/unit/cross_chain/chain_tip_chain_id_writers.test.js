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
 *
 * Chain tip and chain ID writers across the cross-chain engines.
 *
 * Tests that both DEX and call engines stamp btc_chain_id on their rows
 * from the identity provider, even when the read throws or returns null.
 *
 **********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { DB_METHODS } = require('../../helpers/mockHub.js');

const snapWrite            = require('../../../src/lib/capability_snapshot_write.js');
const CrossChainDexEngine  = require('../../../src/cross_chain/dex_engine.js');
const CrossChainCallEngine = require('../../../src/cross_chain/call_engine.js');

const LOCAL_ID   = '00000000c937983704a73af28acdec37b049d214adbda81d7e2a3dd146f6ed09';
const FOREIGN_ID = '000000005c8ba8e1e0a4a2e6f2d3c4b5a6978869fedcba0987654321abcdef01';

function registerUnsignedIdentitySuite() {
describe('the identity reaches no signed canonical', function () {
        it('canonicalMatch is byte-identical with and without btc_chain_id on the row', function () {
            const eng = Object.create(CrossChainDexEngine.prototype);
            const row = {
                match_id: 'm'.repeat(64), snapshot_block: 131, network: 'regtest',
                a_chain: 'BTC', a_action_index: 8, a_tick: 'XCH', a_amount: '1', a_ownership: 0, a_payout_addr: 'bc1a',
                b_chain: 'LTC', b_action_index: 3, b_tick: 'XCH', b_amount: '2', b_ownership: 0, b_payout_addr: 'ltc1b',
                effective_time: 1757298240, a_kind: 'swap', a_filled_before: '0', b_kind: 'swap', b_filled_before: '0',
                a_payout_legs: null, b_payout_legs: null
            };
            const bare    = eng.canonicalMatch(row, 0);
            const stamped = eng.canonicalMatch(Object.assign({}, row, { btc_chain_id: FOREIGN_ID }), 0);
            expect(stamped).to.equal(bare);
            expect(bare).to.not.include(FOREIGN_ID);
        });
    });
}

function registerSnapshotWriterSuite() {
describe('capability_snapshots writer stamps every row', function () {
        const VALIDATORS = [
            { pubkey: 'AA'.repeat(32), weight: '10', source: 'src-a' },
            { pubkey: 'bb'.repeat(32), weight: '20', source: 'src-b' }
        ];
        function memDb(getChainTip) {
            const db = { ...DB_METHODS, calls: [], async doQuery(sql, params) { this.calls.push({ sql: String(sql), params }); return []; } };
            // The spread is here for the named query methods only. getChainTip
            // came with it, and one case below is precisely "a database layer
            // that exposes no getChainTip at all", so it goes back off unless
            // this fixture was asked for one.
            delete db.getChainTip;
            if (getChainTip) db.getChainTip = getChainTip;
            return db;
        }
        function stampedIds(db) {
            const { sql, params } = db.calls[0];
            const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            const idx  = cols.indexOf('btc_chain_id');
            expect(idx, 'btc_chain_id missing from the INSERT column list').to.be.greaterThan(-1);
            const out = [];
            for (let i = 0; i < params.length; i += cols.length) out.push(params[i + idx]);
            return out;
        }

        it('stamps the identity the caller passes on every row of the set', async function () {
            const db = memDb();
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS, LOCAL_ID);
            expect(stampedIds(db)).to.deep.equal([LOCAL_ID, LOCAL_ID]);
        });

        it('resolves the identity itself for a four-argument caller', async function () {
            const getChainTip = sinon.stub().resolves({ blockHeight: 131, blockTime: 1, chainId: LOCAL_ID });
            const db = memDb(getChainTip);
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS);
            expect(stampedIds(db)).to.deep.equal([LOCAL_ID, LOCAL_ID]);
            expect(getChainTip.firstCall.args[0]).to.equal('bitcoin');
        });

        it('stamps NULL when the database layer exposes no getChainTip at all', async function () {
            const db = memDb();
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS);
            expect(stampedIds(db)).to.deep.equal([null, null]);
        });

        it('stamps NULL, and still writes the set, when the identity read throws', async function () {
            const db = memDb(sinon.stub().rejects(new Error('configs read failed')));
            const rows = await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS);
            expect(rows).to.have.lengthOf(2);
            expect(stampedIds(db)).to.deep.equal([null, null]);
        });

        it('keeps the whole set in ONE statement (the atomicity the writer exists for)', async function () {
            const db = memDb();
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS, LOCAL_ID);
            expect(db.calls).to.have.lengthOf(1);
        });
    });
}

function registerCallWriterSuite() {
describe('CrossChainCallEngine stamps the call row', function () {
        function engineWith(chainId) {
            const eng = Object.create(CrossChainCallEngine.prototype);
            eng.network = 'regtest';
            eng.db = { ...DB_METHODS,
                doQuery: sinon.stub().resolves({ affectedRows: 1 }),
                getChainTip: sinon.stub().resolves(chainId === null ? null : { blockHeight: 131, blockTime: 1, chainId: chainId })
            };
            eng.persistCapabilitySnapshot = sinon.stub().resolves(1);
            eng.mirrorCallRow = sinon.stub().resolves();
            eng._inflight = new Map();
            eng.emit = sinon.stub();
            return eng;
        }
        const callRow = () => ({
            call_id: 'c'.repeat(64), phase: 'dispatch', snapshot_block: 131, network: 'regtest',
            source_chain: 'BTC', source_action_index: 41, source_contract_index: 5,
            target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival', params_json: '["x"]',
            gas_limit: 50000, cross_hops: 1, effective_time: 1757298240,
            result_status: null, return_payload_b64: null, push_generation: 0, round_id: 'r1'
        });

        it('stamps the identity and re-stamps it on the ON DUPLICATE KEY UPDATE path', async function () {
            const eng = engineWith(LOCAL_ID);
            sinon.stub(console, 'log');
            await eng.writeFinalizedRow({ row: callRow(), signatures: [] });
            const call = eng.db.doQuery.getCalls().find(c => /INSERT INTO cross_chain_calls/.test(String(c.args[0])));
            expect(call, 'no INSERT was issued').to.not.equal(undefined);
            const sql  = String(call.args[0]);
            const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            const idx  = cols.indexOf('btc_chain_id');
            expect(idx, 'btc_chain_id missing from the INSERT column list').to.be.greaterThan(-1);
            expect(call.args[1][idx]).to.equal(LOCAL_ID);
            // A row revived after a reorg must not keep the identity of the chain it was
            // first written on.
            expect(sql).to.include('btc_chain_id = VALUES(btc_chain_id)');
        });

        it('stamps NULL when the hub has not been told its chain', async function () {
            const eng = engineWith(null);
            sinon.stub(console, 'log');
            await eng.writeFinalizedRow({ row: callRow(), signatures: [] });
            const call = eng.db.doQuery.getCalls().find(c => /INSERT INTO cross_chain_calls/.test(String(c.args[0])));
            const cols = String(call.args[0]).match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            expect(call.args[1][cols.indexOf('btc_chain_id')]).to.equal(null);
        });
    });
}

function registerDexWriterSuite() {
describe('CrossChainDexEngine stamps the match row', function () {
        function engineWith(getChainTip) {
            const eng = Object.create(CrossChainDexEngine.prototype);
            eng.network = 'regtest';
            eng.db = { ...DB_METHODS, doQuery: sinon.stub().resolves({ affectedRows: 1 }) };
            if (getChainTip) eng.db.getChainTip = getChainTip;
            return eng;
        }
        const matchRow = () => ({
            match_id: 'm'.repeat(64), snapshot_block: 131, network: 'regtest',
            a_chain: 'BTC', a_action_index: 8, a_kind: 'swap', a_tick: 'XCH', a_amount: '1', a_filled_before: '0', a_ownership: 0, a_payout_addr: 'bc1a', a_payout_legs: null,
            b_chain: 'LTC', b_action_index: 3, b_kind: 'swap', b_tick: 'XCH', b_amount: '2', b_filled_before: '0', b_ownership: 0, b_payout_addr: 'ltc1b', b_payout_legs: null,
            effective_time: 1757298240, finalizing_view: 0, validator_signatures: '[]',
            a_push_generation: 0, b_push_generation: 0
        });

        function insertCall(eng) {
            const call = eng.db.doQuery.getCalls().find(c => /INSERT IGNORE INTO cross_chain_matches/.test(String(c.args[0])));
            expect(call, 'no INSERT was issued').to.not.equal(undefined);
            const cols = String(call.args[0]).match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            return { cols, vals: call.args[1], idx: cols.indexOf('btc_chain_id') };
        }

        it('writes the identity the Bitcoin indexer reported for the row network', async function () {
            const getChainTip = sinon.stub().resolves({ blockHeight: 131, blockTime: 1, chainId: LOCAL_ID });
            const eng = engineWith(getChainTip);
            await eng.insertMatchRow(matchRow());
            const { cols, vals, idx } = insertCall(eng);
            expect(idx, 'btc_chain_id missing from the INSERT column list').to.be.greaterThan(-1);
            expect(vals).to.have.lengthOf(cols.length);
            expect(vals[idx]).to.equal(LOCAL_ID);
            expect(getChainTip.firstCall.args).to.deep.equal(['bitcoin', 'regtest']);
        });

        it('writes NULL when the hub has not been told its chain', async function () {
            const eng = engineWith(sinon.stub().resolves(null));
            await eng.insertMatchRow(matchRow());
            const { vals, idx } = insertCall(eng);
            expect(vals[idx]).to.equal(null);
        });

        it('writes NULL, and still commits the match, when the identity read throws', async function () {
            const eng = engineWith(sinon.stub().rejects(new Error('configs read failed')));
            const inserted = await eng.insertMatchRow(matchRow());
            expect(inserted, 'a finalized match must never be lost to an identity lookup').to.be.true;
            const { vals, idx } = insertCall(eng);
            expect(vals[idx]).to.equal(null);
        });

        it('does not put the identity on the row object the canonical is built from', async function () {
            const eng = engineWith(sinon.stub().resolves({ chainId: LOCAL_ID }));
            const row = matchRow();
            await eng.insertMatchRow(row);
            expect(row).to.not.have.property('btc_chain_id');
        });
    });
}

describe('cross-chain chain identity (btc_chain_id)', function () {
    this.timeout(15000);

    afterEach(function () { sinon.restore(); });

    registerDexWriterSuite();

    registerCallWriterSuite();

    registerSnapshotWriterSuite();

    // ────────────────────────────────────────────────────────────────────────
    // Transport, not consensus (D4 / ATr3)
    // ────────────────────────────────────────────────────────────────────────

    registerUnsignedIdentitySuite();
});
