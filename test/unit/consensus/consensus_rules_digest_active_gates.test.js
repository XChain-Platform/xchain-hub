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

// The digest reads every gate VALUE from the registry, so a case that needs one map to
// read differently swaps the registry's cached module for one whose get() answers that
// key with `table`; the carriers themselves are never touched. Returns the restorer.
function stubRegistryRow(key, table) {
    const REG  = require.resolve('../../../src/consensus/gate_registry.js');
    const real = require.cache[REG];
    const stub = Object.create(Object.getPrototypeOf(real));
    Object.assign(stub, real);
    stub.exports = Object.assign({}, real.exports, {
        get: (k) => (k === key ? Object.freeze(Object.assign({}, table)) : real.exports.get(k)),
    });
    require.cache[REG] = stub;
    return () => { require.cache[REG] = real; };
}
// The zero-confirmation flip's three appended SHARED_GATES rows (§8), plus the two
// helpers a ROLLCALL v1 publisher and the rules-aware capability set filter both read.
function registerGateInventoryTest() {
    it('is sorted, has 34 entries, and contains the gates the last three trains append', function () {
        const keys = crd.knownGateKeys();
        expect(keys).to.have.lengthOf(34, 'SHARED_GATES total entry count moved; re-derive this floor before changing it');
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
            'mirror_admission_activation.admissionCanonicalField',
            // The token leg gate this hub loads per bridge leg.
            'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION'
        ]);
    });
}

function registerPinnedDigestTest() {
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
    it('digests to the pinned value, which moved when the v0.19.0 cut armed the bridge on testnet (and again at the 16:33Z ladder re-cut, and again when LTC:testnet mirror admission shipped null under dq4 (a))', function () {
        // Every gate module that still has a logic file, not just the admission one: the
        // family's arming lever is shared, so the anchor-attest gate resolves from the same
        // variable and a cached copy of it would keep a drill's heights in the digest after
        // the variable was cleared. Since W5 the logic files sit at
        // src/consensus/gates/<stem>_gate.js and the retired predicate shims have none.
        const gatePath = (m) => path.resolve(__dirname, '../../../src/consensus/gates/' + m.replace(/_activation$/, '_gate') + '.js');
        const paths = [require.resolve('../../../src/consensus_rules_digest.js')].concat(
            [...new Set(crd.SHARED_GATES.map(g => g[0]))].map(gatePath).filter(p => fs.existsSync(p)));
        const saved = paths.map(p => [p, require.cache[p]]);
        const env   = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        try {
            delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            for (const [p] of saved) delete require.cache[p];
            const fresh = require('../../../src/consensus_rules_digest.js');
            expect(fresh.computeConsensusRulesDigest().digest)
                .to.equal('0b39313c90c49cdbf033e719448d389d2742795be78e17129bdd2925a84292df',
                    'the consensus rules digest moved; a gate was added, removed, reordered or re-armed');
        } finally {
            for (const [p, mod] of saved) { if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod; }
            if (env === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = env;
        }
    });
}

function registerGateOrderingTest() {
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
        expect(mods.slice(PRE_EXISTING.length),
            'the family must follow the bridge gate, the encoder registration last, then the token leg gate')
            .to.deep.equal(['mirror_admission_activation', 'anchor_reward_activation', 'mirror_admission_activation',
                'token_bridge_activation']);
    });
}

function registerSentinelGateTest() {
    // The 2026-09-09 genesis-arm ruling left no SHIPPED gate on the far-future sentinel,
    // so the exclusion branch is driven against a stubbed gate module instead of riding
    // whichever map happened to be unarmed. PRICE_PAIR_WIDEN_ACTIVATION, the last live
    // example before the arm, is the map stubbed here.
    it('excludes a far-future sentinel height, however high the chain climbs', function () {
        const CRD     = require.resolve('../../../src/consensus_rules_digest.js');
        const realCrd = require.cache[CRD];
        const restore = stubRegistryRow('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION',
            { mainnet: crd.FAR_FUTURE_HEIGHT_SENTINEL, testnet: 0, regtest: 0 });
        try {
            delete require.cache[CRD];                       // clears the module-level value cache
            const fresh = require('../../../src/consensus_rules_digest.js');
            expect(fresh.activeGatesAt(fresh.FAR_FUTURE_HEIGHT_SENTINEL, 'mainnet'))
                .to.not.include('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION');
            // The same stub is active on testnet, so the exclusion is the sentinel, not the stub.
            expect(fresh.activeGatesAt(0, 'testnet'))
                .to.include('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION');
        } finally {
            restore();
            require.cache[CRD]  = realCrd;
        }
    });
}

function registerActiveGateBasics() {
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
}

function registerCoinKeyedGateTest() {
    // XCHAIN_BRIDGE_ACTIVATION is the first COIN-KEYED gate in SHARED_GATES: '<COIN>:<network>'
    // with the bare network key as fallback, because one testnet height cannot serve TBTC, TLTC
    // and TDOGE. Both resolutions are load-bearing here: the hub signs a leg against the chain
    // it was mined on, and the capability set it receives was filtered from a height alone.
    it('resolves the coin-keyed bridge gate per coin, and network-wide from the earliest armed chain', function () {
        const KEY = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
        expect(crd.knownGateKeys()).to.include(KEY);
        // As shipped since the v0.19.0 cut: regtest 0 on every chain, mainnet on the far-future
        // sentinel, and one sized testnet height per chain read from the map itself so this
        // grades the resolver against whatever the train wrote.
        const shipped = JSON.parse(crd.computeConsensusRulesDigest().gates[KEY]);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            expect(crd.activeGatesAt(0, 'regtest', coin)).to.include(KEY);
            expect(crd.activeGatesAt(crd.FAR_FUTURE_HEIGHT_SENTINEL, 'mainnet', coin)).to.not.include(KEY);
            const h = shipped[coin + ':testnet'];
            expect(h, coin + ':testnet is a sized height').to.be.a('number').below(crd.FAR_FUTURE_HEIGHT_SENTINEL);
            expect(crd.activeGatesAt(h - 1, 'testnet', coin)).to.not.include(KEY);
            expect(crd.activeGatesAt(h, 'testnet', coin)).to.include(KEY);
        }
        const CRD     = require.resolve('../../../src/consensus_rules_digest.js');
        const realCrd = require.cache[CRD];
        const restore = stubRegistryRow(KEY, {
            'BTC:testnet':  100,
            'DOGE:testnet': 5000000,
            testnet:        crd.FAR_FUTURE_HEIGHT_SENTINEL,
            regtest:        0,
        });
        try {
            delete require.cache[CRD];
            const fresh = require('../../../src/consensus_rules_digest.js');
            expect(fresh.activeGatesAt(150, 'testnet', 'BTC')).to.include(KEY);
            expect(fresh.activeGatesAt(150, 'testnet', 'DOGE')).to.not.include(KEY);
            expect(fresh.activeGatesAt(5000000, 'testnet', 'DOGE')).to.include(KEY);
            expect(fresh.activeGatesAt(99, 'testnet', 'BTC')).to.not.include(KEY);
            // The bare testnet key is still the sentinel, so resolving it alone would hide an
            // armed chain from every caller that has only a height and a network.
            expect(fresh.activeGatesAt(150, 'testnet')).to.include(KEY);
            expect(fresh.activeGatesAt(99, 'testnet')).to.not.include(KEY);
        } finally {
            restore();
            require.cache[CRD]  = realCrd;
        }
    });
}

describe('consensus_rules_digest: knownGateKeys() and activeGatesAt() (D88)', function () {
    registerGateInventoryTest();
    registerPinnedDigestTest();
    registerGateOrderingTest();
    registerSentinelGateTest();
    registerActiveGateBasics();
    registerCoinKeyedGateTest();
});
