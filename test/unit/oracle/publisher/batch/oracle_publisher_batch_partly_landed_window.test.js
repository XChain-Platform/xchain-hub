'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

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

function captureLogs() {
    logs = { log: [], warn: [], error: [] };
    sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
    sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
    sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
}

describe('oracle publisher batch: partly landed window', function () {
    beforeEach(captureLogs);
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
        sinon.stub(h.p, 'indexerRpc').resolves({ batches: [{ first_round: 3, last_round: 3,
            round_count: 1 }] });
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

// A landed batch may omit a round inside its span. The landing path must not mark
// that window assembled, or the omitted round is suppressed when this hub has it.
describe('oracle publisher batch: landed batch with a hole', function () {
    beforeEach(captureLogs);
    afterEach(function () { cleanupPublisherBatch(); });

    it('publishes a late round that a landed batch with a hole left out', async function () {
        let h = makePublisher({ db: makeDb({ snapshots: windowSnapshots([0, 1, 2, 3, 4, 5]) }) });
        await h.p.start();
        for (let r of [0, 1, 3, 4, 5]) h.p._buffer.set(r, bufferedFixture(r));
        h.p.noteBatchLanded(0, 5, { rounds: [0, 1, 3, 4, 5] });
        expect(h.p._assembledWindows.has(0)).to.equal(false);

        h.p._buffer.set(2, bufferedFixture(2));
        await h.p.assembleWindow(0);
        expect(h.signer.calls).to.have.length(1);
        expect(h.signer.calls[0]).to.include({ first: 2, last: 2 });
    });

    it('publishes a late round when the landed batch round list could not be read', async function () {
        let h = makePublisher({ db: makeDb({ snapshots: windowSnapshots([2]) }) });
        await h.p.start();
        h.p.noteBatchLanded(0, 5, { rounds: [] });
        expect(h.p._assembledWindows.has(0)).to.equal(false);

        h.p._buffer.set(2, bufferedFixture(2));
        await h.p.assembleWindow(0);
        expect(h.signer.calls).to.have.length(1);
        expect(h.signer.calls[0]).to.include({ first: 2, last: 2 });
    });

    it('still memoizes a window an exact round list carries whole', async function () {
        let h = makePublisher({ db: makeDb({ snapshots: windowSnapshots([2]) }) });
        await h.p.start();
        h.p.noteBatchLanded(0, 5, { rounds: [0, 1, 2, 3, 4, 5] });
        expect(h.p._assembledWindows.has(0)).to.equal(true);
    });
});

function windowSnapshots(rounds) {
    return rounds.map(r => ({ round_number: r, block_timestamp: 1800000000 + r * 600, status: 'finalized' }));
}
