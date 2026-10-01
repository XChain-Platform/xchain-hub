/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');

const policyPoll = require('../../../../src/cross_chain/bridge/policy_poll.js');
const validate = require('../../../../src/cross_chain/bridge/validate.js');
const archiveVerify = require('../../../../src/anchor/publisher/archive/bridge_policy_verify.js');
const { policyHash } = require('../../../../src/cross_chain/bridge/policy_hash.js');

const SNAPSHOT_BLOCK = 150;
const ORIGIN_BLOCK = 900;
const REF = 'DOGE:2701';
const BLOCK_LIST = ['blocked'];

function expectedHash(ref = REF){
    return policyHash(null, BLOCK_LIST, false, { allow: ref, block: null });
}

function byRefPolicy(ref = REF){
    return {
        allow_list: ref,
        allow_list_ref: ref,
        block_list: BLOCK_LIST,
        sleeping: false,
        policy_hash: expectedHash(ref),
        origin_block: ORIGIN_BLOCK
    };
}

function engineFor(network, listShareActive){
    const state = { seq: 0, held: null };
    const db = {
        getLatestPolicySeq: async () => state.seq,
        getPolicySnapshotAtSeq: async () => state.held
    };
    const engine = Object.assign({}, policyPoll, validate, {
        network,
        db,
        confirmations: { BTC: 6 },
        indexers: { BTC: { url: 'configured' } },
        _inflight: new Set(),
        policyConsensus: { propose: sinon.stub().resolves() },
        nowSeconds: () => 1000,
        resolveSnapshotBlock: async () => SNAPSHOT_BLOCK,
        stampAdmission: async () => true,
        resolveCapabilityValidators: async () => [],
        gateActive(name){
            if(name === 'listShare') return listShareActive;
            return true;
        }
    });
    engine.indexerCall = sinon.stub().callsFake(async (coin, method, params) => {
        expect(coin).to.equal('BTC');
        if(method === 'getlatestblock') return { block_index: ORIGIN_BLOCK + 6 };
        if(method === 'gettokenpolicy'){
            expect(params).to.include({
                tick: 'FUFU',
                origin_block: ORIGIN_BLOCK,
                snapshot_block: SNAPSHOT_BLOCK
            });
            return byRefPolicy();
        }
        return null;
    });
    return { engine, state };
}

function pair(){
    return { origin_chain: 'BTC', tick: 'FUFU', copies: new Set(['DOGE']) };
}

function rowFor(engine, network, allowRef = REF){
    const row = {
        snapshot_block: SNAPSHOT_BLOCK,
        network,
        origin_chain: 'BTC',
        tick: 'FUFU',
        policy_seq: 1,
        origin_block: ORIGIN_BLOCK,
        policy_hash: expectedHash(),
        allow_list: JSON.stringify(allowRef),
        block_list: JSON.stringify(BLOCK_LIST),
        sleeping: 0,
        effective_time: 1240
    };
    row.snapshot_id = engine.deriveSnapshotId(network, row.origin_chain, row.tick,
        row.policy_seq, row.snapshot_block);
    return row;
}

describe('bridge policy list sharing by reference', function(){
    afterEach(function(){
        sinon.restore();
    });

    it('signs and stores a reference using the sibling indexer hash', async function(){
        const { engine } = engineFor('regtest', true);
        await engine.maybeSnapshotPolicy(pair(), 'regtest', SNAPSHOT_BLOCK);

        expect(engine.policyConsensus.propose.calledOnce).to.equal(true);
        const row = engine.policyConsensus.propose.firstCall.args[1].row;
        expect(row.allow_list).to.equal(JSON.stringify(REF));
        expect(row.block_list).to.equal(JSON.stringify(BLOCK_LIST));

        const src = path.resolve(__dirname, '../../../../src');
        const indexerDir = process.env.XCHAIN_INDEXER_DIR || path.join(src, '..', '..', 'xchain-indexer');
        const tokenPolicyPath = path.join(indexerDir, 'src', 'api', 'rpc', 'token_policy.js');
        if(!fs.existsSync(tokenPolicyPath)){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                expect.fail('xchain-indexer sibling is absent at ' + tokenPolicyPath);
            expect(row.policy_hash).to.equal(expectedHash());
            return;
        }
        const { bridgePolicyHash } = require(tokenPolicyPath);
        expect(row.policy_hash).to.equal(
            bridgePolicyHash(null, BLOCK_LIST, false, { allow: REF, block: null })
        );
    });

    it('does not propose after shared-list members change behind the same reference', async function(){
        const { engine, state } = engineFor('regtest', true);
        state.seq = 4;
        state.held = { policy_hash: expectedHash() };

        await engine.maybeSnapshotPolicy(pair(), 'regtest', SNAPSHOT_BLOCK);

        expect(engine.policyConsensus.propose.called).to.equal(false);
    });

    it('co-signs the matching reference and refuses a changed transport reference', async function(){
        const { engine } = engineFor('regtest', true);
        expect(await engine.validateProposedMatch(rowFor(engine, 'regtest'))).to.equal(true);
        expect(await engine.validateProposedMatch(
            rowFor(engine, 'regtest', 'DOGE:2702')
        )).to.equal(false);
    });

    it('signs no reference and refuses a reference row while the gate is unarmed', async function(){
        const { engine } = engineFor('testnet', false);
        await engine.maybeSnapshotPolicy(pair(), 'testnet', SNAPSHOT_BLOCK);
        expect(engine.policyConsensus.propose.called).to.equal(false);
        expect(await engine.validateProposedMatch(rowFor(engine, 'testnet'))).to.equal(false);
    });

    it('verifies an armed archived reference and refuses it when unarmed', async function(){
        const row = rowFor(validate, 'regtest');
        const ctx = {
            db: { getPolicySnapshotBySnapshotId: async () => [] },
            policySnapshotCanonical: () => 'canonical',
            verifyArchivedBridgePolicyQuorum: sinon.stub().resolves(true)
        };
        expect(await archiveVerify.verifyArchivedPolicySnapshot.call(ctx, row)).to.equal(true);
        expect(await archiveVerify.verifyArchivedPolicySnapshot.call(
            ctx, Object.assign({}, row, { network: 'testnet' })
        )).to.equal(false);
        expect(ctx.verifyArchivedBridgePolicyQuorum.calledOnce).to.equal(true);
    });
});
