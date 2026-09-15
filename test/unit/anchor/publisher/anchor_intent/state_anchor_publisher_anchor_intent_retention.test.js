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
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const {
  DB_METHODS
} = require('../../../../helpers/mockHub.js');

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
// A db double that records statements and reports a fixed delete count. The
// assertions are about the STATEMENT the sweep issues, since the invariants
// are its predicates, not about a re-implementation of MariaDB.
function mkRetentionDb(affected, failOnDelete) {
  const seen = [];
  return {
    ...DB_METHODS,
    seen: seen,
    async doQuery(sql, params) {
      seen.push({
        sql: sql,
        params: params
      });
      if (/^\s*DELETE/i.test(sql)) {
        if (failOnDelete) throw new Error('ER_LOCK_WAIT_TIMEOUT');
        return {
          affectedRows: affected === undefined ? 0 : affected
        };
      }
      return [];
    }
  };
}
const dels = db => db.seen.filter(q => /^\s*DELETE/i.test(q.sql));
function registerSplitSuitePart1() {
  afterEach(function () {
    delete process.env.ANCHOR_MARKER_RETENTION_MS;
  });
  it('defaults to a ~90-day window and honours p2pConfig, the env var, and 0 as "off"', function () {
    expect(mkPub(mkDb()).anchorMarkerRetentionMs).to.equal(7776000000);
    const cfg = new StateAnchorPublisher({
      db: mkDb(),
      p2pConfig: {
        ANCHOR_MARKER_RETENTION_MS: '900000'
      }
    });
    expect(cfg.anchorMarkerRetentionMs).to.equal(900000);
    process.env.ANCHOR_MARKER_RETENTION_MS = '111000';
    const env = new StateAnchorPublisher({
      db: mkDb(),
      p2pConfig: {
        ANCHOR_MARKER_RETENTION_MS: '900000'
      }
    });
    expect(env.anchorMarkerRetentionMs, 'the env var wins over p2pConfig').to.equal(111000);
    delete process.env.ANCHOR_MARKER_RETENTION_MS;
    const off = new StateAnchorPublisher({
      db: mkDb(),
      p2pConfig: {
        ANCHOR_MARKER_RETENTION_MS: '0'
      }
    });
    expect(off.anchorMarkerRetentionMs).to.equal(0);
    for (const bad of ['abc', '-5', '']) {
      const p = new StateAnchorPublisher({
        db: mkDb(),
        p2pConfig: {
          ANCHOR_MARKER_RETENTION_MS: bad
        }
      });
      expect(p.anchorMarkerRetentionMs, 'input ' + JSON.stringify(bad)).to.equal(7776000000);
    }
  });
}
function registerSplitSuitePart2() {
  it('sweeps BOTH tables with the sent_at IS NOT NULL filter on the intent_at column', async function () {
    const db = mkRetentionDb(3);
    const pub = mkPub(db);
    pub.anchorMarkerRetentionMs = 7776000000;
    pub.anchorIntentTtlMs = 21600000;
    expect(await pub.pruneAnchorMarkers()).to.equal(6);
    const d = dels(db);
    expect(d.length, 'both marker tables must be swept').to.equal(2);
    expect(d[0].sql).to.match(/FROM anchor_published_checkpoints/);
    expect(d[1].sql).to.match(/FROM anchor_published_archives/);
    for (const q of d) {
      expect(q.sql, 'the ambiguous-send record must never be deleted').to.match(/sent_at IS NOT NULL/);
      expect(q.sql, 'intent_at is the column anchorIntentHolds measures').to.match(/intent_at < DATE_SUB\(NOW\(\), INTERVAL \? SECOND\)/);
      expect(q.params[0]).to.equal(7776000);
    }
    expect(pub.anchorMarkersPruned).to.equal(6);
  });
  it('clamps the cutoff below the anchorIntentTtlMs hold window, which is the re-presentability floor', async function () {
    // A one-minute window would delete a marker that anchorIntentHolds still
    // answers true for, and the next flush would rebuild a second PSBT for a
    // checkpoint DOGE may already have paid for. The TTL floors it instead.
    const db = mkRetentionDb(0);
    const pub = mkPub(db);
    pub.anchorMarkerRetentionMs = 60000;
    pub.anchorIntentTtlMs = 21600000; // 6 h

    await pub.pruneAnchorMarkers();
    const floorSec = 21600000 * 8 / 1000;
    expect(dels(db)[0].params[0]).to.equal(floorSec);
    expect(floorSec * 1000, 'the cutoff sits strictly outside the hold window').to.be.greaterThan(pub.anchorIntentTtlMs);

    // Widening the TTL widens the floor with it.
    const db2 = mkRetentionDb(0);
    const pub2 = mkPub(db2);
    pub2.anchorMarkerRetentionMs = 60000;
    pub2.anchorIntentTtlMs = 43200000; // 12 h
    await pub2.pruneAnchorMarkers();
    expect(dels(db2)[0].params[0]).to.equal(43200000 * 8 / 1000);
  });
  it('issues no DELETE when retention is off or no DB is wired', async function () {
    const dbOff = mkRetentionDb(1);
    const off = mkPub(dbOff);
    off.anchorMarkerRetentionMs = 0;
    expect(await off.pruneAnchorMarkers()).to.equal(0);
    expect(dels(dbOff).length).to.equal(0);
    const noDb = mkPub(mkRetentionDb(1));
    noDb.db = null;
    expect(await noDb.pruneAnchorMarkers()).to.equal(0);
  });
}
function registerSplitSuitePart3() {
  it('runs the sweep at the end of a flush that reached the publishing stage', async function () {
    const db = mkRetentionDb(1);
    const pub = mkPub(db);
    pub.drainDeferredBundleDone = async () => {};
    pub.drainDeferredFinalized = async () => {};
    pub._drainDeferredRewardAttest = async () => {};
    pub._publishPendingCheckpoints = async () => [];
    pub._startArchiveRound = async () => 'none';
    pub.broadcastFn = async () => ({
      txid: 'x'
    });
    await pub.flush();
    await pub._retentionSweep;
    expect(dels(db).length).to.equal(2);
    expect(pub.anchorMarkersPruned).to.equal(2);
  });
  it('never lets a retention failure fail a flush that already spent DOGE', async function () {
    const db = mkRetentionDb(0, true); // every DELETE throws
    const pub = mkPub(db);
    pub.drainDeferredBundleDone = async () => {};
    pub.drainDeferredFinalized = async () => {};
    pub._drainDeferredRewardAttest = async () => {};
    pub._publishPendingCheckpoints = async () => [{
      chain: 'BTC',
      txid: 'paid'
    }];
    pub._startArchiveRound = async () => 'none';
    pub.broadcastFn = async () => ({
      txid: 'x'
    });
    const res = await pub.flush();
    await pub._retentionSweep; // the rejection is swallowed inside

    expect(res.error, 'a housekeeping failure must never be reported as a flush error').to.equal(undefined);
    expect(res.anchored).to.have.length(1);
    expect(pub.anchorMarkersPruned).to.equal(0);
  });
  it('surfaces the window and the lifetime prune count through getAnchorStats()', function () {
    const pub = mkPub(mkDb());
    pub.anchorMarkerRetentionMs = 250000;
    pub.anchorMarkersPruned = 9;
    const stats = pub.getAnchorStats();
    expect(stats.anchorMarkerRetentionMs).to.equal(250000);
    expect(stats.anchorMarkersPruned).to.equal(9);
  });
}
function registerSplitSuitePart4() {
  // ── marker-table retention (#4869) ────────────────────────────────────────
  // Both marker tables appended one row per DOGE-spending broadcast and removed
  // one only on a definitive pre-send failure, so a confirmed marker persisted for
  // the life of the deployment while the oracle_published_rounds sibling was swept.
  // Two invariants: only CONFIRMED rows are ever deleted (a surviving sent_at NULL
  // row is the AMBIGUOUS-send record, the only durable trace that DOGE may already
  // have paid), and the cutoff can never reach inside the anchorIntentTtlMs hold
  // window, which is the exact quantity every read path already measures.
  describe('marker-table retention (#4869)', function () {
    registerSplitSuitePart1();
    registerSplitSuitePart2();
    registerSplitSuitePart3();
  });
}
describe('StateAnchorPublisher: durable at-most-once anchor intent', function () {
  registerSplitSuitePart4();
});
