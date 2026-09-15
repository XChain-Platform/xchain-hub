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

// broadcastWithRetry double-broadcast guard. A lost ACK on a
// mempool-accepted DOGE anchor must never lead to a rebuilt-PSBT re-broadcast
// (a double-spend: fresh UTXOs mean both txs can confirm). Covers the
// pre-broadcast existence check, the ambiguous-send error classification in
// defaultBroadcast, the bounded post-ambiguous existence poll, and the
// defer-over-risk rule; also pins that safe pre-send failures keep the
// original fresh-PSBT retry behavior (the live multi-chain conflict fix).
const {
  expect
} = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
function mkPub() {
  const pub = new StateAnchorPublisher({
    db: {},
    p2pConfig: {
      DOGE_ADDRESS: 'Dpub1'
    }
  });
  pub.chunkRetryDelayMs = 1;
  pub.ambiguousPollDelayMs = 1;
  pub.ambiguousPollAttempts = 2;
  return pub;
}
function ambiguousErr(msg) {
  const e = new Error(msg || 'timeout');
  e.anchorAmbiguousSend = true;
  return e;
}

// The spend-guard half of the same method: which exits charge the per-window
// budget, and whether an operator pause asserted mid-retry stops the next send.
// An entry-only allow() plus a record() reached only on the fresh-send success
// branch answers neither: an ambiguous (lost-ACK) send pays a real fee against a
// window that records nothing, and a pause landing during the retry delay stays
// invisible to the loop.

// Cents charged to the rolling window by this call, whatever exit it took.
function spent(pub) {
  return pub.spendGuard.spentInWindow();
}
function registerSplitSuitePart1() {
  it('a fresh successful send charges the window exactly once', async function () {
    const pub = mkPub();
    const est = pub.spendGuard.estSpendUsdCents;
    const broadcaster = async () => ({
      txid: 'tx-ok'
    });
    await pub.broadcastWithRetry(broadcaster, 'P', 5);
    expect(spent(pub)).to.equal(est);
  });
  it('an ambiguous send adopted by the poll charges the window (the fee was paid)', async function () {
    const pub = mkPub();
    const est = pub.spendGuard.estSpendUsdCents;
    let checks = 0;
    const broadcaster = async () => {
      throw ambiguousErr();
    };
    const res = await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => {
      checks++;
      return checks >= 2 ? {
        exists: true,
        txid: 'mined-late'
      } : null;
    });
    expect(res.txid).to.equal('mined-late');
    expect(spent(pub)).to.equal(est);
  });
  it('an ambiguous send deferred after the poll window still charges the window', async function () {
    const pub = mkPub();
    const est = pub.spendGuard.estSpendUsdCents;
    const broadcaster = async () => {
      throw ambiguousErr('socket hang up');
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => null);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(spent(pub)).to.equal(est);
  });
}
function registerSplitSuitePart2() {
  it('adopting an already-mined anchor before any send charges nothing', async function () {
    const pub = mkPub();
    const broadcaster = async () => ({
      txid: 'fresh'
    });
    await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => ({
      exists: true,
      txid: 'landed-earlier'
    }));
    expect(spent(pub)).to.equal(0);
  });
  it('a definitive failure that exhausts the retry budget charges nothing', async function () {
    const pub = mkPub();
    const broadcaster = async () => {
      throw new Error('Encoder RPC error: bad-txns');
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 3, async () => null);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(spent(pub)).to.equal(0);
  });
  it('a consumed window refuses the send outright with err.spendBlocked', async function () {
    const pub = mkPub();
    pub.spendGuard.maxSpendUsdCents = 1; // below one estimated send
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      return {
        txid: 'nope'
      };
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 5);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(err.spendBlocked).to.equal(true);
    expect(calls).to.equal(0);
  });
}
function registerSplitSuitePart3() {
  it('a pause asserted during the retry delay stops the next broadcast', async function () {
    const pub = mkPub();
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      if (calls === 1) throw new Error('Encoder RPC error: txn-mempool-conflict');
      return {
        txid: 'should-not-happen'
      };
    };
    // The operator halt lands while the retry is sleeping.
    pub.sleep = async () => {
      pub.spendGuard.pause('operator halt');
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 5);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(err.spendBlocked).to.equal(true);
    expect(calls).to.equal(1);
    expect(spent(pub)).to.equal(0); // the unsent attempt gives its budget back
  });

  // A pause landing around an ambiguous send must not convert the deferral into a
  // spendBlocked error: the caller withdraws the anchor intent markers for every
  // failure NOT flagged anchorAmbiguousSend, and losing them after a send that may
  // have reached the network is how the same anchor gets paid for twice.
}
function registerSplitSuitePart4() {
  it('a pause landing around an ambiguous send keeps the ambiguity flag and charges the fee', async function () {
    const pub = mkPub();
    const est = pub.spendGuard.estSpendUsdCents;
    let calls = 0,
      checks = 0;
    const broadcaster = async () => {
      calls++;
      throw ambiguousErr('socket hang up');
    };
    // Absent from the mined view, then the halt lands before the loop re-enters.
    const existsCheck = async () => {
      checks++;
      if (checks > 1) pub.spendGuard.pause('operator halt');
      return null;
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 5, existsCheck);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(err.anchorAmbiguousSend).to.equal(true);
    expect(err.spendBlocked).to.equal(undefined);
    expect(calls).to.equal(1);
    expect(spent(pub)).to.equal(est);
  });
}
describe('StateAnchorPublisher: broadcastWithRetry spend accounting', function () {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
  registerSplitSuitePart3();
  registerSplitSuitePart4();
});
