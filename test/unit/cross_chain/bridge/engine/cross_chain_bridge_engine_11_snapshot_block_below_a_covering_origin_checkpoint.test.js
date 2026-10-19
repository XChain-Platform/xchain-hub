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
 * CrossChainBridgeEngine: past the anchor proof-ready flag day a DOGE- or LTC-sourced lock
 * is stamped one below the snapshot_block of the first finalized origin checkpoint covering
 * it, so the destination indexer's strict anchor-axis pick lands on that checkpoint at once.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const CrossChainBridgeEngine = require('../../../../../src/cross_chain/bridge_engine.js');
const Database               = require('../../../../../src/db');
const registry               = require('../../../../../src/consensus/gate_registry.js');
const { BRIDGE_ANCHOR_PROOF_READY_ACTIVATION: GATE } = require('../../../../../src/cross_chain/bridge/proof_ready_snapshot.js');

const TIP      = 5000;            // the hub's BTC tip
const DOGE_LEG = 90000;           // the lock's DOGE block
const LTC_LEG  = 40000;           // the lock's LTC block

// checkpoints: [{ chain, block_index, snapshot_block }], answered the way the table's
// lowest-height read orders them (block_index ASC, then the latest sequence).
function memDb(checkpoints){
    const db = Object.create(Database.prototype);
    db.state = { checkpoints };
    db.doQuery = async function(sql, params){
        if(sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index >=')){
            const held = db.state.checkpoints
                .filter(c => c.chain === params[0] && c.block_index >= params[2])
                .sort((a, b) => (a.block_index - b.block_index) || (b.snapshot_block - a.snapshot_block));
            return held.length ? [Object.assign({ checkpoint_seq: held[0].snapshot_block }, held[0])] : [];
        }
        return [];
    };
    db.getChainTip = async () => ({ chainId: 'f'.repeat(64) });
    return db;
}

function makeEngine(checkpoints, tipBlock){
    const hub = {
        db: memDb(checkpoints),
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
        resolveBtcLatestBlock: async () => tipBlock
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

function lock(srcChain, over){
    return Object.assign({
        transfer_kind: 'lock', src_chain: srcChain, src_action_index: 9,
        src_address: 'nSrcAddress', dest_chain: 'BTC', dest_address: 'mDestAddress',
        tick: 'FUFU', decimals: 8, amount: '5.00000000', min_depth: 0,
        block_index: srcChain === 'LTC' ? LTC_LEG : DOGE_LEG, confirmations: 1,
        tx_hash: 'd'.repeat(64), push_generation: 0
    }, over);
}

function cp(chain, blockIndex, snapshotBlock){
    return { chain, block_index: blockIndex, snapshot_block: snapshotBlock };
}

// The destination indexer's pick on the anchor axis: the first checkpoint of the origin chain
// whose snapshot_block is strictly above the row's, as its escrow cross-check selects it.
function indexerPick(checkpoints, chain, stamp){
    const above = checkpoints.filter(c => c.chain === chain && c.snapshot_block > stamp)
                             .sort((a, b) => a.snapshot_block - b.snapshot_block);
    return above[0] || null;
}

function stampOf(engine){
    return engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block;
}

function proposedRow(engine, over){
    const row = Object.assign({
        snapshot_block: TIP, network: 'regtest', src_chain: 'DOGE', src_action_index: 9,
        src_address: 'nSrcAddress', dest_chain: 'BTC', dest_address: 'mDestAddress',
        tick: 'FUFU', decimals: 8, amount: '5.00000000',
        effective_time: Math.floor(Date.now() / 1000) + 240, push_generation: 0
    }, over);
    row.transfer_id = engine.deriveTransferId(row.network, row.src_chain, row.src_action_index,
                                              row.dest_chain, row.dest_address);
    return row;
}

function page(engine, chain, transfer, latest){
    engine.indexerCall = sinon.stub().callsFake(async (coin) => coin === chain
        ? { latest_block_index: latest, network: 'regtest', transfers: [transfer] }
        : { latest_block_index: 0, network: 'regtest', transfers: [] });
}

function gateOff(){
    sinon.stub(registry, 'activeAt').callsFake((key, ...rest) =>
        key === GATE ? false : registry.activeAt.wrappedMethod.call(registry, key, ...rest));
}

afterEach(function(){ sinon.restore(); });

describe('CrossChainBridgeEngine: anchor proof-ready activation', function(){
    it('the flag-day row is armed on regtest and unarmed on mainnet and testnet for DOGE and LTC', function(){
        for(const coin of ['DOGE', 'LTC']){
            expect(registry.activeAt(GATE, 'regtest', coin, 1, null)).to.equal(true);
            expect(registry.activeAt(GATE, 'mainnet', coin, 999999999, null)).to.equal(false);
            expect(registry.activeAt(GATE, 'testnet', coin, 999999999, null)).to.equal(false);
        }
    });
});

describe('CrossChainBridgeEngine: anchor-axis snapshot_block proposer', function(){
    it('stamps a DOGE lock one below its first covering DOGE checkpoint, which the indexer then picks', async function(){
        const held = [cp('DOGE', DOGE_LEG - 10, TIP - 12), cp('DOGE', DOGE_LEG + 4, TIP - 6),
                      cp('DOGE', DOGE_LEG + 40, TIP), cp('BTC', TIP - 3, TIP - 3)];
        const engine = makeEngine(held, TIP + 1);
        await engine.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP + 1, lock('DOGE'));
        expect(stampOf(engine)).to.equal(TIP - 7);
        const pick = indexerPick(held, 'DOGE', stampOf(engine));
        expect(pick.snapshot_block).to.equal(TIP - 6);
        expect(pick.block_index).to.be.at.least(DOGE_LEG);
    });

    it('stamps an LTC lock one below its first covering LTC checkpoint, which the indexer then picks', async function(){
        const held = [cp('LTC', LTC_LEG - 1, TIP - 6), cp('LTC', LTC_LEG, TIP)];
        const engine = makeEngine(held, TIP + 2);
        await engine.maybeFinalizeTransfer('LTC', 'regtest', LTC_LEG + 12, TIP + 2, lock('LTC'));
        expect(stampOf(engine)).to.equal(TIP - 1);
        const pick = indexerPick(held, 'LTC', stampOf(engine));
        expect(pick.block_index).to.equal(LTC_LEG);
    });

    it('holds the lock while no origin checkpoint covers it, then stamps the first one that does', async function(){
        const engine = makeEngine([cp('DOGE', DOGE_LEG - 1, TIP - 6), cp('BTC', TIP, TIP)], TIP + 1);
        await engine.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP + 1, lock('DOGE'));
        expect(engine.transferConsensus.propose.called).to.equal(false);
        engine.hub.db.state.checkpoints.push(cp('DOGE', DOGE_LEG + 3, TIP + 6));
        await engine.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 66, TIP + 6, lock('DOGE'));
        expect(stampOf(engine)).to.equal(TIP + 5);
    });

    it('takes the latest sequence at the covering height, not a row a reorg superseded', async function(){
        const held = [cp('DOGE', DOGE_LEG + 4, TIP - 12), cp('DOGE', DOGE_LEG + 4, TIP - 6)];
        const engine = makeEngine(held, TIP);
        await engine.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP, lock('DOGE'));
        expect(stampOf(engine)).to.equal(TIP - 7);
        expect(indexerPick(held, 'DOGE', stampOf(engine)).snapshot_block).to.equal(TIP - 6);
    });

    it('resolves the validator set at the stamped block', async function(){
        const engine = makeEngine([cp('DOGE', DOGE_LEG + 4, TIP - 6)], TIP);
        const resolve = sinon.spy(engine, 'resolveCapabilityValidators');
        await engine.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP, lock('DOGE'));
        expect(resolve.firstCall.args.slice(0, 2)).to.deep.equal(['cross_chain', TIP - 7]);
    });

    it('holds the lock when the token gate is not active at the stamped block', async function(){
        const engine = makeEngine([cp('DOGE', DOGE_LEG + 4, TIP - 6)], TIP);
        engine.activation.token = (block) => block >= TIP - 5;
        await engine.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP, lock('DOGE'));
        expect(engine.transferConsensus.propose.called).to.equal(false);
    });
});

describe('CrossChainBridgeEngine: anchor-axis snapshot_block proposer scope', function(){
    it('keeps the tip stamp below the flag day', async function(){
        gateOff();
        const engine = makeEngine([cp('DOGE', DOGE_LEG + 4, TIP - 6)], TIP);
        await engine.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP, lock('DOGE'));
        expect(stampOf(engine)).to.equal(TIP);
    });

    it('leaves legs the destination never proves on the tip stamp: a burn and an XCHAIN leg', async function(){
        const held = [cp('DOGE', DOGE_LEG + 4, TIP - 6)];
        const burn = makeEngine(held, TIP);
        await burn.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP,
            lock('DOGE', { transfer_kind: 'burn', tick: 'BTC.FUFU' }));
        expect(stampOf(burn)).to.equal(TIP);
        const xchain = makeEngine(held, TIP);
        await xchain.maybeFinalizeTransfer('DOGE', 'regtest', DOGE_LEG + 60, TIP,
            lock('DOGE', { transfer_kind: 'burn', tick: 'XCHAIN' }));
        expect(stampOf(xchain)).to.equal(TIP);
    });

    it('leaves the BTC path on the block of its covering BTC checkpoint', async function(){
        const engine = makeEngine([cp('BTC', TIP - 4, TIP - 4), cp('DOGE', TIP, TIP - 6)], TIP);
        await engine.maybeFinalizeTransfer('BTC', 'regtest', TIP, TIP,
            lock('BTC', { tick: 'XCHAIN', dest_chain: 'DOGE', dest_address: 'nDestAddress', block_index: TIP - 5 }));
        expect(stampOf(engine)).to.equal(TIP - 4);
    });
});

describe('CrossChainBridgeEngine: anchor-axis snapshot_block follower', function(){
    it('co-signs a stamp one below its own first covering origin checkpoint', async function(){
        const engine = makeEngine([cp('DOGE', DOGE_LEG + 4, TIP - 6)], TIP);
        page(engine, 'DOGE', lock('DOGE'), DOGE_LEG + 60);
        expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: TIP - 7 }))).to.equal(true);
    });

    it('refuses the tip stamp and the checkpoint\'s own snapshot_block, which the strict pick would skip', async function(){
        const engine = makeEngine([cp('DOGE', DOGE_LEG + 4, TIP - 6)], TIP);
        page(engine, 'DOGE', lock('DOGE'), DOGE_LEG + 60);
        expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: TIP }))).to.equal(false);
        expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: TIP - 6 }))).to.equal(false);
    });

    it('refuses a stamp below a checkpoint that does not cover the lock', async function(){
        const engine = makeEngine([cp('LTC', LTC_LEG - 1, TIP - 12), cp('LTC', LTC_LEG + 2, TIP - 6)], TIP);
        page(engine, 'LTC', lock('LTC'), LTC_LEG + 12);
        expect(await engine.validateProposedMatch(proposedRow(engine, {
            src_chain: 'LTC', snapshot_block: TIP - 13 }))).to.equal(false);
        expect(await engine.validateProposedMatch(proposedRow(engine, {
            src_chain: 'LTC', snapshot_block: TIP - 7 }))).to.equal(true);
    });

    it('refuses any stamp while it holds no covering origin checkpoint', async function(){
        const engine = makeEngine([cp('DOGE', DOGE_LEG - 1, TIP - 6)], TIP);
        page(engine, 'DOGE', lock('DOGE'), DOGE_LEG + 60);
        expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: TIP - 7 }))).to.equal(false);
        expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: TIP }))).to.equal(false);
    });

    it('co-signs the tip stamp below the flag day', async function(){
        gateOff();
        const engine = makeEngine([], TIP);
        page(engine, 'DOGE', lock('DOGE'), DOGE_LEG + 60);
        expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: TIP }))).to.equal(true);
    });
});
