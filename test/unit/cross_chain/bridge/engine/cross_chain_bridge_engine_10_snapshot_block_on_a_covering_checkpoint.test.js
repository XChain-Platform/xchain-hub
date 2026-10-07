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
 * CrossChainBridgeEngine: past the proof-ready flag day a BTC-sourced transfer is
 * stamped with the block of the first finalized BTC checkpoint at or above its own
 * source leg, so the destination indexer finds that checkpoint on its first look.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const CrossChainBridgeEngine = require('../../../../../src/cross_chain/bridge_engine.js');
const Database               = require('../../../../../src/db');
const registry               = require('../../../../../src/consensus/gate_registry.js');
const { BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION: GATE } = require('../../../../../src/cross_chain/bridge/proof_ready_snapshot.js');

const LEG = 5000;

function memDb(checkpoints){
    const db = Object.create(Database.prototype);
    db.state = { checkpoints };
    db.doQuery = async function(sql, params){
        if(sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index >=')){
            const held = db.state.checkpoints.filter(h => h >= params[2]).sort((a, b) => a - b);
            return held.length ? [{ block_index: held[0] }] : [];
        }
        if(sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?'))
            return db.state.checkpoints.includes(params[2]) ? [{ block_index: params[2] }] : [];
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

function btcLock(over){
    return Object.assign({
        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: 77,
        src_address: 'mSrcAddress', dest_chain: 'DOGE', dest_address: 'nDestAddress',
        tick: 'XCHAIN', decimals: 8, amount: '5.00000000', min_depth: 0,
        block_index: LEG, confirmations: 1, tx_hash: 'd'.repeat(64), push_generation: 0
    }, over);
}

function dogeBurn(){
    return btcLock({ transfer_kind: 'burn', src_chain: 'DOGE', src_action_index: 9, dest_chain: 'BTC',
                     dest_address: 'mDestAddress', block_index: 90000 });
}

function proposedRow(engine, over){
    const row = Object.assign({
        snapshot_block: LEG + 3, network: 'regtest', src_chain: 'BTC', src_action_index: 77,
        src_address: 'mSrcAddress', dest_chain: 'DOGE', dest_address: 'nDestAddress',
        tick: 'XCHAIN', decimals: 8, amount: '5.00000000',
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

describe('CrossChainBridgeEngine', function(){
    afterEach(function(){ sinon.restore(); });

    describe('snapshot_block on a covering checkpoint', function(){
        it('the flag-day row is armed on regtest and unarmed on mainnet', function(){
            expect(registry.activeAt(GATE, 'regtest', 'BTC', 1, null)).to.equal(true);
            expect(registry.activeAt(GATE, 'mainnet', 'BTC', 999999999, null)).to.equal(false);
        });

        describe('the proposer', function(){
            it('stamps the first checkpoint at or above the leg, not the tip and not an older checkpoint', async function(){
                const engine = makeEngine([LEG - 6, LEG + 3, LEG + 9], LEG + 8);
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 8, LEG + 8, btcLock());
                expect(engine.transferConsensus.propose.calledOnce).to.equal(true);
                expect(engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(LEG + 3);
            });

            it('stamps a checkpoint at exactly the leg block', async function(){
                const engine = makeEngine([LEG - 6, LEG], LEG + 8);
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 8, LEG + 8, btcLock());
                expect(engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(LEG);
            });

            it('holds the leg and proposes nothing while no checkpoint sits at or above it', async function(){
                const engine = makeEngine([LEG - 6], LEG + 2);
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 2, LEG + 2, btcLock());
                expect(engine.transferConsensus.propose.called).to.equal(false);
                engine.hub.db.state.checkpoints.push(LEG + 3);
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 3, LEG + 3, btcLock());
                expect(engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(LEG + 3);
            });

            it('resolves the validator set at the stamped block', async function(){
                const engine = makeEngine([LEG + 3], LEG + 8);
                const resolve = sinon.spy(engine, 'resolveCapabilityValidators');
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 8, LEG + 8, btcLock());
                expect(resolve.firstCall.args.slice(0, 2)).to.deep.equal(['cross_chain', LEG + 3]);
            });

            it('persists the capability snapshot at the stamped block on finalize', async function(){
                const engine = makeEngine([LEG + 3], LEG + 8);
                engine.persistCapabilitySnapshot = sinon.stub().resolves(1);
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 8, LEG + 8, btcLock());
                const row = engine.transferConsensus.propose.firstCall.args[1].row;
                expect(await engine.persistSnapshotOrDefer(row, row.transfer_id, engine.transferConsensus)).to.equal(true);
                expect(engine.persistCapabilitySnapshot.firstCall.args.slice(0, 2)).to.deep.equal(['cross_chain', LEG + 3]);
            });

            it('holds a general-token leg when the token gate is not active at the stamped block', async function(){
                const engine = makeEngine([LEG + 3], LEG + 8);
                engine.activation.token = (block) => block >= LEG + 5;
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 8, LEG + 8, btcLock({ tick: 'FUFU' }));
                expect(engine.transferConsensus.propose.called).to.equal(false);
            });

            it('keeps the tip stamp while the flag day is not reached', async function(){
                sinon.stub(registry, 'activeAt').callsFake((key, ...rest) =>
                    key === GATE ? false : registry.activeAt.wrappedMethod.call(registry, key, ...rest));
                const engine = makeEngine([LEG + 3], LEG + 8);
                await engine.maybeFinalizeTransfer('BTC', 'regtest', LEG + 8, LEG + 8, btcLock());
                expect(engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(LEG + 8);
            });

            it('leaves a DOGE-sourced leg on the tip stamp', async function(){
                const engine = makeEngine([], LEG + 8);
                await engine.maybeFinalizeTransfer('DOGE', 'regtest', 90000, LEG + 8, dogeBurn());
                expect(engine.transferConsensus.propose.firstCall.args[1].row.snapshot_block).to.equal(LEG + 8);
            });
        });

        describe('the follower', function(){
            it('refuses a stamp that no finalized BTC checkpoint of its own backs', async function(){
                const engine = makeEngine([LEG - 6], LEG + 8);
                page(engine, 'BTC', btcLock(), LEG + 8);
                expect(await engine.validateProposedMatch(proposedRow(engine))).to.equal(false);
            });

            it('co-signs a stamp that sits on its own checkpoint at or above the leg', async function(){
                const engine = makeEngine([LEG - 6, LEG + 3], LEG + 8);
                page(engine, 'BTC', btcLock(), LEG + 8);
                expect(await engine.validateProposedMatch(proposedRow(engine))).to.equal(true);
            });

            it('still refuses a checkpointed stamp below the leg', async function(){
                const engine = makeEngine([LEG - 6], LEG + 8);
                page(engine, 'BTC', btcLock(), LEG + 8);
                expect(await engine.validateProposedMatch(proposedRow(engine, { snapshot_block: LEG - 6 }))).to.equal(false);
            });

            it('co-signs a DOGE-sourced row with no BTC checkpoint at its stamp', async function(){
                const engine = makeEngine([], LEG + 8);
                page(engine, 'DOGE', dogeBurn(), 90000);
                expect(await engine.validateProposedMatch(proposedRow(engine, {
                    src_chain: 'DOGE', src_action_index: 9, dest_chain: 'BTC', dest_address: 'mDestAddress', snapshot_block: LEG + 8
                }))).to.equal(true);
            });
        });
    });
});
