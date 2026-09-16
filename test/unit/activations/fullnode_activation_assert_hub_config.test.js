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

// NODEPROOF full-node tier activation preflight. The tier ships INERT
// (REWARD_SHARE '0', GENESIS_VERIFIERS []) and activation is a fleet-wide
// consensus change, so the hub (a) refuses a per-operator FULLNODE override that
// diverges from the pinned coin bundle, (b) refuses an incoherent activation that
// could never pay out or could never reach verifier quorum, and (c) seeds its own
// FULLNODE config from that bundle instead of hardcoded literals.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sinon = require('sinon');
const {
  expect
} = require('chai');
const XChainHub = require('../../../src/XChainHub.js');
const coins = require('../../../src/coins');
const activation = require('../../../src/lib/fullnode_activation.js');
const CANONICAL = coins.getCoinConfig('BTC', 'mainnet').FULLNODE;
const PK1 = 'a'.repeat(64);
const PK2 = 'b'.repeat(64);
function makeHub(network) {
  return new XChainHub(null, null, null, null, null, network === undefined ? null : {
    HUB_NETWORK: network
  });
}

// An activated block that is internally coherent: what a real activation looks like.
function activatedCfg(overrides) {
  return Object.assign({}, CANONICAL, {
    REWARD_SHARE: '0.25',
    GENESIS_VERIFIERS: [PK1, PK2]
  }, overrides || {});
}

describe('XChainHub.seedCanonicalFullnode', function () {
  it('seeds at CONSTRUCTION, before startP2P builds FullNodeChallengeRound', function () {
    // The engine snapshots cfg.FULLNODE in its constructor, so a seed that only
    // ran in startCapabilities (which api.js calls AFTER startP2P) would never
    // reach it and the hub would keep running hardcoded literals.
    let hub = makeHub('mainnet');
    expect(hub.p2pConfig.FULLNODE).to.be.an('object');
    expect(hub.p2pConfig.FULLNODE.PROOF_WINDOW_BLOCKS).to.equal(CANONICAL.PROOF_WINDOW_BLOCKS);
  });
  it('never creates p2pConfig (a null one is standalone mode, startP2P returns early)', function () {
    let hub = makeHub(undefined);
    expect(hub.p2pConfig).to.equal(null);
    hub.seedCanonicalFullnode();
    expect(hub.p2pConfig).to.equal(null);
  });
  it('seeds the canonical bundle when the operator supplied nothing', function () {
    let hub = makeHub('mainnet');
    hub.seedCanonicalFullnode();
    expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal(CANONICAL.REWARD_SHARE);
    expect(hub.p2pConfig.FULLNODE.CHALLENGE_INTERVAL_BLOCKS).to.equal(CANONICAL.CHALLENGE_INTERVAL_BLOCKS);
    expect(hub.p2pConfig.FULLNODE.GENESIS_VERIFIERS).to.deep.equal([]);
  });
  it('keeps operator local keys on top of the bundle', function () {
    let hub = makeHub('mainnet');
    hub.p2pConfig.FULLNODE = {
      BTC_RPC: 'http://coin'
    };
    hub.seedCanonicalFullnode();
    expect(hub.p2pConfig.FULLNODE.BTC_RPC).to.equal('http://coin');
    expect(hub.p2pConfig.FULLNODE.PROOF_WINDOW_BLOCKS).to.equal(CANONICAL.PROOF_WINDOW_BLOCKS);
  });
  it('is idempotent across a config hot-reload', function () {
    let hub = makeHub('mainnet');
    hub.seedCanonicalFullnode();
    let first = JSON.stringify(hub.p2pConfig.FULLNODE);
    hub.seedCanonicalFullnode();
    expect(JSON.stringify(hub.p2pConfig.FULLNODE)).to.equal(first);
  });
  it('picks up the regtest env override so the hub matches its indexer', function () {
    // The regtest venue activates the tier with FULLNODE_* env vars; before
    // those reached the indexer only, and the hub kept the inert values.
    process.env.FULLNODE_GENESIS_VERIFIERS = PK1 + ',' + PK2.toUpperCase();
    process.env.FULLNODE_CHALLENGE_INTERVAL_BLOCKS = '4';
    try {
      let hub = makeHub('regtest');
      hub.seedCanonicalFullnode();
      expect(hub.p2pConfig.FULLNODE.GENESIS_VERIFIERS).to.deep.equal([PK1, PK2]);
      expect(hub.p2pConfig.FULLNODE.CHALLENGE_INTERVAL_BLOCKS).to.equal(4);
    } finally {
      delete process.env.FULLNODE_GENESIS_VERIFIERS;
      delete process.env.FULLNODE_CHALLENGE_INTERVAL_BLOCKS;
    }
  });
});
describe('XChainHub.loadCapabilityConfigFile FULLNODE integration', function () {
  let tmpPath, warnStub, logStub;
  beforeEach(function () {
    warnStub = sinon.stub(console, 'warn');
    logStub = sinon.stub(console, 'log');
  });
  afterEach(function () {
    warnStub.restore();
    logStub.restore();
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  });
  function writeConfig(obj) {
    tmpPath = path.join(os.tmpdir(), 'xc283_caps_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(tmpPath, JSON.stringify(obj));
    return tmpPath;
  }
  it('refuses a divergent FULLNODE file on mainnet WITHOUT merging it', function () {
    let hub = makeHub('mainnet');
    expect(() => hub.loadCapabilityConfigFile(writeConfig({
      FULLNODE: {
        REWARD_SHARE: '0.25'
      }
    }))).to.throw().with.property('code', 'FULLNODE_CONFIG_MISMATCH');
    // The refused value must not have leaked in: the hub keeps the pinned bundle.
    expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal(CANONICAL.REWARD_SHARE);
  });
  it('applies the assert to the "full_node" spelling alias too', function () {
    let hub = makeHub('mainnet');
    expect(() => hub.loadCapabilityConfigFile(writeConfig({
      full_node: {
        REWARD_SHARE: '0.25'
      }
    }))).to.throw().with.property('code', 'FULLNODE_CONFIG_MISMATCH');
  });
  it('loads a local-keys-only FULLNODE file and seeds the canonical knobs under it', function () {
    let hub = makeHub('mainnet');
    hub.loadCapabilityConfigFile(writeConfig({
      FULLNODE: {
        BTC_RPC: 'http://coin'
      }
    }));
    expect(hub.p2pConfig.FULLNODE.BTC_RPC).to.equal('http://coin');
    expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal(CANONICAL.REWARD_SHARE);
    expect(hub.p2pConfig.FULLNODE.CONFIRM_DEPTH).to.equal(CANONICAL.CONFIRM_DEPTH);
  });
});
