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

const { EventEmitter } = require('node:events');
const {
    expect,
    makePublisher,
    cleanupPublisherBatch
} = require('../batch/oracle_publisher_batch.test.js');

// stop() has to leave nothing that can re-arm the publisher: the round:finalized
// subscription is detached, a stop/start cycle subscribes once, and a round that
// finalizes after the stop arms no grace timer.

function finalizedEvent(round) {
    return { round: round, btcBlockHeight: 800000 + round, timestamp: 1800000000 + round,
             prices: [{ coinPair: 'BTC/USD', price: '60000' }], signatures: [] };
}

async function startedPublisher() {
    let h = makePublisher();
    h.hub.oracleConsensus = new EventEmitter();
    await h.p.start();
    return h;
}

const detachesOnStop = async function () {
    let h = await startedPublisher();
    expect(h.hub.oracleConsensus.listenerCount('round:finalized')).to.equal(1);

    h.p.stop();

    expect(h.hub.oracleConsensus.listenerCount('round:finalized')).to.equal(0);
};

const subscribesOnceAfterRestart = async function () {
    let h = await startedPublisher();

    h.p.stop();
    await h.p.start();

    expect(h.hub.oracleConsensus.listenerCount('round:finalized')).to.equal(1);
};

const armsNothingAfterStop = async function () {
    let h = await startedPublisher();
    h.p.stop();

    await h.p.onRoundFinalized(finalizedEvent(5));
    h.p.noteWindowRound(5);

    expect(h.p._buffer.size, 'nothing buffered').to.equal(0);
    for (let state of h.p._windows.values()) expect(state.timer, 'no grace timer').to.equal(null);
};

const stillArmsWhileRunning = async function () {
    let h = await startedPublisher();

    h.hub.oracleConsensus.emit('round:finalized', finalizedEvent(5));
    await new Promise(resolve => setImmediate(resolve));

    expect(h.p._buffer.has(5), 'the live handler buffers (control)').to.equal(true);
};

function registerStopFinalizedListener() {
    afterEach(function () {
        cleanupPublisherBatch();
    });
    it('detaches the round:finalized listener on stop', detachesOnStop);
    it('subscribes once after a stop and start cycle', subscribesOnceAfterRestart);
    it('buffers nothing and arms no grace timer for a round finalizing after stop', armsNothingAfterStop);
    it('still buffers a finalized round while running', stillArmsWhileRunning);
}

describe('OraclePublisher stop and the finalized-round listener', registerStopFinalizedListener);
