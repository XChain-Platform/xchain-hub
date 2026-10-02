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
 ********************************************************************/

'use strict';

const os = require('os');
const path = require('path');
const { expect } = require('chai');
const sinon = require('sinon');

const AttestationBatchPublisher = require('../../../../../src/attestation/batch_publisher.js');
const { getLogger } = require('../../../../../src/observability');

const WINDOW_S = 10;
let warn;

function makePublisher(pending){
    let markers = new Map();
    let db = {
        async doQuery(){ return []; },
        async setAttestPublishedBatchByNetworkAndWindowStartAndWindowEnd(
            network, windowStart, windowEnd, rowCount, txid, status){
            markers.set(Number(windowStart), {
                network,
                window_start: windowStart,
                window_end: windowEnd,
                row_count: rowCount,
                txid,
                status
            });
        }
    };
    let hub = {
        network: 'regtest',
        db,
        p2pConfig: {
            ATTEST_BATCH_WINDOW_S_OVERRIDE: String(WINDOW_S),
            ATTEST_BATCH_BUFFER_PATH: path.join(os.tmpdir(), 'attest-chain-reconcile.jsonl')
        },
        getIdentity: () => null,
        resolveIndexerUrl: sinon.stub().resolves('doge-indexer')
    };
    let publisher = new AttestationBatchPublisher(hub);
    publisher.enabled = true;
    publisher.pendingWindows = sinon.stub().callsFake(async () =>
        pending.map(window => Object.assign({}, window)));
    publisher.publishWindow = sinon.stub().resolves(true);
    publisher.indexerRpc = sinon.stub();
    return { publisher, markers };
}

function answer(batches, truncated){
    return { batches, truncated: !!truncated };
}

function registerLandedTests(){
    it('records a chain-landed window and does not publish it', async function(){
        let { publisher, markers } = makePublisher([{ windowStart: 100, age: 0 }]);
        publisher.indexerRpc.resolves(answer([
            { window_start: 100, window_end: 110, tx_hash: 'doge-tx', row_count: 3 }
        ]));

        expect(await publisher.sweep(120)).to.deep.equal({ attempted: 0, published: 0 });
        expect(publisher.publishWindow.called).to.equal(false);
        expect(markers.get(100)).to.deep.include({
            window_end: 110,
            row_count: 3,
            txid: 'doge-tx',
            status: 'landed'
        });
        expect(publisher.getStats()).to.include({
            chainReconcileRuns: 1,
            chainReconcileLandedWindows: 1,
            chainReconcileFailures: 0
        });
    });

    it('publishes an omitted window with its pending rank age', async function(){
        let { publisher } = makePublisher([{ windowStart: 90, age: 2 }]);
        publisher.indexerRpc.resolves(answer([]));

        expect(await publisher.sweep(120)).to.deep.equal({ attempted: 1, published: 1 });
        expect(publisher.publishWindow.calledOnceWithExactly(90, 2)).to.equal(true);
    });

    it('ignores a landed batch whose window end does not match', async function(){
        let { publisher, markers } = makePublisher([{ windowStart: 100, age: 0 }]);
        publisher.indexerRpc.resolves(answer([
            { window_start: 100, window_end: 111, tx_hash: 'wrong-window', row_count: 1 }
        ]));

        expect(await publisher.sweep(120)).to.deep.equal({ attempted: 1, published: 1 });
        expect(publisher.publishWindow.calledOnceWithExactly(100, 0)).to.equal(true);
        expect(markers.size).to.equal(0);
    });
}

function registerFailureTests(){
    it('fails open and warns once for repeated unreachable and unknown-method failures', async function(){
        let { publisher } = makePublisher([{ windowStart: 100, age: 0 }]);
        publisher.indexerRpc.rejects(new Error('unreachable'));

        await publisher.sweep(120);
        await publisher.sweep(120);
        expect(publisher.publishWindow.callCount).to.equal(2);
        expect(warn.callCount).to.equal(1);

        publisher.indexerRpc.resetBehavior();
        publisher.indexerRpc.resolves({ error: { code: -32601, message: 'unknown method' } });
        await publisher.sweep(120);
        await publisher.sweep(120);

        expect(publisher.publishWindow.callCount).to.equal(4);
        expect(warn.callCount).to.equal(2);
        expect(publisher.getStats().chainReconcileFailures).to.equal(4);
    });

    it('sheds listed windows from a truncated answer and publishes the remainder', async function(){
        let pending = [
            { windowStart: 80, age: 2, reopenedSkipped: true },
            { windowStart: 90, age: 1 },
            { windowStart: 100, age: 0 }
        ];
        let { publisher, markers } = makePublisher(pending);
        publisher.indexerRpc.resolves(answer([
            { window_start: 90, window_end: 100, tx_hash: null, row_count: 7 }
        ], true));

        expect(await publisher.sweep(120)).to.deep.equal({ attempted: 2, published: 2 });
        expect(publisher.publishWindow.args).to.deep.equal([[80, 2], [100, 0]]);
        expect(markers.get(90)).to.deep.include({ status: 'landed', row_count: 7, txid: null });
    });
}

function registerRangeTests(){
    it('asks the indexer once for the full pending range in each sweep', async function(){
        let pending = [
            { windowStart: 100, age: 0 },
            { windowStart: 70, age: 3 },
            { windowStart: 90, age: 1 },
            { windowStart: 80, age: 2 }
        ];
        let { publisher } = makePublisher(pending);
        publisher.indexerRpc.resolves(answer([]));

        await publisher.sweep(120);

        expect(publisher.indexerRpc.calledOnce).to.equal(true);
        expect(publisher.indexerRpc.firstCall.args.slice(2)).to.deep.equal([
            'getattestbatches',
            { window_start_from: 70, window_start_to: 100, limit: 500 }
        ]);
        expect(publisher.publishWindow.callCount).to.equal(4);
    });
}

describe('AttestationBatchPublisher chain reconciliation sweep', function(){
    beforeEach(function(){
        warn = sinon.stub(getLogger(), 'warn');
    });

    afterEach(function(){
        warn.restore();
    });

    registerLandedTests();
    registerFailureTests();
    registerRangeTests();
});
