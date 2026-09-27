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
 * Pin the distinction between a detached policy list and an attached,
 * empty list across leader transport and follower verification.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');

const SNAPSHOT_BLOCK = 150;
const ORIGIN_BLOCK = 900;
const BLOCK_LIST = ['nBlockedOne', 'nBlockedTwo'];

function makeEngine(){
    const state = { seq: 0, atSeq: null };
    const db = {
        getLatestPolicySeq: sinon.stub().callsFake(async () => state.seq),
        getPolicySnapshotAtSeq: sinon.stub().callsFake(async () => state.atSeq)
    };
    const hub = {
        db,
        network: 'regtest',
        p2pConfig: { BTC_INDEXER_URL: 'http://btc' },
        capabilitySnapshot: {
            async getSnapshot(){ return { validators: [{ pubkey: 'a'.repeat(64), amount: '1' }] }; },
            async getWeightSnapshot(){
                return { validators: [{ pubkey: 'a'.repeat(64), source: 's1', weight: '1' }] };
            }
        },
        getPeerManager: () => null,
        getIdentity: () => null,
        resolveBtcLatestBlock: async () => SNAPSHOT_BLOCK
    };
    const engine = new CrossChainBridgeEngine(hub);
    const stubConsensus = () => ({
        propose: sinon.stub().resolves(),
        start: sinon.stub(),
        stop: sinon.stub(),
        on: () => {},
        forgetFinalized: sinon.stub()
    });
    engine.transferConsensus = stubConsensus();
    engine.policyConsensus = stubConsensus();
    engine.activation = { bridge: () => true, token: () => true, policy: () => true };
    return { engine, state };
}

function answerPolicy(engine, allowList){
    const policy = {
        allow_list: allowList,
        block_list: BLOCK_LIST,
        sleeping: false
    };
    policy.policy_hash = engine.policyHash(policy.allow_list, policy.block_list, policy.sleeping);
    engine.indexerCall = sinon.stub().callsFake(async (coin, method) => {
        if(method === 'getlatestblock') return { block_index: 906 };
        if(method === 'gettokenpolicy') return policy;
        return null;
    });
    return policy;
}

function proposedPolicy(engine, allowList){
    const hash = engine.policyHash(null, BLOCK_LIST, false);
    const row = {
        snapshot_block: SNAPSHOT_BLOCK,
        network: 'regtest',
        origin_chain: 'BTC',
        tick: 'FUFU',
        policy_seq: 2,
        origin_block: ORIGIN_BLOCK,
        policy_hash: hash,
        allow_list: allowList,
        block_list: JSON.stringify(BLOCK_LIST),
        sleeping: 0,
        effective_time: engine.nowSeconds() + 2400
    };
    row.snapshot_id = engine.deriveSnapshotId(
        row.network, row.origin_chain, row.tick, row.policy_seq, row.snapshot_block
    );
    return row;
}

describe('detached policy list transport', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('signs a detached allow list as SQL NULL after an attached list', async function () {
        const { engine, state } = makeEngine();
        const pair = { origin_chain: 'BTC', tick: 'FUFU', copies: new Set(['DOGE']) };
        answerPolicy(engine, ['A']);

        await engine.maybeSnapshotPolicy(pair, 'regtest', SNAPSHOT_BLOCK);
        const first = engine.policyConsensus.propose.firstCall.args[1].row;
        expect(first.policy_seq).to.equal(1);
        expect(first.allow_list).to.equal('["A"]');

        state.seq = 1;
        state.atSeq = { policy_hash: first.policy_hash };
        answerPolicy(engine, null);
        await engine.maybeSnapshotPolicy(pair, 'regtest', SNAPSHOT_BLOCK);

        const second = engine.policyConsensus.propose.secondCall.args[1].row;
        const detachedHash = engine.policyHash(null, BLOCK_LIST, false);
        expect(second.policy_seq).to.equal(2);
        expect(second.allow_list).to.equal(null);
        expect(second.allow_list).to.not.equal('[]');
        expect(second.allow_list).to.not.equal('null');
        expect(second.policy_hash).to.equal(detachedHash);
        expect(detachedHash).to.not.equal(engine.policyHash([], BLOCK_LIST, false));
    });

    it('keeps null and empty arrays distinct for both lists', function () {
        const { engine } = makeEngine();
        const detachedAllow = engine.shapePolicy({ allow_list: null, block_list: [], sleeping: false });
        const detachedBlock = engine.shapePolicy({ allow_list: [], block_list: null, sleeping: false });

        expect(detachedAllow.allow).to.equal(null);
        expect(detachedAllow.block).to.deep.equal([]);
        expect(detachedBlock.allow).to.deep.equal([]);
        expect(detachedBlock.block).to.equal(null);
    });

    it('co-signs null transport and refuses empty-array transport for the same hash', async function () {
        const { engine } = makeEngine();
        answerPolicy(engine, null);
        const detached = proposedPolicy(engine, null);

        expect(await engine.validateProposedMatch(detached)).to.equal(true);
        expect(await engine.validateProposedMatch({ ...detached, allow_list: '[]' })).to.equal(false);
    });
});
