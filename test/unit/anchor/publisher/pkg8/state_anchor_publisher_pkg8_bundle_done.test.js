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

// (flag-day Pkg 8) residual hub-side checkpoint/anchor signing legs:
//   - item 687: the publisher-attestation rounds must ABSTAIN on an unresolved
//     (empty) oracle_publish set instead of self-attesting a 1-of-N quorum the
//     chain rejects while this hub banks the anchor reward.
//   - item 933: the archive wrapper checkpoint must be selected on the CONSENSUS
//     key, never on the per-hub AUTO_INCREMENT `id`, because that row feeds the
//     archive election key which is required to be identical on every hub.
//   - item 931: the follower co-sign gate must resolve membership through the
//     same flag-day-aware snapshot as the leader quorum and the on-chain verifier.
const {
  expect
} = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const swq = require('../../../../../src/stake_weighted_quorum');
const {
  DB_METHODS
} = require('../../../../helpers/mockHub.js');
const CP = {
  chain: 'BTC',
  network: 'regtest',
  block_index: 500,
  block_hash: 'c0'.repeat(32),
  ledger_hash: 'a1'.repeat(32),
  actions_hash: 'b2'.repeat(32),
  contract_hash: 'c3'.repeat(32),
  checkpoint_seq: 100,
  snapshot_block: 100
};
function buildPub(opts) {
  opts = opts || {};
  let identity = opts.identity !== undefined ? opts.identity : new ValidatorIdentity('11'.repeat(32));
  let hub = {
    db: {
      ...DB_METHODS,
      queries: [],
      async doQuery(sql, params) {
        this.queries.push({
          sql,
          params
        });
        return opts.doQuery ? await opts.doQuery(sql, params) : [];
      }
    },
    network: opts.network !== undefined ? opts.network : 'regtest',
    capabilitySnapshot: opts.capabilitySnapshot || null,
    capabilityRegistry: opts.capabilityRegistry || null,
    getIdentity: () => identity,
    getPeerManager: () => opts.peerManager !== undefined ? opts.peerManager : {
      broadcast() {}
    },
    p2pConfig: opts.p2pConfig || {},
    resolveBtcLatestBlock: async () => 100
  };
  let pub = new StateAnchorPublisher(hub);
  return {
    pub,
    hub,
    identity
  };
}

// The publisher broadcasts XANC_BUNDLE_DONE the instant the DOGE
// broadcast returns a txid (0 confirmations), while the receiver only stamps at
// dogeConfirmations depth (60 on DOGE, ~1h). Because the announcement is one-shot,
// a peer that answers 'absent' and drops it leaves anchor_txid NULL forever, and the
// duplicate-anchor suppression that the `anchor_txid IS NULL` selector exists for never
// engages: each hub re-anchors (real DOGE) as its rank unlocks. So a not-yet-buried
// announcement is deferred and re-verified, never dropped.

// A receiver whose on-chain verdict is scripted, with the DB reduced to the two
// statements the BUNDLE_DONE path touches. The announcement carries TWO sections,
// so the per-section stamp and the all-sections-verified rule are both exercised.
// The publisher broadcasts XANC_BUNDLE_DONE the instant the DOGE
// broadcast returns a txid (0 confirmations), while the receiver only stamps at
// dogeConfirmations depth (60 on DOGE, ~1h). Because the announcement is one-shot,
// a peer that answers 'absent' and drops it leaves anchor_txid NULL forever, and the
// duplicate-anchor suppression that the `anchor_txid IS NULL` selector exists for never
// engages: each hub re-anchors (real DOGE) as its rank unlocks. So a not-yet-buried
// announcement is deferred and re-verified, never dropped.
// A receiver whose on-chain verdict is scripted, with the DB reduced to the two
// statements the BUNDLE_DONE path touches. The announcement carries TWO sections,
// so the per-section stamp and the all-sections-verified rule are both exercised.
function buildReceiver(opts) { opts = opts || {}; let identity = new ValidatorIdentity('11'.repeat(32)); let me = identity.getPubkeyHex().toLowerCase(); let base = { network: 'regtest', snapshot_block: 100, anchor_txid: null, block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32) }; let rows = [Object.assign({ chain: 'BTC', block_index: 494, checkpoint_seq: 7 }, base), Object.assign({ chain: 'LTC', block_index: 990, checkpoint_seq: 7 }, base)]; let updates = []; let { pub } = buildPub({ ...DB_METHODS, identity, async doQuery(sql, params) { if (sql.startsWith('SELECT * FROM state_checkpoints')) { let hit = rows.find(r => r.chain === params[0] && Number(r.block_index) === Number(params[2])); return hit ? [Object.assign({}, hit)] : []; } if (sql.startsWith('UPDATE state_checkpoints SET anchor_txid')) { updates.push(params); let hit = rows.find(r => r.chain === params[1] && Number(r.block_index) === Number(params[3])); if (hit && hit.anchor_txid == null) hit.anchor_txid = params[0]; return []; } return []; } }); pub._getActiveOraclePublishPubkeys = async () => [me]; // sole member => rank 0, unlocked
pub.recordReward = () => {}; // isolate the stamp assertion
pub.verdict = opts.verdict || 'absent'; pub.verifyAnchorOnChain = async () => pub.verdict; let d = { network: 'regtest', snapshot_block: 100, txid: 'aa'.repeat(32), sections: rows.map(r => ({ chain: r.chain, block_index: r.block_index, checkpoint_seq: r.checkpoint_seq })) }; d.sig_pubkey = me; d.sig = identity.sign(pub.bundleDoneCanonical(d, d.txid)); return { pub, d, me, rows, updates, envelope: { type: 'XANC_BUNDLE_DONE', sender: me, data: d } }; }
function registerSplitSuitePart1() {
  it('queues a mempool-age announcement, then stamps every section once the anchor confirms', async () => {
    let r = buildReceiver({
      verdict: 'absent'
    });
    await r.pub.handleBundleDone(r.envelope);
    expect(r.updates.length, 'nothing stamped off an unconfirmed anchor').to.equal(0);
    expect(r.pub._deferredBundleDone.size, 'announcement retained for re-verification').to.equal(1);

    // Still not buried: the drain leaves it queued and stamps nothing.
    r.pub.verdict = 'shallow';
    await r.pub.drainDeferredBundleDone();
    expect(r.updates.length).to.equal(0);
    expect(r.pub._deferredBundleDone.size).to.equal(1);

    // 60 confirmations later. EVERY section is stamped from the one announcement.
    r.pub.verdict = 'verified';
    await r.pub.drainDeferredBundleDone();
    expect(r.updates.length, 'stamped once buried, one row per section').to.equal(2);
    expect(r.updates.map(u => u[0])).to.deep.equal([r.d.txid, r.d.txid]);
    expect(r.updates.map(u => u[1]), 'both chains').to.deep.equal(['BTC', 'LTC']);
    expect(r.updates[0][4], 'keyed on checkpoint_seq').to.equal(7);
    expect(r.pub._deferredBundleDone.size, 'queue drained').to.equal(0);
  });
  it('an already-buried announcement still stamps immediately, without queuing', async () => {
    let r = buildReceiver({
      verdict: 'verified'
    });
    await r.pub.handleBundleDone(r.envelope);
    expect(r.updates.length).to.equal(2);
    expect(r.pub._deferredBundleDone.size).to.equal(0);
  });
  it('a positively-detected forge is dropped, never queued', async () => {
    for (let verdict of ['rejected:mismatch', 'rejected:txid', 'rejected:version', 'rejected:status']) {
      let r = buildReceiver({
        verdict
      });
      await r.pub.handleBundleDone(r.envelope);
      expect(r.updates.length, verdict).to.equal(0);
      expect(r.pub._deferredBundleDone.size, verdict + ' must not be retried').to.equal(0);
    }
  });
}
function registerSplitSuitePart2() {
  it('a queued announcement that never confirms expires, so the failover ladder can re-anchor', async () => {
    let r = buildReceiver({
      verdict: 'absent'
    });
    r.pub.announceRetryTtlMs = -1; // already past its TTL on the next drain
    await r.pub.handleBundleDone(r.envelope);
    expect(r.pub._deferredBundleDone.size).to.equal(1);
    r.pub.verdict = 'verified'; // even a late confirm cannot resurrect it
    await r.pub.drainDeferredBundleDone();
    expect(r.pub._deferredBundleDone.size, 'expired entry dropped').to.equal(0);
    expect(r.updates.length, 'nothing stamped from an expired entry').to.equal(0);
  });
  it('drops the queued entry (without a second stamp) once every section is already anchored', async () => {
    let r = buildReceiver({
      verdict: 'absent'
    });
    await r.pub.handleBundleDone(r.envelope);
    for (let row of r.rows) row.anchor_txid = 'bb'.repeat(32); // our own publish stamped them meanwhile
    r.pub.verdict = 'verified';
    await r.pub.drainDeferredBundleDone();
    expect(r.updates.length, 'no redundant UPDATE').to.equal(0);
    expect(r.pub._deferredBundleDone.size).to.equal(0);
  });
  it('the queue is bounded: a flood evicts the oldest entry, never grows without limit', async () => {
    let r = buildReceiver({
      verdict: 'absent'
    });
    r.pub.announceQueueMax = 3;
    for (let block = 1; block <= 10; block++) r.pub.deferBundleDone({
      network: 'regtest',
      snapshot_block: block,
      txid: 'cc'.repeat(32),
      sections: [{
        chain: 'BTC',
        block_index: 400 + block,
        checkpoint_seq: block
      }]
    }, r.me, 'absent');
    expect(r.pub._deferredBundleDone.size).to.equal(3);
    expect([...r.pub._deferredBundleDone.keys()].some(k => k.startsWith('regtest|8|')), 'newest kept').to.equal(true);
    expect([...r.pub._deferredBundleDone.keys()].some(k => k.startsWith('regtest|1|')), 'oldest evicted').to.equal(false);
  });
  it('a duplicate announcement for the same txid does not double-queue', async () => {
    let r = buildReceiver({
      verdict: 'absent'
    });
    await r.pub.handleBundleDone(r.envelope);
    await r.pub.handleBundleDone(r.envelope);
    expect(r.pub._deferredBundleDone.size).to.equal(1);
  });
}
function registerSplitSuitePart3() {
  it('flush drains the queue before the failover-rank re-anchor decision', async () => {
    let r = buildReceiver({
      verdict: 'verified'
    });
    r.pub.deferBundleDone(r.d, r.me, 'absent');
    r.pub.publishPendingCheckpoints = async () => []; // isolate flush from the publish pipeline
    r.pub.startArchiveRound = async () => 'none';
    await r.pub.flush();
    expect(r.updates.length, 'queued announcement applied during flush').to.equal(2);
    expect(r.pub._deferredBundleDone.size).to.equal(0);
  });
  it('refuses an announcement whose signed section list does not match what it carries', async () => {
    // The canonical binds every section identity, so re-pointing a signed
    // announcement at a different checkpoint row invalidates the signature.
    let r = buildReceiver({
      verdict: 'verified'
    });
    let tampered = Object.assign({}, r.d, {
      sections: [{
        chain: 'BTC',
        block_index: 494,
        checkpoint_seq: 7
      }, {
        chain: 'LTC',
        block_index: 990,
        checkpoint_seq: 8
      }]
    });
    await r.pub.handleBundleDone({
      type: 'XANC_BUNDLE_DONE',
      sender: r.me,
      data: tampered
    });
    expect(r.updates.length, 'nothing stamped from a re-pointed announcement').to.equal(0);
  });
}
describe('StateAnchorPublisher defers a not-yet-buried BUNDLE_DONE instead of dropping it', () => {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
  registerSplitSuitePart3();
});
