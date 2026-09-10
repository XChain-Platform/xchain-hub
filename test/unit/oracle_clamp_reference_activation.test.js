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
//
// The per-network table the fleet flips the oracle clamp reference on, and the
// proof that a hub-only gate stays out of the shared rules digest.

const sinon      = require('sinon');
const { expect } = require('chai');
const ocr        = require('../../src/oracle_clamp_reference_activation.js');
const crd        = require('../../src/consensus_rules_digest.js');

const MODULE_BASENAME = 'oracle_clamp_reference_activation';

describe('oracle_clamp_reference_activation: the per-network table', function () {

    afterEach(function () { sinon.restore(); });

    it('reads off on unratified mainnet at every height', function () {
        expect(ocr.ORACLE_CLAMP_REFERENCE_ACTIVATION.mainnet).to.equal(null);
        // Without the explicit null test `blk >= null` coerces to `blk >= 0` and arms
        // the re-read on every block, the inverse of what the sentinel means.
        expect(ocr.isClampReferenceAlignActive(0, 'mainnet')).to.be.false;
        expect(ocr.isClampReferenceAlignActive(9999999, 'mainnet')).to.be.false;
    });

    it('reads on at genesis on regtest', function () {
        expect(ocr.ORACLE_CLAMP_REFERENCE_ACTIVATION.regtest).to.equal(0);
        expect(ocr.isClampReferenceAlignActive(0, 'regtest')).to.be.true;
        expect(ocr.isClampReferenceAlignActive(1, 'regtest')).to.be.true;
    });

    it('flips on testnet at the sized height and not one block earlier', function () {
        const armed = ocr.ORACLE_CLAMP_REFERENCE_ACTIVATION.testnet;
        expect(armed).to.equal(152400);
        expect(ocr.isClampReferenceAlignActive(152399, 'testnet')).to.be.false;
        expect(ocr.isClampReferenceAlignActive(152400, 'testnet')).to.be.true;
        expect(ocr.isClampReferenceAlignActive(152401, 'testnet')).to.be.true;
    });

    it('shares the v0.17.0 hub roll boundary with the leader-silence skip', function () {
        // One activation boundary for the whole roll, so the wave has one thing to
        // rehearse, watch and roll back rather than two.
        const lss = require('../../src/attest_leader_silence_skip_activation.js');
        expect(ocr.ORACLE_CLAMP_REFERENCE_ACTIVATION.testnet)
            .to.equal(lss.ATTEST_LEADER_SILENCE_SKIP_ACTIVATION.testnet);
    });

    it('reports an unknown network once and reads off for it', function () {
        const warn = sinon.stub(console, 'warn');
        // A network with no entry is a misconfiguration rather than a posture.
        const unknown = 'signet-' + Date.now();

        expect(ocr.isClampReferenceAlignActive(9999999, unknown)).to.be.false;
        expect(ocr.isClampReferenceAlignActive(9999999, unknown)).to.be.false;
        expect(ocr.isClampReferenceAlignActive(9999999, unknown)).to.be.false;

        const lines = warn.getCalls().map(c => String(c.args[0]))
            .filter(s => s.indexOf('no activation entry for network') !== -1);
        expect(lines, 'said once, not once per round').to.have.lengthOf(1);
        expect(lines[0]).to.contain(JSON.stringify(unknown));
    });

    it('reads off for an absent or unusable height', function () {
        expect(ocr.isClampReferenceAlignActive(undefined, 'regtest')).to.be.false;
        expect(ocr.isClampReferenceAlignActive(null, 'regtest')).to.be.false;
        expect(ocr.isClampReferenceAlignActive(NaN, 'regtest')).to.be.false;
        expect(ocr.isClampReferenceAlignActive('not-a-height', 'regtest')).to.be.false;
    });
});

describe('oracle_clamp_reference_activation: stays out of the shared rules digest', function () {

    // SHARED_GATES is the hub/indexer INTERSECTION. A hub-only entry would report
    // ABSENT on every indexer and turn a correct build into a permanent rules
    // mismatch, and would lengthen the ROLLCALL v1 GATES field, dropping every
    // validator whose last rolled call predates it.
    it('is absent from SHARED_GATES and from knownGateKeys()', function () {
        expect(crd.SHARED_GATES.map(g => g[0])).to.not.include(MODULE_BASENAME);
        expect(crd.knownGateKeys().filter(k => k.indexOf(MODULE_BASENAME) === 0)).to.deep.equal([]);
    });

    it('is absent from the published ROLLCALL GATES field', function () {
        // The field is knownGateKeys() joined, so the enumeration above is what a
        // rolled call publishes; assert the published string directly too.
        expect(crd.knownGateKeys().join(',')).to.not.contain(MODULE_BASENAME);
    });

    it('does not move the digest', function () {
        // The digest reads only SHARED_GATES modules, so it must be identical whether
        // or not this map exists. attest_leader_silence_skip_activation is the sibling
        // hub-only gate held to the same rule.
        const before = crd.computeConsensusRulesDigest();
        expect(Object.keys(before.gates).filter(k => k.indexOf(MODULE_BASENAME) === 0)).to.deep.equal([]);
        expect(crd.SHARED_GATES.map(g => g[0]))
            .to.not.include('attest_leader_silence_skip_activation');
    });
});
