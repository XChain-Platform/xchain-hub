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

function makePublisher(pending){
    let writes = [];
    let db = {
        async doQuery(){ return []; },
        async setAttestPublishedBatchByNetworkAndWindowStartAndWindowEnd(
            network, windowStart, windowEnd, rowCount, txid, status){
            writes.push({ windowStart, windowEnd, rowCount, txid, status });
        }
    };
    let hub = {
        network: 'regtest',
        db,
        p2pConfig: {
            ATTEST_BATCH_WINDOW_S_OVERRIDE: String(WINDOW_S),
            ATTEST_BATCH_BUFFER_PATH: path.join(os.tmpdir(), 'attest-federated-landed.jsonl')
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
    return { publisher, writes };
}

describe('AttestationBatchPublisher federated landed marker', function(){
    let warn;
    beforeEach(function(){ warn = sinon.stub(getLogger(), 'warn'); });
    afterEach(function(){ warn.restore(); });

    it('a hub that never received the push learns the landing from the chain and does not republish', async function(){
        let { publisher, writes } = makePublisher([
            { windowStart: 100, age: 2 }, { windowStart: 110, age: 1 }
        ]);
        publisher.indexerRpc.resolves({ batches: [
            { window_start: 100, window_end: 110, tx_hash: 'tx-a', row_count: 4 }
        ] });

        expect(await publisher.sweep(130)).to.deep.equal({ attempted: 1, published: 1 });
        expect(publisher.publishWindow.calledOnce).to.equal(true);
        expect(publisher.publishWindow.firstCall.args[0]).to.equal(110);
        expect(writes).to.deep.equal([
            { windowStart: 100, windowEnd: 110, rowCount: 4, txid: 'tx-a', status: 'landed' }
        ]);
    });

    it('stores zero rows and a null txid when the chain answer omits them', async function(){
        let { publisher, writes } = makePublisher([{ windowStart: 100, age: 1 }]);
        publisher.indexerRpc.resolves({ batches: [
            { window_start: 100, window_end: 110, row_count: 'x', tx_hash: 7 }
        ] });

        await publisher.sweep(120);
        expect(writes).to.deep.equal([
            { windowStart: 100, windowEnd: 110, rowCount: 0, txid: null, status: 'landed' }
        ]);
    });

    it('recordLandedWindow never passes an undefined or negative count to the database', async function(){
        let { publisher, writes } = makePublisher([]);
        await publisher.recordLandedWindow(100, 110, undefined, undefined);
        await publisher.recordLandedWindow(110, 120, 'tx', -3);
        expect(writes.map(w => [w.rowCount, w.txid])).to.deep.equal([[0, null], [0, 'tx']]);
    });

    it('logs a renewed outage after the indexer recovered in between', async function(){
        let { publisher } = makePublisher([{ windowStart: 100, age: 1 }]);
        publisher.indexerRpc.onCall(0).rejects(new Error('down'));
        publisher.indexerRpc.onCall(1).resolves({ batches: [] });
        publisher.indexerRpc.onCall(2).rejects(new Error('down'));

        await publisher.sweep(120);
        await publisher.sweep(120);
        await publisher.sweep(120);
        expect(warn.callCount).to.equal(2);
    });
});
