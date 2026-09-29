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
 * CrossChainBridgeEngine after a restart: a bridged token's policy edit must still be
 * signed when no new transfer of it arrives.
 *
 * The policy poll pairs a tick only once it knows the tick's origin chain, and that
 * origin was learned only from a live pending leg. A restarted hub (every fleet roll,
 * and the bridge rail's policy AT5 abstain case, which restarts every venue hub) started
 * with the map empty, so every already-bridged tick was skipped until its next transfer
 * and a LIST, BLOCK or SLEEP edit was never proposed at all.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const Database               = require('../../../../src/db');

// A Database carrying the REAL query methods over a driver that answers only the reads
// a restarted engine's first policy poll makes. `origins` is what the finalized
// policy_snapshots rows say; `pairs` is what bridge_transfers says.
function restartDb(state){
    const db = Object.create(Database.prototype);
    db.calls = [];
    db.doQuery = async function(sql, params){
        db.calls.push({ sql, params: params || [] });
        if(sql.startsWith('SELECT DISTINCT origin_chain, tick FROM policy_snapshots')) return state.origins;
        if(sql.startsWith('SELECT DISTINCT tick, src_chain, dest_chain')) return state.pairs;
        if(sql.startsWith('SELECT MAX(policy_seq)')) return [{ seq: state.seq }];
        if(sql.startsWith('SELECT snapshot_id, policy_hash')) return [{ policy_hash: state.heldHash }];
        return [];
    };
    db.getChainTip = async () => ({ chainId: 'f'.repeat(64) });
    return db;
}

function freshEngine(state){
    const db  = restartDb(state);
    const hub = {
        db,
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
        resolveBtcLatestBlock: async () => 150
    };
    const engine = new CrossChainBridgeEngine(hub);
    const stubConsensus = () => ({ propose: sinon.stub().resolves(), start: sinon.stub().resolves(),
                                   stop: sinon.stub().resolves(), on: () => {}, forgetFinalized: sinon.stub() });
    engine.transferConsensus = stubConsensus();
    engine.policyConsensus   = stubConsensus();
    engine.activation = { bridge: () => true, token: () => true, policy: () => true };
    // The token's policy CHANGED since seq 1 (a block list was attached), and no leg of it is
    // pending: the only way this engine can learn LAGA's origin is from what it finalized.
    const policy = { allow_list: null, block_list: ['nBlockedOne'], sleeping: false, bridged: true, origin_block: 900 };
    policy.policy_hash = engine.policyHash(policy.allow_list, policy.block_list, policy.sleeping);
    engine.indexerCall = sinon.stub().callsFake(async (coin, method) => {
        if(method === 'getlatestblock') return { block_index: 906 };
        if(method === 'gettokenpolicy') return policy;
        if(method === 'getpendingbridgetransfers') return [];
        return null;
    });
    return { engine, db };
}

function state(over){
    return Object.assign({
        origins:  [{ origin_chain: 'BTC', tick: 'LAGA' }],
        pairs:    [{ tick: 'LAGA', src_chain: 'BTC', dest_chain: 'DOGE' }],
        seq:      1,
        heldHash: 'b'.repeat(64)
    }, over || {});
}

describe('CrossChainBridgeEngine policy origin after a restart', function () {
    afterEach(function () { sinon.restore(); });

    it('a fresh engine proposes seq 2 for a finalized tick with no new transfer', async function () {
        const { engine } = freshEngine(state());
        await engine.start();
        try {
            await engine.pollPolicySnapshots(150);
        } finally { await engine.stop(); }
        expect(engine.policyConsensus.propose.callCount, 'one policy round proposed').to.equal(1);
        const row = engine.policyConsensus.propose.firstCall.args[1].row;
        expect(row.origin_chain).to.equal('BTC');
        expect(row.tick).to.equal('LAGA');
        expect(row.policy_seq).to.equal(2);
    });

    it('reads the origins scoped to this hub network and to finalized rows only', async function () {
        const { engine, db } = freshEngine(state());
        await engine.start();
        await engine.stop();
        const read = db.calls.find(c => c.sql.startsWith('SELECT DISTINCT origin_chain, tick FROM policy_snapshots'));
        expect(read, 'the start-up seed read').to.exist;
        expect(read.sql).to.contain("status = 'finalized'");
        expect(read.params).to.deep.equal(['regtest']);
    });

    it('keeps an origin already learned from a live leg over the seeded one', async function () {
        const { engine } = freshEngine(state({ origins: [{ origin_chain: 'DOGE', tick: 'LAGA' }] }));
        engine._tickOrigin.set('regtest|LAGA', 'BTC');
        await engine.start();
        await engine.stop();
        expect(engine._tickOrigin.get('regtest|LAGA')).to.equal('BTC');
    });

    it('seeds nothing for a tick finalized under two origins rather than guess one', async function () {
        const { engine } = freshEngine(state({ origins: [{ origin_chain: 'BTC', tick: 'LAGA' },
                                                         { origin_chain: 'DOGE', tick: 'LAGA' }] }));
        await engine.start();
        await engine.stop();
        expect(engine._tickOrigin.has('regtest|LAGA')).to.equal(false);
    });

    it('still starts when the seed read fails, and learns origins from legs as before', async function () {
        const { engine, db } = freshEngine(state());
        const inner = db.doQuery;
        db.doQuery = async function(sql, params){
            if(sql.startsWith('SELECT DISTINCT origin_chain, tick FROM policy_snapshots')) throw new Error('ECONNRESET');
            return inner.call(db, sql, params);
        };
        await engine.start();
        await engine.stop();
        expect(engine.transferConsensus.start.called).to.equal(true);
        expect(engine._tickOrigin.size).to.equal(0);
    });
});
