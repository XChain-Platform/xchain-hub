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
function registerSplitSuitePart1() {
  it('v4/v5 round: an EMPTY oracle_publish set abstains instead of self-attesting', async () => {
    let {
      pub
    } = buildPub();
    pub._resolveCapabilitySet = async () => []; // resolver divergence: unresolved at snapshot_block
    let r = await pub.runPublisherAttestationRound(CP, 'D'.repeat(34));
    expect(r.met, 'must not claim quorum off an unresolved set').to.equal(false);
    expect(r.sigs).to.deep.equal([]);
    expect(r.publisher, 'no publisher is attested').to.equal(undefined);
  });
  it('v4/v5 round: a GENUINE single-member set containing us still self-signs', async () => {
    let {
      pub,
      identity
    } = buildPub();
    let me = identity.getPubkeyHex().toLowerCase();
    pub._resolveCapabilitySet = async () => [{
      pubkey: me,
      amount: '1',
      source: ''
    }];
    let r = await pub.runPublisherAttestationRound(CP, 'D'.repeat(34));
    expect(r.met).to.equal(true);
    expect(r.sigs.length).to.equal(1);
    expect(r.sigs[0].pubkey).to.equal(me);
  });
  it('v4/v5 round: a single-member set that is NOT us still abstains', async () => {
    let {
      pub
    } = buildPub();
    pub._resolveCapabilitySet = async () => [{
      pubkey: 'ab'.repeat(33),
      amount: '1',
      source: ''
    }];
    let r = await pub.runPublisherAttestationRound(CP, 'D'.repeat(34));
    expect(r.met).to.equal(false);
  });
  it('v1 archive round: an EMPTY oracle_publish set abstains instead of self-attesting', async () => {
    let {
      pub
    } = buildPub();
    pub._resolveCapabilitySet = async () => [];
    let r = await pub.runArchiveAttestationRound(CP, 7, 'D'.repeat(34));
    expect(r.met).to.equal(false);
    expect(r.sigs).to.deep.equal([]);
  });
}
function registerSplitSuitePart2() {
  it('v1 archive round: a genuine single-member set containing us still self-signs', async () => {
    let {
      pub,
      identity
    } = buildPub();
    let me = identity.getPubkeyHex().toLowerCase();
    pub._resolveCapabilitySet = async () => [{
      pubkey: me,
      amount: '1',
      source: ''
    }];
    let r = await pub.runArchiveAttestationRound(CP, 7, 'D'.repeat(34));
    expect(r.met).to.equal(true);
    expect(r.sigs.length).to.equal(1);
  });

  // _resolveCapabilitySet fails CLOSED off regtest (it THROWS when the deterministic
  // snapshot is unavailable). Inside these two rounds that throw would abort the whole
  // anchor / discard an already-collected archive quorum, which is exactly what the
  // publish path's own liveness note forbids: "a failed reward attestation must NEVER
  // block the anchor". A snapshot outage must degrade to the legacy payload instead.
  it('v4/v5 round: a THROWING resolver degrades to the legacy anchor instead of propagating', async () => {
    let {
      pub
    } = buildPub({
      network: 'mainnet'
    });
    pub._resolveCapabilitySet = async () => {
      throw new Error('deterministic snapshot unavailable');
    };
    let r = await pub.runPublisherAttestationRound(CP, 'D'.repeat(34));
    expect(r.met, 'no attestation, but the caller still publishes').to.equal(false);
    expect(r.sigs).to.deep.equal([]);
  });
}
function registerSplitSuitePart3() {
  it('v1 archive round: a THROWING resolver degrades to ATTEST_SIG_COUNT 0 instead of discarding the round', async () => {
    let {
      pub
    } = buildPub({
      network: 'mainnet'
    });
    pub._resolveCapabilitySet = async () => {
      throw new Error('deterministic snapshot unavailable');
    };
    let r = await pub.runArchiveAttestationRound(CP, 7, 'D'.repeat(34));
    expect(r.met).to.equal(false);
    expect(r.sigs).to.deep.equal([]);
  });
}
describe('StateAnchorPublisher publisher-attestation abstains on an unresolved set', () => {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
  registerSplitSuitePart3();
});
