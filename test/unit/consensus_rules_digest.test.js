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

    it('is sorted, has 33 entries, and contains the gates the last three trains append', function () {
        const keys = crd.knownGateKeys();
        expect(keys).to.have.lengthOf(33, 'SHARED_GATES total entry count moved; re-derive this floor before changing it');
        expect(keys).to.deep.equal([...keys].sort());
        expect(keys).to.include.members([
            'attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION',
            'attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2',
            'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION',
            // The time-keyed mirror barrier family and its anchor-attest member. THIS hub
            // evaluates all of them (the follower admission bound, the producer era gate and
            // the admission stamp it signs), which is why they are shared gates at all.
            'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION',
            'mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION',
            'mirror_admission_activation.ADMIT_MARGIN_BLOCKS',
            'mirror_admission_activation.ADMIT_MIN_FUTURE_BLOCKS',
            'mirror_admission_activation.ADMIT_MAX_FUTURE_BLOCKS',
            'anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION',
            'anchor_reward_activation.ANCHOR_ATTEST_ARRIVAL_MARGIN_S',
            // The admission canonical encoder and its era gate. The price rail made the
            // encoder a cross-repo byte-twin, so an upgraded hub signing the admission
            // field must read as a rules mismatch against peers that cannot rebuild it.
            'mirror_admission_activation.CHAIN_CODE_RE',
            'mirror_admission_activation.CANONICAL_HEIGHT_RE',
            'mirror_admission_activation.encodeAdmitBlocks',
            'mirror_admission_activation.decodeAdmitBlocks',
            'mirror_admission_activation.isAdmissionEra',
            'mirror_admission_activation.admissionCanonicalField'
        ]);
    });

    // The deploy-wave alarm, pinned to a value rather than only to itself. Cross-repo
    // equality alone cannot see a move both repos make together, which is exactly what a
    // one-train edit to a shared gate looks like, and the digest an un-upgraded peer
    // advertises is a literal on the wire. Re-derive with
    // `node -e "console.log(require('./src/consensus_rules_digest.js').computeConsensusRulesDigest().digest)"`
    // whenever a gate is deliberately added, and change it in the indexer suite in the SAME
    // edit: the two values are one number.
    //
    // Computed with the regtest admission arming CLEARED, because that one gate resolves from
    // the environment: a venue process launched armed has a different, equally correct digest,
    // and a pin that moved with a drill lever would be a test of the launcher. The pinned value
    // is the fleet's: every shipped process reads the unarmed maps.
    it('digests to the pinned value, which moved when the admission encoder was registered', function () {
        // Every gate module, not just the admission one: the family's arming lever is shared,
        // so the anchor-attest gate resolves from the same variable and a cached copy of it
        // would keep a drill's heights in the digest after the variable was cleared.
        const paths = [require.resolve('../../src/consensus_rules_digest.js')].concat(
            [...new Set(crd.SHARED_GATES.map(g => g[0]))].map(m => require.resolve('../../src/' + m + '.js')));
        const saved = paths.map(p => [p, require.cache[p]]);
        const env   = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        try {
            delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            for (const [p] of saved) delete require.cache[p];
            const fresh = require('../../src/consensus_rules_digest.js');
            expect(fresh.computeConsensusRulesDigest().digest)
                .to.equal('26ba9cce1936d6c38518489b35e3ceb558746ffb466cea90f65b39adf49b2036',
                    'the consensus rules digest moved; a gate was added, removed or reordered');
        } finally {
            for (const [p, mod] of saved) { if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod; }
            if (env === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = env;
        }
    });

    // The append is at the END, and this is what "at the end" has to mean operationally: the
    // preimage of every gate that was already registered is byte-for-byte where it was, so an
    // old build and a new build disagree ONLY about the rows the new build added. An insertion
    // mid-list would leave every later gate in a different preimage position and the digest
    // would move for reasons no operator could attribute to a gate.
    it('appends the family at the END, leaving the pre-existing gate order untouched', function () {
        const PRE_EXISTING = [
            'anchor_reward_activation', 'attest_relay_activation', 'checkpoint_commitment_activation',
            'cross_chain_royalty_activation', 'equivocation_header', 'price_pair_activation',
            'price_sig_tally_activation', 'retraction_signing_activation', 'rollcall_activation',
            'snapshot_reorg_buffer', 'stake_weighted_quorum', 'attest_responsible_widening_activation',
            'attest_response_mirror_activation', 'attest_zero_conf_activation',
            'attest_responsible_widening_activation', 'rollcall_gates_activation',
            // Landed by the bridge train while this one was in flight. Two trains appended to
            // one order-significant registry; this one lands SECOND, so the bridge gate is
            // pre-existing from here and the family sits after it, not before.
            'xchain_bridge_activation'
        ];
        const mods = crd.SHARED_GATES.map(g => g[0]);
        expect(mods.slice(0, PRE_EXISTING.length),
            'a SHARED_GATES entry was inserted mid-list; that reorders the preimage of every gate after it')
            .to.deep.equal(PRE_EXISTING);
        expect(mods.slice(PRE_EXISTING.length), 'the family must be the LAST three entries, the encoder registration last of all')
            .to.deep.equal(['mirror_admission_activation', 'anchor_reward_activation', 'mirror_admission_activation']);
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

    // XCHAIN_BRIDGE_ACTIVATION is the first COIN-KEYED gate in SHARED_GATES: '<COIN>:<network>'
    // with the bare network key as fallback, because one testnet height cannot serve TBTC, TLTC
    // and TDOGE. Both resolutions are load-bearing here: the hub signs a leg against the chain
    // it was mined on, and the capability set it receives was filtered from a height alone.
    it('resolves the coin-keyed bridge gate per coin, and network-wide from the earliest armed chain', function () {
        const KEY = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
        expect(crd.knownGateKeys()).to.include(KEY);
        // As shipped: regtest 0 on every chain, every other slot on the far-future sentinel.
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            expect(crd.activeGatesAt(0, 'regtest', coin)).to.include(KEY);
            expect(crd.activeGatesAt(crd.FAR_FUTURE_HEIGHT_SENTINEL, 'testnet', coin)).to.not.include(KEY);
        }
        const GATE    = require.resolve('../../src/xchain_bridge_activation.js');
        const CRD     = require.resolve('../../src/consensus_rules_digest.js');
        const real    = require.cache[GATE];
        const realCrd = require.cache[CRD];
        try {
            const stub = Object.create(Object.getPrototypeOf(real));
            Object.assign(stub, real);
            stub.exports = Object.assign({}, real.exports, {
                XCHAIN_BRIDGE_ACTIVATION: {
                    'BTC:testnet':  100,
                    'DOGE:testnet': 5000000,
                    testnet:        crd.FAR_FUTURE_HEIGHT_SENTINEL,
                    regtest:        0,
                },
            });
            require.cache[GATE] = stub;
            delete require.cache[CRD];
            const fresh = require('../../src/consensus_rules_digest.js');
            expect(fresh.activeGatesAt(150, 'testnet', 'BTC')).to.include(KEY);
            expect(fresh.activeGatesAt(150, 'testnet', 'DOGE')).to.not.include(KEY);
            expect(fresh.activeGatesAt(5000000, 'testnet', 'DOGE')).to.include(KEY);
            expect(fresh.activeGatesAt(99, 'testnet', 'BTC')).to.not.include(KEY);
            // The bare testnet key is still the sentinel, so resolving it alone would hide an
            // armed chain from every caller that has only a height and a network.
            expect(fresh.activeGatesAt(150, 'testnet')).to.include(KEY);
            expect(fresh.activeGatesAt(99, 'testnet')).to.not.include(KEY);
        } finally {
            require.cache[GATE] = real;
            require.cache[CRD]  = realCrd;
        }
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
