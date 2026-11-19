'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    sinon,
    expect,
    makeDb,
    makePublisher,
    roundFixture,
    readJsonl,
    cleanupPublisherBatch
} = require('../oracle_publisher_batch.test.js');

function proof(first, last) {
    return JSON.stringify({ batch: { first_round: first, last_round: last }, sigs: [] });
}

async function makeBufferedPublisher(rpc) {
    const db = makeDb({ snapshots: [{
        round_number: 3,
        block_timestamp: 1800001800,
        status: 'finalized',
        batch: true,
        proof: proof(0, 5)
    }] });
    const h = makePublisher({ db });
    await h.p.start();
    for (let r = 0; r < 8; r++) await h.p.onRoundFinalized(roundFixture(r));
    h.hub.resolveIndexerUrl = sinon.stub().resolves('indexer-url');
    sinon.stub(h.p, 'indexerRpc').callsFake(rpc);
    return h;
}

describe('oracle publisher batch: exact observed-batch prune', function () {
    afterEach(function () { cleanupPublisherBatch(); });

    it('retains a buffered round omitted by a sparse landed batch', async function () {
        const h = await makeBufferedPublisher(async (url, key, method) => {
            if (method === 'getpricebatches') return { batches: [{
                first_round: 0, last_round: 5, round_count: 5, action_index: 70
            }] };
            return { rounds: [0, 1, 3, 4, 5].map(round => ({ round })), sigs: [] };
        });
        expect(await h.p.pruneObservedWindow(0, 5)).to.equal(5);
        expect(Array.from(h.p._buffer.keys())).to.deep.equal([2, 6, 7]);
        expect(readJsonl(h.bufferPath).map(row => row.round)).to.deep.equal([2, 6, 7]);
    });

    it('keeps unstamped candidates when exact membership cannot be read', async function () {
        const h = await makeBufferedPublisher(async (url, key, method) => {
            if (method === 'getpricebatches') throw new Error('unavailable');
            return null;
        });
        expect(await h.p.pruneObservedWindow(0, 5)).to.equal(1);
        const remaining = [0, 1, 2, 4, 5, 6, 7];
        expect(Array.from(h.p._buffer.keys())).to.deep.equal(remaining);
        expect(readJsonl(h.bufferPath).map(row => row.round)).to.deep.equal(remaining);
    });
});
