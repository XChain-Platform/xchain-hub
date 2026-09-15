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
function registerSplitSuitePart1() {
  it('keeps the legacy behavior with no existsCheck: retries pre-send failures with a fresh call, then succeeds', async function () {
    const pub = mkPub();
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      if (calls < 3) throw new Error('no UTXOs available for Dpub1');
      return {
        txid: 'tx-ok'
      };
    };
    const res = await pub.broadcastWithRetry(broadcaster, 'P', 5);
    expect(res.txid).to.equal('tx-ok');
    expect(calls).to.equal(3);
  });
  it('adopts an already-mined anchor on attempt 0 without broadcasting (lost ACK from a previous flush)', async function () {
    const pub = mkPub();
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      return {
        txid: 'fresh'
      };
    };
    const res = await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => ({
      exists: true,
      txid: 'landed-earlier'
    }));
    expect(res.txid).to.equal('landed-earlier');
    expect(res.exists).to.equal(true);
    expect(calls).to.equal(0);
  });
  it('checks existence again before every retry and adopts once the anchor appears', async function () {
    const pub = mkPub();
    let calls = 0,
      checks = 0;
    const broadcaster = async () => {
      calls++;
      throw new Error('definitive reject');
    };
    const res = await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => {
      checks++;
      return checks >= 2 ? {
        exists: true,
        txid: 'peer-anchor'
      } : null;
    });
    expect(res.txid).to.equal('peer-anchor');
    expect(calls).to.equal(1); // one safe failure, then adopted before the retry
  });
}
function registerSplitSuitePart2() {
  it('ambiguous send error: polls existence and adopts when the anchor turns up mined', async function () {
    const pub = mkPub();
    let calls = 0,
      checks = 0;
    const broadcaster = async () => {
      calls++;
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
    expect(calls).to.equal(1); // NEVER re-broadcast after the ambiguous send
  });
  it('ambiguous send error + still absent after the poll window: defers (throws) instead of re-broadcasting', async function () {
    const pub = mkPub();
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      throw ambiguousErr('socket hang up');
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => null);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(err.message).to.equal('socket hang up');
    expect(calls).to.equal(1);
  });
}
function registerSplitSuitePart3() {
  it('ambiguous send error + existence undetermined (check throws): defers without re-broadcasting', async function () {
    const pub = mkPub();
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      throw ambiguousErr();
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => {
        throw new Error('indexer unreachable');
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(err.anchorAmbiguousSend).to.equal(true);
    expect(calls).to.equal(1);
  });
  it('ambiguous send error with NO existsCheck (archive/chunk path): defers immediately, no re-broadcast', async function () {
    const pub = mkPub();
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      throw ambiguousErr();
    };
    let err = null;
    try {
      await pub.broadcastWithRetry(broadcaster, 'P', 5);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(calls).to.equal(1);
  });
  it('definitive rejections keep retrying with a fresh PSBT even when the check says absent', async function () {
    const pub = mkPub();
    let calls = 0;
    const broadcaster = async () => {
      calls++;
      if (calls < 4) throw new Error('Encoder RPC error: txn-mempool-conflict');
      return {
        txid: 'retried-ok'
      };
    };
    const res = await pub.broadcastWithRetry(broadcaster, 'P', 5, async () => null);
    expect(res.txid).to.equal('retried-ok');
    expect(calls).to.equal(4);
  });
}
describe('StateAnchorPublisher: broadcastWithRetry guard', function () {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
  registerSplitSuitePart3();
});
