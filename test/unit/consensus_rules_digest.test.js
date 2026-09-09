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
const crd  = require('../../src/consensus_rules_digest.js');
const PeerManager = require('../../src/PeerManager.js');
const ValidatorIdentity = require('../../src/ValidatorIdentity.js');

const INDEXER_COPY = path.resolve(__dirname, '../../../xchain-indexer/src/consensus_rules_digest.js');

describe('consensus_rules_digest: the digest', function () {

    it('covers every shared gate and is stable across calls', function () {
        const a = crd.computeConsensusRulesDigest();
        const b = crd.computeConsensusRulesDigest();
        expect(a.digest).to.match(/^[0-9a-f]{64}$/);
        expect(a.digest).to.equal(b.digest);
        const expected = crd.SHARED_GATES.reduce((n, g) => n + g[1].length, 0);
        expect(Object.keys(a.gates)).to.have.lengthOf(expected);
    });

    it('resolves every shared gate in THIS repo (none absent)', function () {
        const { gates } = crd.computeConsensusRulesDigest();
        const absent = Object.keys(gates).filter(k => gates[k] === crd.ABSENT);
        expect(absent, 'gates this repo cannot resolve: ' + absent.join(', ')).to.deep.equal([]);
    });

    // The property the whole feature rests on: a hub and an indexer share no source
    // file, so only a VALUE-based digest can be compared between them.
    it('matches the indexer copy exactly, across two repos with no shared file', function () {
        if (!fs.existsSync(INDEXER_COPY)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('xchain-indexer sibling checkout missing: ' + INDEXER_COPY);
            this.skip();
            return;
        }
        const idx = require(INDEXER_COPY);
        const mine = crd.computeConsensusRulesDigest();
        const theirs = idx.computeConsensusRulesDigest();
        expect(crd.diffGates(mine.gates, theirs.gates),
            'gates that disagree between hub and indexer').to.deep.equal([]);
        expect(theirs.digest).to.equal(mine.digest);
    });

    it('is insensitive to key order but sensitive to a changed height', function () {
        const a = crd.canonical({ mainnet: null, testnet: 0, regtest: 0 });
        const b = crd.canonical({ regtest: 0, mainnet: null, testnet: 0 });
        expect(a).to.equal(b);
        expect(crd.canonical({ mainnet: null, testnet: 1 })).to.not.equal(crd.canonical({ mainnet: null, testnet: 0 }));
    });

    it('reports a dropped gate as a difference rather than hiding it', function () {
        const full = { 'a.A': '1', 'b.B': '2' };
        const short = { 'a.A': '1' };
        expect(crd.diffGates(full, short)).to.deep.equal(['b.B']);
        expect(crd.diffGates(short, full)).to.deep.equal(['b.B']);
        expect(crd.diffGates(full, full)).to.deep.equal([]);
    });
});

// The zero-confirmation flip's three appended SHARED_GATES rows (§8), plus the two
// helpers a ROLLCALL v1 publisher and the rules-aware capability set filter both read.
describe('consensus_rules_digest: knownGateKeys() and activeGatesAt() (D88)', function () {

    it('is sorted, has 19 entries, and contains the three gates this train appends', function () {
        const keys = crd.knownGateKeys();
        expect(keys).to.have.lengthOf(19, 'SHARED_GATES total entry count moved; re-derive this floor before changing it');
        expect(keys).to.deep.equal([...keys].sort());
        expect(keys).to.include.members([
            'attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION',
            'attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2',
            'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION'
        ]);
    });

    // The 2026-09-09 genesis-arm ruling left no SHIPPED gate on the far-future sentinel,
    // so the exclusion branch is driven against a stubbed gate module instead of riding
    // whichever map happened to be unarmed. PRICE_PAIR_WIDEN_ACTIVATION, the last live
    // example before the arm, is the map stubbed here.
    it('excludes a far-future sentinel height, however high the chain climbs', function () {
        const GATE    = require.resolve('../../src/price_pair_activation.js');
        const CRD     = require.resolve('../../src/consensus_rules_digest.js');
        const real    = require.cache[GATE];
        const realCrd = require.cache[CRD];
        try {
            const stub = Object.create(Object.getPrototypeOf(real));
            Object.assign(stub, real);
            stub.exports = Object.assign({}, real.exports, {
                PRICE_PAIR_WIDEN_ACTIVATION: { mainnet: crd.FAR_FUTURE_HEIGHT_SENTINEL, testnet: 0, regtest: 0 },
            });
            require.cache[GATE] = stub;
            delete require.cache[CRD];                       // clears the module-level value cache
            const fresh = require('../../src/consensus_rules_digest.js');
            expect(fresh.activeGatesAt(fresh.FAR_FUTURE_HEIGHT_SENTINEL, 'mainnet'))
                .to.not.include('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION');
            // The same stub is active on testnet, so the exclusion is the sentinel, not the stub.
            expect(fresh.activeGatesAt(0, 'testnet'))
                .to.include('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION');
        } finally {
            require.cache[GATE] = real;
            require.cache[CRD]  = realCrd;
        }
    });

    it('includes the gates this wave armed at genesis on mainnet, from block 0', function () {
        // The 2026-09-09 ruling: identity on the indexed mainnet history.
        expect(crd.activeGatesAt(0, 'mainnet')).to.include.members([
            'price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION',
            'snapshot_reorg_buffer.SNAPSHOT_BURIAL_ACTIVATION',
        ]);
    });

    it('excludes a null (unratified) entry at any height', function () {
        // ATTEST_ZERO_CONF_ACTIVATION.mainnet is null (unratified) today.
        for (const h of [0, 1000000, crd.FAR_FUTURE_HEIGHT_SENTINEL - 1]) {
            expect(crd.activeGatesAt(h, 'mainnet')).to.not.include('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION');
        }
    });

    it('excludes non-map exports (frozen ladder constants), never active in this sense', function () {
        for (const h of [0, 150780, 999999999]) {
            for (const net of ['mainnet', 'testnet', 'regtest']) {
                const at = crd.activeGatesAt(h, net);
                expect(at).to.not.include('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING');
                expect(at).to.not.include('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2');
            }
        }
    });

    it('includes a gate exactly at its own activation height (<=, not <)', function () {
        // regtest arms ATTEST_ZERO_CONF_ACTIVATION at 0.
        expect(crd.activeGatesAt(0, 'regtest')).to.include('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION');
    });

    it('returns [] for a non-finite height', function () {
        expect(crd.activeGatesAt(NaN, 'regtest')).to.deep.equal([]);
        expect(crd.activeGatesAt(undefined, 'regtest')).to.deep.equal([]);
        expect(crd.activeGatesAt(Infinity, 'regtest')).to.deep.equal([]);
    });
});

describe('consensus_rules_digest: the heartbeat alarms', function () {

    // A PeerManager with no sockets: _notePeerRules and the report are pure over
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

    function heartbeat(sender, rules, version) {
        return { type: 'HEARTBEAT', sender, data: { version: version || '0.12.3', rules } };
    }

    let warnings;
    beforeEach(function () {
        warnings = [];
        this._warn = console.warn;
        console.warn = (m) => warnings.push(String(m));
    });
    afterEach(function () { console.warn = this._warn; });

    it('says nothing when a peer agrees', function () {
        const pm = makePeerManager();
        pm._notePeerRules(heartbeat('v1', MINE()));
        expect(warnings).to.deep.equal([]);
        expect(pm.getConsensusRulesReport().agree).to.equal(1);
    });

    it('names a disagreeing peer', function () {
        const pm = makePeerManager();
        pm._notePeerRules(heartbeat('v1', OTHER));
        expect(warnings.join('\n')).to.match(/CONSENSUS-RULE MISMATCH with peer v1/);
        expect(pm.getConsensusRulesReport().disagree).to.equal(1);
    });

    // The message that actually gets a node upgraded.
    it('tells THIS hub it is the odd one out when the peers agree with each other', function () {
        const pm = makePeerManager();
        pm._notePeerRules(heartbeat('v1', OTHER));
        pm._notePeerRules(heartbeat('v2', OTHER));
        expect(warnings.join('\n')).to.match(/THIS HUB IS RUNNING CONSENSUS RULES THE FEDERATION DOES NOT SHARE/);
        expect(warnings.join('\n')).to.match(/UPGRADE THIS NODE/);
    });

    it('does NOT accuse this hub when it is in the majority', function () {
        const pm = makePeerManager();
        pm._notePeerRules(heartbeat('v1', MINE()));
        pm._notePeerRules(heartbeat('v2', MINE()));
        pm._notePeerRules(heartbeat('v3', OTHER));
        const joined = warnings.join('\n');
        expect(joined).to.match(/MISMATCH with peer v3/);
        expect(joined).to.not.match(/THIS HUB IS RUNNING/);
    });

    it('treats a pre-digest peer as unknown, not as a mismatch', function () {
        const pm = makePeerManager();
        pm._notePeerRules({ type: 'HEARTBEAT', sender: 'old', data: { version: '0.12.2' } });
        const joined = warnings.join('\n');
        expect(joined).to.match(/advertises no consensus-rules digest/);
        expect(joined).to.not.match(/MISMATCH/);
        const report = pm.getConsensusRulesReport();
        expect(report.unknown).to.equal(1);
        expect(report.disagree).to.equal(0);
    });

    it('rejects a malformed digest rather than trusting it', function () {
        const pm = makePeerManager();
        pm._notePeerRules(heartbeat('v1', 'not-a-digest'));
        expect(pm.peerRules.get('v1').digest).to.equal(null);
    });

    it('throttles so a standing mismatch cannot bury the log', function () {
        const pm = makePeerManager();
        for (let i = 0; i < 20; i++) pm._notePeerRules(heartbeat('v1', OTHER));
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
});
