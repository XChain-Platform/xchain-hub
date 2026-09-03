'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// ATTEST_RESPONSE_FORWARD_S and its regtest-only override seam
// (the ATTEST response mirror design, §4.2, decision D48).
//
// The seam is the only reason the regtest acceptance ladder is drivable at all
// (regtest blocks are stamped at about now, so at the frozen 120 no attestation
// row binds for two real minutes), and it is also the only place an operator can
// desynchronise a hub from its federation, because the resolved value is both
// stamped into signed bytes and bounds every peer's stamp. So it is
// driven three ways: honoured on regtest, loud on regtest garbage, inert with one
// warning everywhere else.

const { expect } = require('chai');
const sinon      = require('sinon');
const {
    ATTEST_RESPONSE_FORWARD_S,
    ATTEST_RESPONSE_FORWARD_S_OVERRIDE,
    resolveAttestResponseForwardS
} = require('../../src/lib/attest_response_timing.js');

describe('attest_response_timing: ATTEST_RESPONSE_FORWARD_S and its regtest seam', function () {

    let savedEnv;

    beforeEach(function () {
        savedEnv = process.env[ATTEST_RESPONSE_FORWARD_S_OVERRIDE];
        delete process.env[ATTEST_RESPONSE_FORWARD_S_OVERRIDE];
    });

    afterEach(function () {
        if (savedEnv === undefined) delete process.env[ATTEST_RESPONSE_FORWARD_S_OVERRIDE];
        else process.env[ATTEST_RESPONSE_FORWARD_S_OVERRIDE] = savedEnv;
        sinon.restore();
    });

    it('is the frozen protocol value of 120 seconds', function () {
        expect(ATTEST_RESPONSE_FORWARD_S).to.equal(120);
    });

    it('resolves to the protocol value on every network with no override set', function () {
        for (let net of ['mainnet', 'testnet', 'regtest', '', undefined])
            expect(resolveAttestResponseForwardS(net, {})).to.equal(120);
    });

    it('regtest honours a good override from p2pConfig and from the environment', function () {
        expect(resolveAttestResponseForwardS('regtest', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: 2 })).to.equal(2);
        expect(resolveAttestResponseForwardS('regtest', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: '0' })).to.equal(0);
        process.env[ATTEST_RESPONSE_FORWARD_S_OVERRIDE] = '5';
        expect(resolveAttestResponseForwardS('regtest', {})).to.equal(5);
        // p2pConfig wins: several hubs share one process in the e2e harness.
        expect(resolveAttestResponseForwardS('regtest', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: 7 })).to.equal(7);
    });

    it('regtest THROWS an actionable error on a value that is not a non-negative integer', function () {
        for (let bad of ['abc', '-1', '2.5', '12abc', 'NaN']) {
            let call = () => resolveAttestResponseForwardS('regtest', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: bad });
            expect(call, 'expected ' + JSON.stringify(bad) + ' to throw').to.throw(/is not a non-negative integer/);
            // Actionable: the message has to name the key and the fallback value,
            // or an operator reading a crashed hub's log learns nothing.
            expect(call).to.throw(ATTEST_RESPONSE_FORWARD_S_OVERRIDE);
            expect(call).to.throw(String(ATTEST_RESPONSE_FORWARD_S));
        }
    });

    it('off regtest a differing override is IGNORED, with the warning latched once per process', function () {
        let logged = [];
        sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')));

        // First differing value on a live network: ignored, warned.
        expect(resolveAttestResponseForwardS('testnet', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: 2 })).to.equal(120);
        expect(logged.filter(l => l.indexOf(ATTEST_RESPONSE_FORWARD_S_OVERRIDE) !== -1)).to.have.lengthOf(1);
        expect(logged[0]).to.match(/IGNORED on testnet/);

        // Every later differing value: still ignored, and silent (the latch).
        expect(resolveAttestResponseForwardS('mainnet', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: 9 })).to.equal(120);
        expect(resolveAttestResponseForwardS('', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: 'garbage' })).to.equal(120);
        expect(logged.filter(l => l.indexOf(ATTEST_RESPONSE_FORWARD_S_OVERRIDE) !== -1)).to.have.lengthOf(1);
    });

    it('off regtest, garbage is ignored rather than thrown: the value is inert there', function () {
        expect(resolveAttestResponseForwardS('mainnet', { [ATTEST_RESPONSE_FORWARD_S_OVERRIDE]: 'abc' })).to.equal(120);
    });
});
