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
 **********************************************************************/

'use strict';

const {
    sinon,
    expect,
    makeDb,
    makePublisher,
    roundFixture,
    readJsonl,
    cleanupPublisherBatch
} = require('../oracle_publisher_batch.test.js');

let logs;

// The admission map is part of the signed batch bytes and every co-signer re-derives
// it from its own price_snapshots, so a buffered copy that kept an old map while the
// header and prices stayed equal is a window no peer will ever co-sign.

const M1 = { BTC: 900010, DOGE: 5000010 };
const M2 = { BTC: 900011, DOGE: 5000010 };

function finalized(round, admitBlocks) {
    let event = roundFixture(round);
    if (admitBlocks) event.admitBlocks = admitBlocks;
    return event;
}

// One price_snapshots row per pair, carrying the admission columns the finalizing
// hub stored the map in.
function rowsFor(round, admitBlocks) {
    return [{ pair: 'BTC/USD', price: '60000.12' }, { pair: 'LTC/USD', price: '80.5' }].map(p => ({
        round_number: round, coin_pair: p.pair, price: p.price,
        reference_block: 800000 + round, block_timestamp: 1800000000 + round * 600,
        proof_head: '[{"pubk',
        admit_block_btc:  admitBlocks ? admitBlocks.BTC : null,
        admit_block_doge: admitBlocks ? admitBlocks.DOGE : null
    }));
}

async function publisher() {
    let h = makePublisher({ db: makeDb({ snapshots: [] }) });
    await h.p.start();
    return h;
}

function captureLogsAndClean() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
        sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
        sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
    });
    afterEach(function () { cleanupPublisherBatch(); });
}

describe('oracle publisher buffer: the admission map is signable content', function () {
    captureLogsAndClean();

    it('replaces a re-finalized round whose admission map changed under an equal header', async function () {
        let h = await publisher();
        await h.p.bufferFinalizedRound(finalized(3, M1));
        await h.p.bufferFinalizedRound(finalized(3, M2));
        expect(h.p._buffer.get(3).admitBlocks).to.deep.equal(M2);
        expect(readJsonl(h.bufferPath).filter(e => e.round === 3).pop().admitBlocks).to.deep.equal(M2);
        expect(logs.warn.join('\n')).to.match(/round 3 re-finalized with different content/);
    });

    it('treats a present map and an absent one as different rounds, both ways', async function () {
        let h = await publisher();
        await h.p.bufferFinalizedRound(finalized(4, null));
        await h.p.bufferFinalizedRound(finalized(4, M1));
        expect(h.p._buffer.get(4).admitBlocks).to.deep.equal(M1);
        await h.p.bufferFinalizedRound(finalized(4, null));
        expect(h.p._buffer.get(4)).to.not.have.property('admitBlocks');
    });

    it('keeps an identical re-finalization a no-op, map key order and spelling aside', async function () {
        let h = await publisher();
        await h.p.bufferFinalizedRound(finalized(5, M1));
        let lines = readJsonl(h.bufferPath).length;
        await h.p.bufferFinalizedRound(finalized(5, { DOGE: '5000010', BTC: '900010' }));
        expect(readJsonl(h.bufferPath)).to.have.length(lines);
        expect(logs.warn.join('\n')).to.not.match(/re-finalized with different content/);
    });
});

describe('oracle publisher buffer: reconciling the admission map against price_snapshots', function () {
    captureLogsAndClean();

    it('refreshes a buffered map that disagrees with this hub\'s own price_snapshots', async function () {
        let h = await publisher();
        await h.p.bufferFinalizedRound(finalized(0, M1));
        await h.p.bufferFinalizedRound(finalized(1, null));
        await h.p.bufferFinalizedRound(finalized(2, M1));
        h.hub.db.findPriceSnapshotsByRoundNumber = sinon.stub().resolves(
            rowsFor(0, M2).concat(rowsFor(1, M1), rowsFor(2, M1)));
        expect(await h.p.reconcileBufferedWindow(0, 5)).to.equal(2);
        expect(h.p._buffer.get(0).admitBlocks).to.deep.equal(M2);
        expect(h.p._buffer.get(1).admitBlocks).to.deep.equal(M1);
        let disk = readJsonl(h.bufferPath);
        expect(disk.find(e => e.round === 0).admitBlocks).to.deep.equal(M2);
        expect(logs.warn.join('\n')).to.match(/buffered round 0 disagreed/);
        expect(logs.warn.join('\n')).to.not.match(/buffered round 2 disagreed/);
    });

    it('never equates an unencodable map with a signable one', function () {
        let p = makePublisher({}).p;
        let base = { round: 1, timestamp: 2, btcBlockHeight: 3, pairs: [] };
        let bad = Object.assign({}, base, { admitBlocks: { BTC: '-1' } });
        expect(p.sameBufferedRound(bad, Object.assign({}, base, { admitBlocks: { BTC: 1 } }))).to.equal(false);
        expect(p.sameBufferedRound(bad, base)).to.equal(false);
        expect(p.sameBufferedRound(bad, Object.assign({}, bad))).to.equal(true);
    });
});
