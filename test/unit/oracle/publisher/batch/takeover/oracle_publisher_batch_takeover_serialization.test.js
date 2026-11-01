/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************/

'use strict';

const {
    sinon,
    expect,
    waitUntil,
    ME,
    PEER1,
    PEER2,
    sigsOf,
    makeSigner,
    makeDb,
    makePublisher,
    bufferedFixture,
    cleanupPublisherBatch
} = require('../oracle_publisher_batch.test.js');

async function followerWithSigner(signer) {
    const snapshots = [{ round_number: 99, batch: true, status: 'finalized' }];
    for (let r = 0; r < 12; r++) snapshots.push({ round_number: r, status: 'finalized' });
    const h = makePublisher({
        signer,
        publishers: [ME, PEER1, PEER2],
        db: makeDb({ snapshots }),
        cfg: { ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '2' }
    });
    await h.p.start();
    for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
    return h;
}

function signed(first, last, anchor) {
    return {
        met: true,
        sigs: sigsOf(3),
        firstRound: first,
        lastRound: last,
        btcBlockHeight: anchor,
        canonical: 'canonical-' + first + '-' + last
    };
}

describe('oracle publisher takeover serialization', function () {

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });
    afterEach(function () { cleanupPublisherBatch(); });

    it('waits behind an in-flight queued assembly before opening its signing round', async function () {
        const signer = makeSigner();
        const opened = [];
        let releaseFirst;
        signer.collectBatchSignatures = sinon.stub().callsFake((first, last, anchor) => {
            opened.push([first, last]);
            if (first === 0) return new Promise(resolve => {
                releaseFirst = () => resolve(signed(first, last, anchor));
            });
            return Promise.resolve(signed(first, last, anchor));
        });
        const h = await followerWithSigner(signer);
        h.p.queueWindowAssembly(0);
        const takeover = h.p.attemptTakeover(1);
        await waitUntil(() => opened.length > 0, { label: 'the queued window signing round to open' });
        expect(opened).to.deep.equal([[0, 5]]);
        releaseFirst();
        expect(await takeover).to.equal(true);
        expect(opened).to.deep.equal([[0, 5], [6, 11]]);
        await h.p._windowChain;
    });

    it('recovers the assembly chain after a takeover attempt rejects', async function () {
        const signer = makeSigner();
        const h = await followerWithSigner(signer);
        sinon.stub(h.p, 'runTakeoverAttempt').rejects(new Error('takeover failed'));
        let error;
        try { await h.p.attemptTakeover(1); } catch (caught) { error = caught; }
        expect(error && error.message).to.equal('takeover failed');
        h.p.runTakeoverAttempt.restore();
        await h.p.queueWindowAssembly(0);
        expect(signer.collectBatchSignatures.calledOnce).to.equal(true);
    });
});
