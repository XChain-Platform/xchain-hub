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

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');
const crd  = require('../../../src/consensus_rules_digest.js');
const PeerManager = require('../../../src/peers/manager.js');
const ValidatorIdentity = require('../../../src/validators/identity.js');

const INDEXER_COPY = path.resolve(__dirname, '../../../../xchain-indexer/src/consensus_rules_digest.js');
// A PeerManager with no sockets: notePeerRules and the report are pure over
// this.peerRules, so the alarm logic is drivable without a federation.
function makePeerManager() {
    const pm = Object.create(PeerManager.prototype);
    pm.config = { P2P_HEARTBEAT_INTERVAL: 15000 };
    pm.peerRules = new Map();
    pm._rulesWarnedAt = new Map();
    pm.rulesWarnIntervalMs = 30 * 60 * 1000;
    return pm;
}

const MINE = () => crd.computeConsensusRulesDigest().digest;
const OTHER = 'f'.repeat(64);
let warnings;

function heartbeat(sender, rules, version) {
    return { type: 'HEARTBEAT', sender, data: { version: version || '0.12.3', rules } };
}

function registerPeerRuleReportTests() {
    it('says nothing when a peer agrees', function () {
        const pm = makePeerManager();
        pm.notePeerRules(heartbeat('v1', MINE()));
        expect(warnings).to.deep.equal([]);
        expect(pm.getConsensusRulesReport().agree).to.equal(1);
    });

    it('names a disagreeing peer', function () {
        const pm = makePeerManager();
        pm.notePeerRules(heartbeat('v1', OTHER));
        expect(warnings.join('\n')).to.match(/CONSENSUS-RULE MISMATCH with peer v1/);
        expect(pm.getConsensusRulesReport().disagree).to.equal(1);
    });

    // The message that actually gets a node upgraded.
    it('tells THIS hub it is the odd one out when the peers agree with each other', function () {
        const pm = makePeerManager();
        pm.notePeerRules(heartbeat('v1', OTHER));
        pm.notePeerRules(heartbeat('v2', OTHER));
        expect(warnings.join('\n')).to.match(/THIS HUB IS RUNNING CONSENSUS RULES THE FEDERATION DOES NOT SHARE/);
        expect(warnings.join('\n')).to.match(/UPGRADE THIS NODE/);
    });

    it('does NOT accuse this hub when it is in the majority', function () {
        const pm = makePeerManager();
        pm.notePeerRules(heartbeat('v1', MINE()));
        pm.notePeerRules(heartbeat('v2', MINE()));
        pm.notePeerRules(heartbeat('v3', OTHER));
        const joined = warnings.join('\n');
        expect(joined).to.match(/MISMATCH with peer v3/);
        expect(joined).to.not.match(/THIS HUB IS RUNNING/);
    });
}

function registerPeerRuleCompatibilityTests() {
    it('treats a pre-digest peer as unknown, not as a mismatch', function () {
        const pm = makePeerManager();
        pm.notePeerRules({ type: 'HEARTBEAT', sender: 'old', data: { version: '0.12.2' } });
        const joined = warnings.join('\n');
        expect(joined).to.match(/advertises no consensus-rules digest/);
        expect(joined).to.not.match(/MISMATCH/);
        const report = pm.getConsensusRulesReport();
        expect(report.unknown).to.equal(1);
        expect(report.disagree).to.equal(0);
    });

    it('rejects a malformed digest rather than trusting it', function () {
        const pm = makePeerManager();
        pm.notePeerRules(heartbeat('v1', 'not-a-digest'));
        expect(pm.peerRules.get('v1').digest).to.equal(null);
    });

    it('throttles so a standing mismatch cannot bury the log', function () {
        const pm = makePeerManager();
        for (let i = 0; i < 20; i++) pm.notePeerRules(heartbeat('v1', OTHER));
        expect(warnings.filter(w => /MISMATCH with peer v1/.test(w))).to.have.lengthOf(1);
    });

    // Rolling-deploy safety: the signature preimage is a fixed field list that hashes
    // `data` verbatim, so a key added inside data stays covered by the signature and an
    // older verifier still validates a newer sender.
    it('keeps the added data key inside the signed preimage', function () {
        const withRules = { id: 'i', type: 'HEARTBEAT', sender: 's', timestamp: 1,
                            data: { version: '0.12.3', rules: MINE() }, sig_pubkey: 'p' };
        const without   = { id: 'i', type: 'HEARTBEAT', sender: 's', timestamp: 1,
                            data: { version: '0.12.3' }, sig_pubkey: 'p' };
        const a = ValidatorIdentity.getSignablePayload(withRules);
        const b = ValidatorIdentity.getSignablePayload(without);
        expect(a).to.not.equal(b);              // covered by the signature
        expect(a).to.contain('"rules"');
    });
}

describe('consensus_rules_digest: the heartbeat alarms', function () {
    beforeEach(function () {
        warnings = [];
        this._warn = console.warn;
        console.warn = (m) => warnings.push(String(m));
    });
    afterEach(function () { console.warn = this._warn; });

    registerPeerRuleReportTests();
    registerPeerRuleCompatibilityTests();
});
