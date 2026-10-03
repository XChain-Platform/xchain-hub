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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

let warnings;
let part;

function setup(){
    warnings = [];
    part = proxyquire('../../../../src/attestation/batch_publisher/chain_reconcile.js', {
        axios: { post: sinon.stub() },
        '../../config': { DOGE_INDEXER_API_KEY: 'config-key' },
        '../../observability': { getLogger: () => ({ warn: line => warnings.push(line) }) }
    });
}

function context(answer){
    let ctx = {
        hub: {
            resolveIndexerUrl: sinon.stub().resolves('indexer-url'),
            p2pConfig: { DOGE_INDEXER_API_KEY: 'p2p-key' }
        },
        windowS: 3600,
        stats: {
            chainReconcileRuns: 0,
            chainReconcileLandedWindows: 0,
            chainReconcileFailures: 0,
            windowsDeferred: 0
        },
        recordLandedWindow: sinon.stub().resolves()
    };
    Object.assign(ctx, part);
    ctx.indexerRpc = sinon.stub().resolves(answer === undefined
        ? { batches: [], truncated: false } : answer);
    return ctx;
}

function pending(){
    return [
        { windowStart: 7200, age: 0 },
        { windowStart: 0, age: 2 },
        { windowStart: 3600, age: 1 }
    ];
}

function expectRpc(rpc, count){
    expect(rpc.callCount).to.equal(count);
    for(let call of rpc.getCalls()){
        expect(call.args).to.deep.equal([
            'indexer-url', 'config-key', 'getattestbatches',
            { window_start_from: 0, window_start_to: 7200, limit: 500 }
        ]);
    }
}

function registerInterfaceTests(){

    it('exports exactly the four methods installed by the publisher', function(){
        expect(Object.keys(part)).to.deep.equal([
            'reconcilePendingAgainstChain',
            'fetchLandedAttestBatches',
            'chainReconcileFailed',
            'indexerRpc'
        ]);
    });

    it('does not call the indexer for an empty pending list', async function(){
        let ctx = context();
        let list = [];
        expect(await ctx.reconcilePendingAgainstChain(list)).to.equal(list);
        expect(ctx.indexerRpc.called).to.equal(false);
        expect(ctx.hub.resolveIndexerUrl.called).to.equal(false);
    });
}

function registerLandedBatchTests(){
    it('records and drops a landed pending window while keeping an omitted one', async function(){
        let ctx = context({
            batches: [
                { window_start: 0, window_end: 3600, row_count: 4, tx_hash: 'tx0' },
                { window_start: '3600', window_end: '7200', row_count: 2, tx_hash: '' }
            ],
            truncated: false
        });
        let list = pending();

        let remaining = await ctx.reconcilePendingAgainstChain(list);

        expect(remaining).to.deep.equal([{ windowStart: 7200, age: 0 }]);
        expect(ctx.recordLandedWindow.args).to.deep.equal([
            [0, 3600, 'tx0', 4],
            [3600, 7200, null, 2]
        ]);
        expect(ctx.stats.chainReconcileRuns).to.equal(1);
        expect(ctx.stats.chainReconcileLandedWindows).to.equal(2);
        expectRpc(ctx.indexerRpc, 1);
    });

    it('ignores mismatched window ends and malformed batch bounds', async function(){
        let ctx = context({
            batches: [
                { window_start: 0, window_end: 3599, row_count: 1 },
                { window_start: 3600.5, window_end: 7200, row_count: 1 },
                { window_start: 7200, window_end: Infinity, row_count: 1 },
                { window_start: false, window_end: 3600, row_count: 1 }
            ]
        });
        let list = pending();

        expect(await ctx.reconcilePendingAgainstChain(list)).to.deep.equal(list);
        expect(ctx.recordLandedWindow.called).to.equal(false);
        expect(ctx.stats.chainReconcileRuns).to.equal(1);
        expect(ctx.stats.chainReconcileLandedWindows).to.equal(0);
        expectRpc(ctx.indexerRpc, 1);
    });

    // A full page proves only its listed windows landed; an omitted window may sit
    // past the page, so it is deferred to a later sweep rather than published.
    it('records listed windows and defers the omitted ones on a truncated answer', async function(){
        let ctx = context({
            batches: [{ window_start: 3600, window_end: 7200, row_count: 8 }],
            truncated: true
        });

        expect(await ctx.reconcilePendingAgainstChain(pending())).to.deep.equal([]);
        expect(ctx.recordLandedWindow.calledOnceWithExactly(3600, 7200, null, 8)).to.equal(true);
        expect(ctx.stats.chainReconcileLandedWindows).to.equal(1);
        expect(ctx.stats.windowsDeferred).to.equal(2);
        expectRpc(ctx.indexerRpc, 1);
    });
}

function registerFailureTests(){
    it('warns once per distinct reason when failures alternate', function(){
        let ctx = context();

        expect(ctx.chainReconcileFailed('first failure')).to.equal(null);
        expect(ctx.chainReconcileFailed('second failure')).to.equal(null);
        expect(ctx.chainReconcileFailed('first failure')).to.equal(null);

        expect(ctx.stats.chainReconcileFailures).to.equal(3);
        expect(warnings).to.have.length(2);
        expect(warnings[0]).to.include('first failure');
        expect(warnings[1]).to.include('second failure');
    });

    it('fails open without an indexer URL and warns once for repeats', async function(){
        let ctx = context();
        ctx.hub.resolveIndexerUrl.resolves(null);
        let list = pending();

        expect(await ctx.reconcilePendingAgainstChain(list)).to.equal(list);
        expect(await ctx.reconcilePendingAgainstChain(list)).to.equal(list);
        expect(ctx.indexerRpc.called).to.equal(false);
        expect(ctx.stats.chainReconcileFailures).to.equal(2);
        expect(ctx.stats.chainReconcileRuns).to.equal(0);
        expect(warnings).to.have.length(1);
    });

    it('fails open on a thrown RPC and warns once for repeats', async function(){
        let ctx = context();
        ctx.indexerRpc.rejects(new Error('unreachable'));
        let list = pending();

        expect(await ctx.reconcilePendingAgainstChain(list)).to.equal(list);
        expect(await ctx.reconcilePendingAgainstChain(list)).to.equal(list);
        expectRpc(ctx.indexerRpc, 2);
        expect(ctx.stats.chainReconcileFailures).to.equal(2);
        expect(warnings).to.have.length(1);
        expect(warnings[0]).to.include('unreachable');
    });

    for(let failure of [
        { name: 'an error answer', answer: { error: { code: -32601, message: 'unknown method' } } },
        { name: 'an answer without a batch list', answer: { block_index: 12 } }
    ]){
        it('fails open on ' + failure.name + ' and warns once for repeats', async function(){
            let ctx = context(failure.answer);
            let list = pending();

            expect(await ctx.reconcilePendingAgainstChain(list)).to.equal(list);
            expect(await ctx.reconcilePendingAgainstChain(list)).to.equal(list);
            expectRpc(ctx.indexerRpc, 2);
            expect(ctx.stats.chainReconcileFailures).to.equal(2);
            expect(ctx.stats.chainReconcileRuns).to.equal(0);
            expect(warnings).to.have.length(1);
        });
    }
}

describe('AttestationBatchPublisher chain reconcile part', function(){
    beforeEach(setup);
    registerInterfaceTests();
    registerLandedBatchTests();
    registerFailureTests();
});
