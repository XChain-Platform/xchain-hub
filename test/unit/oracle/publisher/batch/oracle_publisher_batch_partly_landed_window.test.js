'use strict';

const {
    sinon,
    expect,
    makeDb,
    makePublisher,
    bufferedFixture,
    cleanupPublisherBatch
} = require('./oracle_publisher_batch.test.js');

let logs;

// A window whose tail was shed after its batch landed (a window-size change leaves
// the old windows' rounds inside a new window) must not read those rounds as missing.

const snapshots = [
    { round_number: 0, block_timestamp: 1800000000, status: 'finalized' },
    { round_number: 3, block_timestamp: 1800001800, status: 'finalized' }
];

describe('oracle publisher batch: partly landed window', function () {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
        sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
        sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
    });
    afterEach(function () { cleanupPublisherBatch(); });

    it('publishes the rest of a window whose other round was shed after landing', async function () {
        let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
        await h.p.start();
        h.p._buffer.set(0, bufferedFixture(0));
        h.p._buffer.set(3, bufferedFixture(3));
        h.p.noteBatchLanded(3, 3, null);

        await h.p.assembleWindow(0);
        expect(h.signer.calls).to.have.length(1);
        expect(h.signer.calls[0]).to.include({ first: 0, last: 0 });
        expect(logs.warn.join('\n')).to.not.match(/no buffered copy/);
    });

    it('asks the chain when the in-memory record is gone (restart)', async function () {
        let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
        await h.p.start();
        h.hub.resolveIndexerUrl = sinon.stub().resolves('http://doge-indexer:3114');
        sinon.stub(h.p, 'indexerRpc').resolves({ batches: [{ first_round: 3, last_round: 3 }] });
        h.p._buffer.set(0, bufferedFixture(0));

        await h.p.assembleWindow(0);
        expect(h.signer.calls).to.have.length(1);
    });

    it('still withholds a round neither shed nor carried by the chain', async function () {
        let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
        await h.p.start();
        h.hub.resolveIndexerUrl = sinon.stub().resolves('http://doge-indexer:3114');
        sinon.stub(h.p, 'indexerRpc').resolves({ batches: [] });
        h.p._buffer.set(0, bufferedFixture(0));

        await h.p.assembleWindow(0);
        expect(h.signer.calls).to.have.length(0);
        expect(logs.warn.join('\n')).to.match(/finalized round\(s\) 3 with no buffered copy/);
    });
});
