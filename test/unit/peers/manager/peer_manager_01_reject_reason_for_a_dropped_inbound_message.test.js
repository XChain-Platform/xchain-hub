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
const ValidatorIdentity  = require('../../../../src/validators/identity');
const PeerManager        = require('../../../../src/peers/manager');
const observability      = require('../../../../src/observability');
const { waitUntil }      = require('../../../helpers/waitUntil');
const { DB_METHODS }     = require('../../../helpers/mockHub');

let rootSuiteConfig, rootSuiteDbStub, rootSuitePm, rootSuiteKeypair;
let feature5rejectReasonForADroppedInboundMessageIdentity, feature5rejectReasonForADroppedInboundMessageMockWs, feature5rejectReasonForADroppedInboundMessageWarnings, feature5rejectReasonForADroppedInboundMessageSink;
function feature5rejectReasonForADroppedInboundMessageSignedRaw() {
  let env = {
    id: 'xc2016-' + Math.random(),
    type: 'TEST',
    sender: 'ws://peer:10001',
    timestamp: Date.now(),
    data: {
      x: 1
    },
    sig_pubkey: rootSuiteKeypair.pubkeyHex
  };
  env.sig = feature5rejectReasonForADroppedInboundMessageIdentity.signEnvelope(env);
  return env;
}
function feature5rejectReasonForADroppedInboundMessageRejects(reason) {
  return feature5rejectReasonForADroppedInboundMessageSink.lines.filter(l => l.includes('PEER_REJECT') && l.includes('reason=' + reason));
}
function registerFeature5rejectReasonForADroppedInboundMessagePart1() {
  it('names the signer set (not the signature) for a valid signature from a non-member', function () {
    rootSuitePm.setEffectiveSignerSet(new Set()); // staked by nobody: the joining-validator state
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    rootSuitePm.handleInbound(feature5rejectReasonForADroppedInboundMessageMockWs, JSON.stringify(feature5rejectReasonForADroppedInboundMessageSignedRaw()), null);
    expect(emitted, 'the message is still dropped').to.equal(0);
    expect(feature5rejectReasonForADroppedInboundMessageWarnings.join('\n')).to.match(/sender not in signer set \(no active stake or registry entry\)/);
    expect(feature5rejectReasonForADroppedInboundMessageWarnings.join('\n'), 'never blames the signature').to.not.match(/Invalid signature/);
    expect(feature5rejectReasonForADroppedInboundMessageRejects('not_in_signer_set'), 'records the membership reason').to.have.lengthOf(1);
    expect(feature5rejectReasonForADroppedInboundMessageRejects('invalid_signature')).to.have.lengthOf(0);
  });
  it('quotes the canonical stake activation delay in the non-member line', function () {
    rootSuitePm.setEffectiveSignerSet(new Set());
    rootSuitePm.handleInbound(feature5rejectReasonForADroppedInboundMessageMockWs, JSON.stringify(feature5rejectReasonForADroppedInboundMessageSignedRaw()), null);
    let blocks = PeerManager.stakeActivationBlocks('testnet');
    expect(blocks, 'the coins registry resolves the delay').to.be.a('number');
    expect(feature5rejectReasonForADroppedInboundMessageWarnings.join('\n')).to.include('a STAKE activates ' + blocks + ' blocks after the transaction confirms');
  });
  it('a member key with a bad signature still reports invalid_signature', function () {
    rootSuitePm.setEffectiveSignerSet(new Set([rootSuiteKeypair.pubkeyHex.toLowerCase()]));
    let env = feature5rejectReasonForADroppedInboundMessageSignedRaw();
    env.sig = 'aa'.repeat(64); // corrupt: membership passes, crypto fails

    rootSuitePm.handleInbound(feature5rejectReasonForADroppedInboundMessageMockWs, JSON.stringify(env), null);
    expect(feature5rejectReasonForADroppedInboundMessageWarnings.join('\n')).to.match(/Invalid signature from ws:\/\/peer:10001/);
    expect(feature5rejectReasonForADroppedInboundMessageWarnings.join('\n')).to.not.match(/not in signer set/);
    expect(feature5rejectReasonForADroppedInboundMessageRejects('invalid_signature')).to.have.lengthOf(1);
    expect(feature5rejectReasonForADroppedInboundMessageRejects('not_in_signer_set')).to.have.lengthOf(0);
  });
  it('a pre-A envelope from a sender the registry does not know is a membership miss', function () {
    let env = {
      id: 'xc2016-preA',
      type: 'TEST',
      sender: 'ws://stranger:10001',
      timestamp: Date.now(),
      data: {}
    };
    env.sig = feature5rejectReasonForADroppedInboundMessageIdentity.signEnvelope(env); // no sig_pubkey: backward-compat path

    rootSuitePm.handleInbound(feature5rejectReasonForADroppedInboundMessageMockWs, JSON.stringify(env), null);
    expect(feature5rejectReasonForADroppedInboundMessageRejects('not_in_signer_set')).to.have.lengthOf(1);
    expect(feature5rejectReasonForADroppedInboundMessageRejects('invalid_signature')).to.have.lengthOf(0);
  });
  it('verifySignature keeps its boolean verdict and only annotates the out-param', function () {
    rootSuitePm.setEffectiveSignerSet(new Set());
    let outcome = {};
    expect(rootSuitePm.verifySignature(feature5rejectReasonForADroppedInboundMessageSignedRaw(), outcome), 'fail closed is unchanged').to.be.false;
    expect(outcome.reason).to.equal('not_in_signer_set');

    // Permissive mode is unchanged too: the reason is reported, the verdict is not.
    rootSuitePm.requireSigs = false;
    let permissive = {};
    expect(rootSuitePm.verifySignature(feature5rejectReasonForADroppedInboundMessageSignedRaw(), permissive)).to.be.true;
    expect(permissive.reason).to.equal('not_in_signer_set');
  });
}
function registerFeature5rejectReasonForADroppedInboundMessage() {
  describe('reject reason for a dropped inbound message', function () {
    beforeEach(function () {
      observability._resetObservability();
      feature5rejectReasonForADroppedInboundMessageSink = {
        lines: []
      };
      const push = m => feature5rejectReasonForADroppedInboundMessageSink.lines.push(m);
      observability.installObservability(null, {
        service: 'xchain-hub',
        env: {},
        console: {
          log: push,
          warn: push,
          error: push
        }
      });
      rootSuitePm.requireSigs = true;
      rootSuitePm.config.HUB_NETWORK = 'testnet';
      rootSuitePm.setValidatorPubkeys(new Map());
      feature5rejectReasonForADroppedInboundMessageIdentity = new ValidatorIdentity(rootSuiteKeypair.privkeyHex);
      feature5rejectReasonForADroppedInboundMessageMockWs = {
        _peerAddr: 'ws://peer:10001',
        _remoteIp: '203.0.113.9',
        send: sinon.stub()
      };

      // Observed through the logger, which is where the rejection line
      // goes now that PeerManager no longer calls console. The stub calls
      // through rather than swallowing, because the PEER_REJECT record
      // rides the same method and rejects() reads it off the sink.
      feature5rejectReasonForADroppedInboundMessageWarnings = [];
      const log = observability.getLogger();
      const through = log.warn.bind(log);
      sinon.stub(log, 'warn').callsFake((m, f) => {
        feature5rejectReasonForADroppedInboundMessageWarnings.push(String(m));
        return through(m, f);
      });
    });
    afterEach(function () {
      observability._resetObservability();
    });
    registerFeature5rejectReasonForADroppedInboundMessagePart1();
  });
}
function registerFeature6invalidJSONHandlingPart1() {
  it('does not crash on non-JSON message', function () {
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    expect(() => rootSuitePm.handleInbound(null, 'not json', 'ws://peer:10001')).to.not.throw();
    expect(emitted).to.equal(0);
  });
  it('does not crash on empty string', function () {
    expect(() => rootSuitePm.handleInbound(null, '', 'ws://peer:10001')).to.not.throw();
  });
}
function registerFeature6invalidJSONHandling() {
  describe('invalid JSON handling', function () {
    registerFeature6invalidJSONHandlingPart1();
  });
}
function registerFeature7broadcastPart1() {
  it('returns an envelope', function () {
    let result = rootSuitePm.broadcast('TEST', {
      val: 1
    });
    expect(result).to.have.property('id');
    expect(result.type).to.equal('TEST');
  });
}
function registerFeature7broadcast() {
  describe('broadcast()', function () {
    registerFeature7broadcastPart1();
  });
}
function registerFeature8getPeerStatusPart1() {
  it('returns empty array when no peers', function () {
    expect(rootSuitePm.getPeerStatus()).to.deep.equal([]);
  });
}
function registerFeature8getPeerStatus() {
  describe('getPeerStatus()', function () {
    registerFeature8getPeerStatusPart1();
  });
}
function registerFeature9setterMethodsPart1() {
  it('setIdentity stores identity', function () {
    let identity = new ValidatorIdentity(rootSuiteKeypair.privkeyHex);
    rootSuitePm.setIdentity(identity);
    expect(rootSuitePm.identity).to.equal(identity);
  });
  it('setValidatorPubkeys stores map', function () {
    let map = new Map([['addr1', 'pk1']]);
    rootSuitePm.setValidatorPubkeys(map);
    expect(rootSuitePm.validatorPubkeys).to.equal(map);
  });
}
function registerFeature9setterMethods() {
  describe('setter methods', function () {
    registerFeature9setterMethodsPart1();
  });
}
function registerFeature10broadcastSendToPeerOverPeersPart1() {
  it('broadcast sends only to OPEN peers', function () {
    let openWs = {
      readyState: 1,
      send: sinon.stub()
    };
    let closedWs = {
      readyState: 3,
      send: sinon.stub()
    };
    rootSuitePm.peers.set('a', {
      ws: openWs
    });
    rootSuitePm.peers.set('b', {
      ws: closedWs
    });
    rootSuitePm.broadcast('T', {
      x: 1
    });
    expect(openWs.send.calledOnce).to.be.true;
    expect(closedWs.send.called).to.be.false;
  });
  it('sendToPeer returns false for unknown/closed peers and true on success', function () {
    expect(rootSuitePm.sendToPeer('nope', 'T', {})).to.be.false;
    let ws = {
      readyState: 1,
      send: sinon.stub()
    };
    rootSuitePm.peers.set('a', {
      ws
    });
    expect(rootSuitePm.sendToPeer('a', 'T', {})).to.be.true;
    expect(ws.send.calledOnce).to.be.true;
  });
  it('_send reports a send error via the callback', function () {
    let ws = {
      readyState: 1,
      send: (data, cb) => cb(new Error('boom'))
    };
    expect(() => rootSuitePm._send(ws, '{}')).to.not.throw();
  });
}
function registerFeature10broadcastSendToPeerOverPeers() {
  describe('broadcast() / sendToPeer() over peers', function () {
    registerFeature10broadcastSendToPeerOverPeersPart1();
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
  registerFeature5rejectReasonForADroppedInboundMessage();
  registerFeature6invalidJSONHandling();
  registerFeature7broadcast();
  registerFeature8getPeerStatus();
  registerFeature9setterMethods();
  registerFeature10broadcastSendToPeerOverPeers();
});
