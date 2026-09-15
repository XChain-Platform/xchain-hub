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
const StateAnchorPublisher = require('../../src/anchor/publisher');
const ValidatorIdentity = require('../../src/validators/identity');
const swq = require('../../src/stake_weighted_quorum');
const {
  DB_METHODS
} = require('../helpers/mockHub.js');
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
    _resolveBtcLatestBlock: async () => 100
  };
  let pub = new StateAnchorPublisher(hub);
  return {
    pub,
    hub,
    identity
  };
}
// Two checkpoints whose hub-local insertion order (id) DISAGREES with the
// consensus order (checkpoint_seq): the later-inserted row is the OLDER
// round, exactly what happens on a hub that back-fills a missed FINALIZED.
const ROWS = [{
  id: 1,
  chain: 'BTC',
  network: 'regtest',
  block_index: 520,
  block_hash: 'c0'.repeat(32),
  ledger_hash: 'a1'.repeat(32),
  actions_hash: 'b2'.repeat(32),
  contract_hash: 'c3'.repeat(32),
  checkpoint_seq: 106,
  snapshot_block: 106
}, {
  id: 2,
  chain: 'BTC',
  network: 'regtest',
  block_index: 500,
  block_hash: 'c1'.repeat(32),
  ledger_hash: 'a2'.repeat(32),
  actions_hash: 'b3'.repeat(32),
  contract_hash: 'c4'.repeat(32),
  checkpoint_seq: 100,
  snapshot_block: 100
}];

// A finalized, never-archived match: the archive's real cargo. Only its
// pending-ness matters here; the round bails at the rank gate before it
// reads any other field.
const PENDING_MATCH = {
  match_id: 'm1',
  status: 'finalized',
  archived_status: null,
  batch_seq: null
};

// Order the fixture rows the way the SQL asks, so the assertion tests the
// ORDER BY the code actually emits rather than a hard-coded string.
function orderRows(sql) {
  let clause = sql.split('ORDER BY')[1] || '';
  let terms = clause.replace(/LIMIT.*$/i, '').split(',').map(s => s.trim()).filter(Boolean);
  let rows = ROWS.slice();
  rows.sort((a, b) => {
    for (let t of terms) {
      let desc = /DESC\s*$/i.test(t);
      let key = t.replace(/\s+(ASC|DESC)\s*$/i, '').trim();
      let va, vb;
      if (key === "(chain = 'BTC')") {
        va = a.chain === 'BTC' ? 1 : 0;
        vb = b.chain === 'BTC' ? 1 : 0;
      } else if (key === 'id' || key in a) {
        va = a[key];
        vb = b[key];
      } else continue;
      if (va !== vb) return desc ? vb - va : va - vb;
    }
    return 0;
  });
  return rows;
}
function registerSplitSuitePart1() {
  it('selects the highest checkpoint_seq, not the highest AUTO_INCREMENT id', async () => {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let me = identity.getPubkeyHex().toLowerCase();
    let {
      pub
    } = buildPub({
      ...DB_METHODS,
      identity,
      async doQuery(sql) {
        // The cargo that carries the round to the wrapper pick is a pending
        // match: a regtest anchor reward is chain-derived above the flag-day
        // (active from 0 there) and no longer archive cargo.
        if (sql.startsWith('SELECT * FROM cross_chain_matches')) return [PENDING_MATCH];
        if (sql.startsWith('SELECT * FROM cross_chain_calls')) return [];
        if (sql.startsWith('SELECT * FROM validator_rewards')) return [];
        if (sql.startsWith('SELECT * FROM state_checkpoints')) return orderRows(sql).slice(0, 1);
        return [];
      }
    });
    pub._getActiveOraclePublishPubkeys = async () => [me];
    pub._getNextBatchSeq = async () => 3;
    let captured = null;
    pub._archiveElectionKey = (cp, batchSeq) => {
      captured = cp;
      return 'k|' + batchSeq;
    };
    pub._rankUnlocked = () => false; // bail right after the wrapper pick

    let r = await pub._startArchiveRound({}, 100);
    expect(r).to.equal('none');
    expect(captured, 'wrapper checkpoint was selected').to.not.equal(null);
    expect(captured.checkpoint_seq, 'consensus-newest row, though it has the LOWER id').to.equal(106);
    expect(captured.block_index).to.equal(520);
  });
}
function registerSplitSuitePart2() {
  it('never orders the wrapper pick on the hub-local id cursor', async () => {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let me = identity.getPubkeyHex().toLowerCase();
    let seen = [];
    let {
      pub
    } = buildPub({
      ...DB_METHODS,
      identity,
      async doQuery(sql) {
        if (sql.startsWith('SELECT * FROM state_checkpoints')) {
          seen.push(sql);
          return orderRows(sql).slice(0, 1);
        }
        if (sql.startsWith('SELECT * FROM cross_chain_matches')) return [PENDING_MATCH];
        return [];
      }
    });
    pub._getActiveOraclePublishPubkeys = async () => [me];
    pub._getNextBatchSeq = async () => 3;
    pub._rankUnlocked = () => false;
    await pub._startArchiveRound({}, 100);
    expect(seen.length).to.be.at.least(1);
    for (let sql of seen) {
      expect(sql, 'wrapper pick must not key on the per-hub insertion cursor').to.not.match(/ORDER BY[^;]*\bid\s+DESC/i);
      expect(sql).to.match(/checkpoint_seq DESC/);
    }
  });
}
describe('StateAnchorPublisher archive wrapper is picked on the consensus key', () => {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
});
