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
function snapshotHub(calls) {
  return {
    async getSnapshot(cap, block) {
      calls.push(['count', cap, block]);
      return {
        validators: [{
          pubkey: 'aa'.repeat(33)
        }]
      };
    },
    async getWeightSnapshot(cap, block) {
      calls.push(['weight', cap, block]);
      // Weighted snapshots carry one row per (source, pubkey): the same key
      // delegated by two sources must collapse to one member.
      return {
        validators: [{
          pubkey: 'bb'.repeat(33),
          source: 's1',
          weight: '1'
        }, {
          pubkey: 'bb'.repeat(33),
          source: 's2',
          weight: '2'
        }, {
          pubkey: 'cc'.repeat(33),
          source: 's3',
          weight: '3'
        }]
      };
    }
  };
}
function registerSplitSuitePart1() {
  it('above STAKE_WEIGHTED_QUORUM it reads the WEIGHT snapshot (the set the indexer verifies against)', async () => {
    let calls = [];
    let {
      pub
    } = buildPub({
      network: 'regtest',
      capabilitySnapshot: snapshotHub(calls)
    });
    expect(swq.isStakeWeightedQuorumActive(100, 'regtest'), 'regtest activates at 0').to.equal(true);
    let set = await pub._getActiveOraclePublishPubkeys(100);
    expect(calls.map(c => c[0])).to.deep.equal(['weight']);
    expect(set, 'deduped to distinct pubkeys, sorted').to.deep.equal(['bb'.repeat(33), 'cc'.repeat(33)]);
  });
  it('below the flag-day it still reads the COUNT snapshot (legacy path unchanged)', async () => {
    let calls = [];
    let {
      pub
    } = buildPub({
      network: 'mainnet',
      capabilitySnapshot: snapshotHub(calls)
    });
    expect(swq.isStakeWeightedQuorumActive(100, 'mainnet'), 'mainnet is unarmed at block 100').to.equal(false);
    let set = await pub._getActiveOraclePublishPubkeys(100);
    expect(calls.map(c => c[0])).to.deep.equal(['count']);
    expect(set).to.deep.equal(['aa'.repeat(33)]);
  });
  it('an unknown deployment network resolves the gate OFF, keeping the pre-fix count path', async () => {
    let calls = [];
    let {
      pub
    } = buildPub({
      network: '',
      capabilitySnapshot: snapshotHub(calls)
    });
    let set = await pub._getActiveOraclePublishPubkeys(100);
    expect(calls.map(c => c[0])).to.deep.equal(['count']);
    expect(set).to.deep.equal(['aa'.repeat(33)]);
  });
}
function registerSplitSuitePart2() {
  it('still fails closed to an empty set when the pinned snapshot throws', async () => {
    let {
      pub
    } = buildPub({
      network: 'regtest',
      capabilitySnapshot: {
        async getSnapshot() {
          throw new Error('indexer down');
        },
        async getWeightSnapshot() {
          throw new Error('indexer down');
        }
      }
    });
    expect(await pub._getActiveOraclePublishPubkeys(100)).to.deep.equal([]);
  });
  it('the UNPINNED (blockIndex null) membership pre-filter is untouched by the flag-day', async () => {
    let calls = [];
    let {
      pub
    } = buildPub({
      network: 'regtest',
      capabilitySnapshot: snapshotHub(calls),
      capabilityRegistry: {
        async getActiveValidators() {
          return ['DD'.repeat(33)];
        }
      }
    });
    let set = await pub._getActiveOraclePublishPubkeys(null);
    expect(calls, 'no pinned snapshot read at all').to.deep.equal([]);
    expect(set).to.deep.equal(['dd'.repeat(33)]);
  });
}
describe('StateAnchorPublisher follower co-sign gate follows the flag-day', () => {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
});
