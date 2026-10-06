/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * CrossChainBridgeEngine: a transfer's snapshot_block never sits below the BTC
 * block its own source leg was mined in, on the proposer and on the follower.
 *
 * The destination indexer proves the BTC escrow at the FIRST checkpoint at or
 * after snapshot_block (xchain-indexer bridge_proof_client/checkpoint_source.js,
 * selectCheckpoint). The hub read snapshot_block from its pushed BTC tip, which
 * can trail the indexer that reported the lock, so on the token rail (drive 24,
 * row 490092b8) a lock mined at 4912 was stamped 4911, a signed checkpoint at
 * exactly 4911 predated the lock, and the DOGE mint was refused every block
 * with the escrow read before the lock credited it.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const Database               = require('../../../../src/db');

// The recording driver the sibling bridge suites use, cut to the reads the poll, the
// proposer and the follower make, so the real bridge DB methods run as written.
function memDb(){
    const state = { persistedIndexes: [], exists: false, sourceTransferId: null };
    const db = Object.create(Database.prototype);
    db.state = state;
    db.doQuery = async function(sql, params){
        if(sql.startsWith('SELECT 1 FROM bridge_transfers')) return state.exists ? [{ 1: 1 }] : [];
        if(sql.startsWith('SELECT src_action_index FROM bridge_transfers'))
            return state.persistedIndexes.filter(i => params.slice(2).includes(i)).map(i => ({ src_action_index: i }));
        if(sql.startsWith('SELECT transfer_id FROM bridge_transfers WHERE network = ?'))
            return state.sourceTransferId ? [{ transfer_id: state.sourceTransferId }] : [];
        return [];
    };
    db.getChainTip = async () => ({ chainId: 'f'.repeat(64) });
    return db;
}

// An engine whose BTC tip view is `tip.block`, mutable so a test can advance it between
// polls the way a pushed tip catches up. Confirmations are 1 on every chain, the venue
// setting drive 24 ran with, which is what lets a lock be proposable in its own block.
function makeEngine(tip){
    const hub = {
        db: memDb(),
        network: 'regtest',
        p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge', LTC_INDEXER_URL: 'http://ltc' },
        hubDbBroadcaster: { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub(), dropAllForResync: sinon.stub() },
        capabilitySnapshot: {
            async getSnapshot(){ return { validators: [{ pubkey: 'a'.repeat(64), amount: '1' }] }; },
            async getWeightSnapshot(){
                return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }], count: 1, sourceCount: 1 };
            }
        },
        getPeerManager: () => null,
        getIdentity:    () => null,
        resolveBtcLatestBlock: async () => tip.block
    };
    const engine = new CrossChainBridgeEngine(hub);
    engine.transferConsensus = { propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(),
                                 on: () => {}, forgetFinalized: sinon.stub() };
    engine.policyConsensus   = { propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(),
                                 on: () => {}, forgetFinalized: sinon.stub() };
    engine.activation    = { bridge: () => true, token: () => true, policy: () => false };
    engine.confirmations = { BTC: 1, DOGE: 1, LTC: 1 };
    return engine;
}

// Drive 24's AT1 lock: BTC action index 2841 is illustrative, the heights are measured.
function btcLock(over){
    return Object.assign({
        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: 2841,
        src_address: 'mSrcAddress', dest_chain: 'DOGE', dest_address: 'nDestAddress',
        tick: 'FUFU', decimals: 8, amount: '5.00000000', min_depth: 0,
        block_index: 4912, confirmations: 1, tx_hash: 'd'.repeat(64), push_generation: 0
    }, over);
}

// A burn on DOGE releasing BTC escrow: its block_index is a DOGE height, a different
// axis from the BTC-anchored snapshot_block, so no floor can be read across the two.
function dogeBurn(over){
    return btcLock(Object.assign({
        transfer_kind: 'burn', src_chain: 'DOGE', src_action_index: 7,
        dest_chain: 'BTC', dest_address: 'mDestAddress', block_index: 90000
    }, over));
}

// Each chain's indexer answers the pending read with its own page.
function pages(engine, byChain){
    engine.indexerCall = sinon.stub().callsFake(async (coin) => byChain[coin] ||
        { latest_block_index: 0, network: 'regtest', transfers: [] });
}

// The indexer's selection rule, restated so the test states the consequence and not the
// label: the first checkpoint at or after snapshot_block.
function checkpointFor(snapshotBlock, checkpointHeights){
    return checkpointHeights.filter(h => h >= snapshotBlock).sort((a, b) => a - b)[0];
}

function proposedRow(engine, over){
    const row = Object.assign({
        snapshot_block: 4912, network: 'regtest', src_chain: 'BTC', src_action_index: 2841,
        src_address: 'mSrcAddress', dest_chain: 'DOGE', dest_address: 'nDestAddress',
        tick: 'FUFU', decimals: 8, amount: '5.00000000',
        effective_time: Math.floor(Date.now() / 1000) + 240, push_generation: 0
    }, over);
    row.transfer_id = engine.deriveTransferId(row.network, row.src_chain, row.src_action_index,
                                              row.dest_chain, row.dest_address);
    return row;
}

function registerProposer(){
    describe('the proposer', function(){
        it('holds a BTC lock while its tip trails the lock block, then proves it at a checkpoint that holds the lock (drive 24, row 490092b8)', async function(){
            const tip = { block: 4911 };
            const engine = makeEngine(tip);
            pages(engine, { BTC: { latest_block_index: 4912, network: 'regtest', transfers: [btcLock()] } });

            await engine.poll();
            expect(engine.transferConsensus.propose.called,
                'a record stamped at 4911 is proven against the 4911 checkpoint, before the 4912 lock').to.equal(false);

            tip.block = 4912;
            await engine.poll();
            expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
            const row = engine.transferConsensus.propose.firstCall.args[1].row;
            expect(row.snapshot_block).to.equal(4912);
            expect(checkpointFor(row.snapshot_block, [4911, 4913])).to.be.at.least(4912);
        });

        it('proposes a DOGE burn whose DOGE block height is far above the BTC snapshot_block', async function(){
            const engine = makeEngine({ block: 4912 });
            await engine.maybeFinalizeTransfer('DOGE', 'regtest', 90000, 4912, dogeBurn());
            expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
            expect(engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(4912);
        });
    });
}

function registerFollower(){
    describe('the follower', function(){
        it('refuses to co-sign a BTC lock whose snapshot_block sits below the block its own indexer mined it in', async function(){
            const engine = makeEngine({ block: 4912 });
            pages(engine, { BTC: { latest_block_index: 4912, network: 'regtest', transfers: [btcLock()] } });
            expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: 4911 }))).to.equal(false);
        });

        it('co-signs the same lock anchored at its own block, the row an old leader also produces once its tip catches up', async function(){
            const engine = makeEngine({ block: 4912 });
            pages(engine, { BTC: { latest_block_index: 4913, network: 'regtest', transfers: [btcLock()] } });
            expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: 4912 }))).to.equal(true);
            expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: 4913 }))).to.equal(true);
        });

        it('co-signs a DOGE burn anchored at a BTC height below the DOGE block it was mined in', async function(){
            const engine = makeEngine({ block: 4912 });
            pages(engine, { DOGE: { latest_block_index: 90000, network: 'regtest', transfers: [dogeBurn()] } });
            expect(await engine.validateProposedMatch(proposedRow(engine, {
                src_chain: 'DOGE', src_action_index: 7, dest_chain: 'BTC', dest_address: 'mDestAddress'
            }))).to.equal(true);
        });
    });
}

describe('CrossChainBridgeEngine', function(){
    afterEach(function(){ sinon.restore(); });
    describe('snapshot_block covers the source leg', function(){
        registerProposer();
        registerFollower();
    });
});
