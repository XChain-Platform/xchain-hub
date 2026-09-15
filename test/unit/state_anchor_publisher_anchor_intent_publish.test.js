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

// durable at-most-once for the checkpoint-anchor spend. The existence
// check reads MINED indexer state, so a crash between an accepted-but-unmined broadcast
// and the `anchor_txid` stamp once left nothing recording that DOGE had paid, and
// the next flush rebuilt a fresh PSBT from different UTXOs (a second fee, two anchors
// that can both confirm). These pin the anchor_published_checkpoints marker: the hold,
// the mined-anchor fall-through, the TTL bound, and the withdraw/keep split between a
// definitive pre-send failure and an ambiguous send.
const {
  expect
} = require('chai');
const StateAnchorPublisher = require('../../src/anchor/publisher');
const {
  DB_METHODS
} = require('../helpers/mockHub.js');

// A db double that routes by SQL shape and records every statement it saw.
function mkDb(opts) {
  opts = opts || {};
  const seen = [];
  return {
    ...DB_METHODS,
    seen: seen,
    async doQuery(sql, params) {
      seen.push({
        sql: sql,
        params: params
      });
      if (sql.indexOf('FROM state_checkpoints sc JOIN') !== -1) return opts.pending || [];
      if (sql.indexOf('FROM anchor_published_checkpoints') !== -1) return opts.marker ? [opts.marker] : [];
      return [];
    }
  };
}
function mkRow() {
  return {
    chain: 'BTC',
    network: 'regtest',
    block_index: 900,
    block_hash: 'bh',
    ledger_hash: 'lh',
    actions_hash: 'ah',
    contract_hash: 'ch',
    checkpoint_seq: 100,
    snapshot_block: 800,
    // Root-bearing: an ANCHOR v0 section carries the light-client roots by
    // construction, and the selector skips a row that has none (D8).
    state_root: 'aa'.repeat(32),
    state_root_version: 1,
    block_merkle_root: 'bb'.repeat(32),
    block_merkle_version: 1,
    validator_signatures: '[]',
    anchor_txid: null
  };
}

// A publisher wired so _publishPendingCheckpoints reaches the broadcast decision with
// the election, flag-day and identity machinery out of the way.
function mkPub(db) {
  const pub = new StateAnchorPublisher({
    db: db,
    p2pConfig: {
      DOGE_ADDRESS: 'Dpub1'
    }
  });
  pub.chunkRetryDelayMs = 1;
  pub.ambiguousPollDelayMs = 1;
  pub.ambiguousPollAttempts = 1;
  pub.network = null; // no network filter on the pending select
  pub.identity = null; // skips the publisher-attestation round
  pub.peerManager = null; // skips the XANC_BUNDLE_DONE announce
  pub._getActiveOraclePublishPubkeys = async () => ['aa'];
  pub.mayPublish = () => true;
  return pub;
}
function sqlHits(db, needle) {
  return db.seen.filter(q => q.sql.indexOf(needle) !== -1);
}
// ORDERING: the marker is read before the publisher-attestation round, not after.
//
// Every case above runs with pub.identity = null, which is exactly the leg where
// the round is skipped, so none of them can see where the marker read sits
// relative to it. With an identity set and no gate, a held row solicits a full 2f+1
// XANCPUB quorum from the federation, occupy the single _attestRound slot for up
// to roundTimeoutMs, and make every peer re-derive the election, for a publish
// this loop then declines. The archive twin (_publishArchive) already checks its
// intent first and documents that ordering as deliberate.
function mkAttestingPub(db) {
  const pub = mkPub(db);
  pub.identity = {
    getPubkeyHex: () => 'AA'
  }; // arms the isAnchorRewardActive branch
  pub.rounds = 0;
  // A MET round. These cases are about WHERE the marker is read relative to the
  // round, not about what a degraded round does, and a degraded one now defers
  // the bundle before the publish path they exist to exercise is reached.
  pub.runPublisherAttestationRound = async () => {
    pub.rounds++;
    return {
      met: true,
      sigs: [{
        pubkey: 'aa'.repeat(32),
        sig: 'bb'.repeat(64)
      }],
      publisher: 'aa'
    };
  };
  return pub;
}
function registerSplitSuitePart1() {
  it('holds the checkpoint when an unconfirmed intent survives and the anchor is not yet mined', async function () {
    const db = mkDb({
      pending: [mkRow()],
      marker: {
        intent_at: new Date(),
        txid: 'earlier-tx',
        sent_at: null
      }
    });
    const pub = mkPub(db);
    pub.findExistingCheckpointAnchor = async () => null; // mined view: definitively absent
    let broadcasts = 0;
    const out = await pub._publishPendingCheckpoints({
      broadcastFn: async () => {
        broadcasts++;
        return {
          txid: 'fresh'
        };
      }
    }, 1000);
    expect(broadcasts).to.equal(0);
    expect(out).to.deep.equal([]);
    expect(sqlHits(db, 'UPDATE state_checkpoints SET anchor_txid')).to.have.length(0);
  });
}
function registerSplitSuitePart2() {
  it('falls through to the adopt path once the held anchor mines', async function () {
    const db = mkDb({
      pending: [mkRow()],
      marker: {
        intent_at: new Date(),
        txid: null,
        sent_at: null
      }
    });
    const pub = mkPub(db);
    pub.findExistingCheckpointAnchor = async () => ({
      exists: true,
      txid: 'mined-tx'
    });
    let broadcasts = 0;
    const out = await pub._publishPendingCheckpoints({
      broadcastFn: async () => {
        broadcasts++;
        return {
          txid: 'fresh'
        };
      }
    }, 1000);
    expect(broadcasts).to.equal(0); // adopted, never re-broadcast
    expect(out).to.have.length(1);
    expect(out[0].txid).to.equal('mined-tx');
  });
}
function registerSplitSuitePart3() {
  it('re-broadcasts once the intent ages past the TTL', async function () {
    const db = mkDb({
      pending: [mkRow()],
      marker: {
        intent_at: new Date(Date.now() - 60000),
        txid: null,
        sent_at: null
      }
    });
    const pub = mkPub(db);
    pub.anchorIntentTtlMs = 1000;
    pub.findExistingCheckpointAnchor = async () => null;
    let broadcasts = 0;
    const out = await pub._publishPendingCheckpoints({
      broadcastFn: async () => {
        broadcasts++;
        return {
          txid: 'fresh'
        };
      }
    }, 1000);
    expect(broadcasts).to.equal(1);
    expect(out[0].txid).to.equal('fresh');
  });
  it('arms intent BEFORE the broadcast and confirms it after', async function () {
    const db = mkDb({
      pending: [mkRow()]
    });
    const pub = mkPub(db);
    pub.findExistingCheckpointAnchor = async () => null;
    let armedBeforeSend = false;
    await pub._publishPendingCheckpoints({
      broadcastFn: async () => {
        armedBeforeSend = sqlHits(db, 'INSERT INTO anchor_published_checkpoints').length === 1;
        return {
          txid: 'fresh'
        };
      }
    }, 1000);
    expect(armedBeforeSend).to.equal(true);
    expect(sqlHits(db, 'UPDATE anchor_published_checkpoints SET txid')).to.have.length(1);
  });
}
function registerSplitSuitePart4() {
  it('withdraws the intent when the send definitively never went out', async function () {
    const db = mkDb({
      pending: [mkRow()]
    });
    const pub = mkPub(db);
    pub.findExistingCheckpointAnchor = async () => null;
    await pub._publishPendingCheckpoints({
      broadcastFn: async () => {
        throw new Error('no UTXOs available for Dpub1');
      }
    }, 1000);
    expect(sqlHits(db, 'DELETE FROM anchor_published_checkpoints')).to.have.length(1);
  });
  it('KEEPS the intent after an ambiguous send, which is the case the marker exists for', async function () {
    const db = mkDb({
      pending: [mkRow()]
    });
    const pub = mkPub(db);
    pub.findExistingCheckpointAnchor = async () => null;
    await pub._publishPendingCheckpoints({
      broadcastFn: async () => {
        const e = new Error('socket hang up');
        e.anchorAmbiguousSend = true;
        throw e;
      }
    }, 1000);
    expect(sqlHits(db, 'DELETE FROM anchor_published_checkpoints')).to.have.length(0);
  });
}
function registerSplitSuitePart5() {
  it('does not open a publisher-attestation round for a held, unmined checkpoint', async function () {
    const db = mkDb({
      pending: [mkRow()],
      marker: {
        intent_at: new Date(),
        txid: 'earlier-tx',
        sent_at: null
      }
    });
    const pub = mkAttestingPub(db);
    pub.findExistingCheckpointAnchor = async () => null;
    let broadcasts = 0;
    const out = await pub._publishPendingCheckpoints({
      broadcastFn: async () => {
        broadcasts++;
        return {
          txid: 'fresh'
        };
      }
    }, 1000);
    expect(pub.rounds, 'a held row must cost one DB read, not a federation quorum').to.equal(0);
    expect(broadcasts).to.equal(0);
    expect(out).to.deep.equal([]);
  });
  it('still runs the attestation round when the held anchor has mined (no over-skip)', async function () {
    // The mined fall-through is the half a careless reorder breaks: the row is
    // held AND mined, so the loop must continue into the normal publish/adopt path
    // rather than `continue`-ing past it.
    const db = mkDb({
      pending: [mkRow()],
      marker: {
        intent_at: new Date(),
        txid: null,
        sent_at: null
      }
    });
    const pub = mkAttestingPub(db);
    pub.findExistingCheckpointAnchor = async () => ({
      exists: true,
      txid: 'mined-tx'
    });
    const out = await pub._publishPendingCheckpoints({
      broadcastFn: async () => ({
        txid: 'fresh'
      })
    }, 1000);
    expect(pub.rounds, 'a held-but-mined row still takes the normal publish path').to.equal(1);
    expect(out).to.have.length(1);
    expect(out[0].txid).to.equal('mined-tx');
  });
}
function registerSplitSuitePart6() {
  it('runs the attestation round for an unheld checkpoint', async function () {
    // The negative control for the two cases above: with no marker the round must
    // still open, or "rounds === 0" would prove nothing about the ordering.
    const db = mkDb({
      pending: [mkRow()]
    });
    const pub = mkAttestingPub(db);
    pub.findExistingCheckpointAnchor = async () => null;
    await pub._publishPendingCheckpoints({
      broadcastFn: async () => ({
        txid: 'fresh'
      })
    }, 1000);
    expect(pub.rounds).to.equal(1);
  });
}
function registerSplitSuitePart7() {
  describe('_publishPendingCheckpoints', function () {
    registerSplitSuitePart1();
    registerSplitSuitePart2();
    registerSplitSuitePart3();
    registerSplitSuitePart4();
    registerSplitSuitePart5();
    registerSplitSuitePart6();
  });
}
describe('StateAnchorPublisher: durable at-most-once anchor intent', function () {
  registerSplitSuitePart7();
});
