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

const sinon              = require('sinon');
const { expect }         = require('chai');
const EventEmitter       = require('events');
const ValidatorIdentity  = require('../../src/validators/identity');
const PeerManager        = require('../../src/peers/manager');
const observability      = require('../../src/observability');
const { waitUntil }      = require('../helpers/waitUntil');
const { DB_METHODS }     = require('../helpers/mockHub');

let rootSuiteConfig, rootSuiteDbStub, rootSuitePm, rootSuiteKeypair;
function registerFeature1buildEnvelopePart1() {
  it('creates envelope with required fields', function () {
    let env = rootSuitePm.buildEnvelope('TEST', {
      foo: 'bar'
    });
    expect(env).to.have.property('id');
    expect(env.type).to.equal('TEST');
    expect(env.sender).to.equal('ws://self:10001');
    expect(env).to.have.property('timestamp');
    expect(env.data).to.deep.equal({
      foo: 'bar'
    });
  });
  it('includes signature when identity is set', function () {
    let identity = new ValidatorIdentity(rootSuiteKeypair.privkeyHex);
    rootSuitePm.setIdentity(identity);
    let env = rootSuitePm.buildEnvelope('TEST', {
      x: 1
    });
    expect(env.sig).to.be.a('string');
    expect(env.sig.length).to.equal(128);
  });
  it('has no signature when identity is not set', function () {
    let env = rootSuitePm.buildEnvelope('TEST', {});
    expect(env.sig).to.be.undefined;
  });
  it('generates unique IDs', function () {
    let a = rootSuitePm.buildEnvelope('T', {});
    let b = rootSuitePm.buildEnvelope('T', {});
    expect(a.id).to.not.equal(b.id);
  });
}
function registerFeature1buildEnvelope() {
  describe('buildEnvelope()', function () {
    registerFeature1buildEnvelopePart1();
  });
}
let feature2messageDeduplicationMockWs;
function feature2messageDeduplicationMakePeerEnvelope(type, data) {
  // Build envelope with a different sender (not self) to avoid self-connection guard
  return {
    id: 'msg-' + Date.now() + '-' + Math.random(),
    type: type,
    sender: 'ws://peer:10001',
    timestamp: Date.now(),
    data: data || {}
  };
}
function registerFeature2messageDeduplicationPart1() {
  it('accepts first occurrence of a message ID', function () {
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    let env = feature2messageDeduplicationMakePeerEnvelope('TEST', {});
    let raw = JSON.stringify(env);
    rootSuitePm.handleInbound(feature2messageDeduplicationMockWs, raw, 'ws://peer:10001');
    expect(emitted).to.equal(1);
  });
  it('rejects duplicate message ID', function () {
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    let env = feature2messageDeduplicationMakePeerEnvelope('TEST', {});
    let raw = JSON.stringify(env);
    rootSuitePm.handleInbound(feature2messageDeduplicationMockWs, raw, 'ws://peer:10001');
    rootSuitePm.handleInbound(feature2messageDeduplicationMockWs, raw, 'ws://peer:10001');
    expect(emitted).to.equal(1);
  });
}
function registerFeature2messageDeduplication() {
  describe('message deduplication', function () {
    beforeEach(function () {
      feature2messageDeduplicationMockWs = {
        _peerAddr: 'ws://peer:10001',
        send: sinon.stub()
      };
    });
    registerFeature2messageDeduplicationPart1();
  });
}
function registerFeature3verifySignaturePart1() {
  it('returns true for valid signature when REQUIRE_SIGNATURES is true', function () {
    rootSuitePm.requireSigs = true;
    let identity = new ValidatorIdentity(rootSuiteKeypair.privkeyHex);
    rootSuitePm.setValidatorPubkeys(new Map([['ws://peer:10001', rootSuiteKeypair.pubkeyHex]]));
    let env = {
      id: 'msg-1',
      type: 'TEST',
      sender: 'ws://peer:10001',
      timestamp: Date.now(),
      data: {
        x: 1
      }
    };
    env.sig = identity.signEnvelope(env);
    expect(rootSuitePm.verifySignature(env)).to.be.true;
  });
  it('returns false for invalid signature when REQUIRE_SIGNATURES is true', function () {
    rootSuitePm.requireSigs = true;
    rootSuitePm.setValidatorPubkeys(new Map([['ws://peer:10001', rootSuiteKeypair.pubkeyHex]]));
    let env = {
      id: 'msg-1',
      type: 'TEST',
      sender: 'ws://peer:10001',
      timestamp: Date.now(),
      data: {},
      sig: 'aa'.repeat(64)
    };
    expect(rootSuitePm.verifySignature(env)).to.be.false;
  });
  it('returns true when REQUIRE_SIGNATURES is false (no sig)', function () {
    rootSuitePm.requireSigs = false;
    let env = {
      id: 'msg-1',
      type: 'TEST',
      sender: 'ws://peer:10001',
      timestamp: Date.now(),
      data: {}
    };
    expect(rootSuitePm.verifySignature(env)).to.be.true;
  });
  it('rejects when signatures are required but missing', function () {
    rootSuitePm.requireSigs = true;
    expect(rootSuitePm.verifySignature({
      sender: 'x'
    })).to.be.false;
  });
}
function registerFeature3verifySignaturePart2() {
  it('rejects a signed message when the validator registry is null (fail closed)', function () {
    // A null registry means no sender can be authenticated, so a signed
    // envelope must be rejected, not trusted; accepting here would let
    // any self-signed message through while the registry is unloaded.
    rootSuitePm.requireSigs = true;
    rootSuitePm.validatorPubkeys = null;
    expect(rootSuitePm.verifySignature({
      sender: 'x',
      sig: 'aa'
    })).to.be.false;
  });
  it('null registry still accepts when signatures are not required', function () {
    rootSuitePm.requireSigs = false;
    rootSuitePm.validatorPubkeys = null;
    expect(rootSuitePm.verifySignature({
      sender: 'x',
      sig: 'aa'
    })).to.be.true;
  });
  it('defers to the requireSigs policy for an unknown sender', function () {
    rootSuitePm.setValidatorPubkeys(new Map([['known', 'pk']]));
    rootSuitePm.requireSigs = true;
    expect(rootSuitePm.verifySignature({
      sender: 'unknown',
      sig: 'aa'
    })).to.be.false;
    rootSuitePm.requireSigs = false;
    expect(rootSuitePm.verifySignature({
      sender: 'unknown',
      sig: 'aa'
    })).to.be.true;
  });
}
function registerFeature3verifySignature() {
  describe('verifySignature()', function () {
    registerFeature3verifySignaturePart1();
    registerFeature3verifySignaturePart2();
  });
}
let feature4verifySignatureOptionAIdentity;
// Build a signed Option-A envelope (sig_pubkey carried) from `identity`.
function feature4verifySignatureOptionASignedEnv(id) {
  let env = {
    id: id || 'oa-1',
    type: 'TEST',
    sender: 'ws://peer:10001',
    timestamp: Date.now(),
    data: {
      x: 1
    },
    sig_pubkey: rootSuiteKeypair.pubkeyHex
  };
  env.sig = feature4verifySignatureOptionAIdentity.signEnvelope(env);
  return env;
}
function registerFeature4verifySignatureOptionAPart1() {
  it('accepts when sig_pubkey is in the chain-effective signer set', function () {
    rootSuitePm.setEffectiveSignerSet(new Set([rootSuiteKeypair.pubkeyHex.toLowerCase()]));
    // Registry is empty; admission must come purely from the effective set.
    rootSuitePm.setValidatorPubkeys(new Map());
    expect(rootSuitePm.verifySignature(feature4verifySignatureOptionASignedEnv())).to.be.true;
  });
  it('accepts when sig_pubkey is in the registry pubkey set (addr-independent)', function () {
    // Registry maps a DIFFERENT addr to this pubkey; membership is by
    // pubkey value, not by envelope.sender.
    rootSuitePm.setValidatorPubkeys(new Map([['ws://other-addr:9', rootSuiteKeypair.pubkeyHex]]));
    rootSuitePm.setEffectiveSignerSet(null);
    expect(rootSuitePm.verifySignature(feature4verifySignatureOptionASignedEnv())).to.be.true;
  });
  it('rejects (sigs required) when sig_pubkey is in neither set', function () {
    rootSuitePm.setValidatorPubkeys(new Map());
    rootSuitePm.setEffectiveSignerSet(new Set(['deadbeef'.repeat(8)]));
    expect(rootSuitePm.verifySignature(feature4verifySignatureOptionASignedEnv())).to.be.false;
  });
  it('rejects a bad signature even for a member key', function () {
    rootSuitePm.setEffectiveSignerSet(new Set([rootSuiteKeypair.pubkeyHex.toLowerCase()]));
    let env = feature4verifySignatureOptionASignedEnv();
    env.sig = 'aa'.repeat(64); // corrupt
    expect(rootSuitePm.verifySignature(env)).to.be.false;
  });
  it('checks membership BEFORE running the Ed25519 verify (DoS guard)', function () {
    let verifySpy = sinon.spy(ValidatorIdentity, 'verify');
    rootSuitePm.setValidatorPubkeys(new Map());
    rootSuitePm.setEffectiveSignerSet(new Set()); // not a member
    expect(rootSuitePm.verifySignature(feature4verifySignatureOptionASignedEnv())).to.be.false;
    expect(verifySpy.called).to.be.false; // never reached verify
  });
  it('rejects a denylisted pubkey before verify, even if otherwise a member', function () {
    let pk = rootSuiteKeypair.pubkeyHex.toLowerCase();
    rootSuitePm.denyPubkeys = new Set([pk]);
    rootSuitePm.setEffectiveSignerSet(new Set([pk])); // in the set...
    rootSuitePm.setValidatorPubkeys(new Map([['a', rootSuiteKeypair.pubkeyHex]])); // ...and registry
    let verifySpy = sinon.spy(ValidatorIdentity, 'verify');
    expect(rootSuitePm.verifySignature(feature4verifySignatureOptionASignedEnv())).to.be.false;
    expect(verifySpy.called).to.be.false; // denylist short-circuits before verify
  });
  it('backward-compat: a pre-A envelope (no sig_pubkey) still uses the addr→pubkey map', function () {
    let env = {
      id: 'bc-1',
      type: 'TEST',
      sender: 'ws://peer:10001',
      timestamp: Date.now(),
      data: {}
    };
    env.sig = feature4verifySignatureOptionAIdentity.signEnvelope(env); // signed without sig_pubkey in canonical
    rootSuitePm.setValidatorPubkeys(new Map([['ws://peer:10001', rootSuiteKeypair.pubkeyHex]]));
    rootSuitePm.setEffectiveSignerSet(null);
    expect(rootSuitePm.verifySignature(env)).to.be.true;
  });
}
function registerFeature4verifySignatureOptionA() {
  describe('verifySignature(): Option A', function () {
    beforeEach(function () {
      rootSuitePm.requireSigs = true;
      feature4verifySignatureOptionAIdentity = new ValidatorIdentity(rootSuiteKeypair.privkeyHex);
    });

    // Build a signed Option-A envelope (sig_pubkey carried) from `identity`.
    registerFeature4verifySignatureOptionAPart1();
  });
}
describe('PeerManager', function () {
  beforeEach(function () {
    rootSuiteKeypair = ValidatorIdentity.generate();
    rootSuiteConfig = {
      P2P_VALIDATOR_ADDR: 'ws://self:10001',
      P2P_PORT: 0,
      // Don't bind
      P2P_HOST: '127.0.0.1',
      SEED_NODES: [],
      REQUIRE_SIGNATURES: false,
      P2P_MSG_DEDUP_TTL: 60000,
      P2P_MAX_PAYLOAD: 1048576,
      P2P_HEARTBEAT_INTERVAL: 15000,
      P2P_RECONNECT_BASE: 2000,
      P2P_RECONNECT_MAX: 60000
    };
    // DB_METHODS gives the double the real named query methods (setP2pPeer
    // among them), each routing through the doQuery stub the tests assert on.
    rootSuiteDbStub = {
      ...DB_METHODS,
      doQuery: sinon.stub().resolves([])
    };
    rootSuitePm = new PeerManager(rootSuiteConfig, rootSuiteDbStub);
  });
  afterEach(function () {
    sinon.restore();
  });

  // -----------------------------------------------------------------
  // buildEnvelope()
  // -----------------------------------------------------------------
  registerFeature1buildEnvelope();
  registerFeature2messageDeduplication();
  registerFeature3verifySignature();
  registerFeature4verifySignatureOptionA();
});
