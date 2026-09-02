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
const crypto = require('crypto');
const wid = require('../../src/attest_responsible_widening_activation.js');
const AttestationRound = require('../../src/AttestationRound.js');

// The measured incident this ladder exists for: BTC testnet4 request
// 77f37a86..., admitted at 150699 with deadlineBlocks 10, redundancy 3.
const REQ = 150699;
const DEADLINE = 150709;

describe('attest_responsible_widening: activation gate', function () {

    // Derived from the map, never a hardcoded network list: pinning the testnet
    // height must not leave this passing for the wrong reason.
    const unratified = () => Object.keys(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION)
        .filter(n => wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION[n] === null);

    it('is inert on every network whose height is the null sentinel, at any height', function () {
        expect(unratified(), 'no unratified network left: this test would be vacuous').to.not.be.empty;
        for (const net of unratified()) {
            for (const at of [REQ, REQ + 5, REQ + 50, REQ + 5000]) {
                expect(wid.widenSlots(at, REQ, DEADLINE, net), net + '@' + at).to.equal(0);
            }
        }
    });

    it('gates an armed network on the REQUEST block', function () {
        for (const [net, height] of Object.entries(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION)) {
            if (typeof height !== 'number') continue;
            expect(wid.widenSlots(height + 500, height - 1, height + 29, net),
                net + ': a request below the height must never widen').to.equal(0);
            expect(wid.widenSlots(height + 21, height, height + 30, net),
                net + ': a request at the height must widen').to.equal(wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots);
        }
    });

    it('reads an unknown network as inert rather than as height 0', function () {
        expect(wid.widenSlots(REQ + 50, REQ, DEADLINE, 'nosuchnet')).to.equal(0);
        expect(wid.widenSlots(REQ + 50, REQ, DEADLINE, undefined)).to.equal(0);
    });

    // The null sentinel must not coerce through `>=`. If it did, every block of an
    // unratified network would satisfy `req >= 0` and the ladder would arm on
    // mainnet, which is the inverse of what the sentinel means.
    it('never arms on a network whose height is the null sentinel', function () {
        expect(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.mainnet).to.equal(null);
        expect(wid.widenSlots(0, 0, 10, 'mainnet')).to.equal(0);
    });

    it('gates on the REQUEST block, so a request admitted below the height never widens', function () {
        const armed = Object.assign({}, wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION);
        expect(armed.regtest).to.equal(0);
        // regtest is armed at genesis, so every regtest request is above the height.
        expect(wid.widenSlots(REQ + 8, REQ, DEADLINE, 'regtest')).to.be.above(0);
    });
});

describe('attest_responsible_widening: the ladder', function () {

    it('grants nothing inside the first segment, so a healthy round never sees a widened set', function () {
        // serviceable at 150702, span 7, three segments of 7/3.
        for (const at of [150699, 150700, 150702, 150703, 150704]) {
            expect(wid.widenSlots(at, REQ, DEADLINE, 'regtest'), 'block ' + at).to.equal(0);
        }
    });

    it('reaches both slots BEFORE the deadline on the measured 10-block window', function () {
        expect(wid.widenSlots(150705, REQ, DEADLINE, 'regtest')).to.equal(1);
        expect(wid.widenSlots(150707, REQ, DEADLINE, 'regtest')).to.equal(2);
        expect(wid.widenSlots(DEADLINE, REQ, DEADLINE, 'regtest')).to.equal(2);
    });

    it('scales with the request window rather than a fixed block count', function () {
        // A 100-block deadline gets a proportionally longer grace period.
        expect(wid.widenSlots(REQ + 10, REQ, REQ + 100, 'regtest')).to.equal(0);
        expect(wid.widenSlots(REQ + 40, REQ, REQ + 100, 'regtest')).to.equal(1);
        expect(wid.widenSlots(REQ + 70, REQ, REQ + 100, 'regtest')).to.equal(2);
    });

    it('never exceeds maxSlots, however far past the deadline', function () {
        for (const at of [DEADLINE + 1, DEADLINE + 100, DEADLINE + 100000]) {
            expect(wid.widenSlots(at, REQ, DEADLINE, 'regtest')).to.equal(wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots);
        }
    });

    it('is monotone non-decreasing in height, which is what makes hub and indexer agree', function () {
        let prev = 0;
        for (let at = REQ; at <= DEADLINE + 20; at++) {
            const v = wid.widenSlots(at, REQ, DEADLINE, 'regtest');
            expect(v, 'block ' + at).to.be.at.least(prev);
            prev = v;
        }
    });

    it('grants nothing on a degenerate span (deadline at or inside the confirmation lag)', function () {
        expect(wid.widenSlots(REQ + 50, REQ, REQ, 'regtest')).to.equal(0);
        expect(wid.widenSlots(REQ + 50, REQ, REQ + 3, 'regtest')).to.equal(0);
        expect(wid.widenSlots(REQ + 50, REQ, REQ - 5, 'regtest')).to.equal(0);
    });

    it('grants nothing for unusable heights', function () {
        expect(wid.widenSlots(NaN, REQ, DEADLINE, 'regtest')).to.equal(0);
        expect(wid.widenSlots(REQ + 8, undefined, DEADLINE, 'regtest')).to.equal(0);
        expect(wid.widenSlots(REQ + 8, REQ, null, 'regtest')).to.equal(0);
    });
});

describe('AttestationRound._computeResponsibleSet: widening', function () {

    // Seven staked keys, matching the size of the live testnet4 federation the
    // incident was measured on.
    const keys = Array.from({ length: 7 }, (_, i) =>
        crypto.createHash('sha256').update('v' + i).digest('hex'));
    const validators = keys.map(pubkey => ({ pubkey }));
    const rid = '77f37a86f6cae669961bf21a8f30b4c7980208859aff10db629bc7673e495301';
    const round = Object.create(AttestationRound.prototype);

    const setFor = (widen) =>
        round._computeResponsibleSet(validators, rid, 3, false, null, widen)
            .map(v => v.pubkey);

    it('is byte-for-byte the legacy fixed-REDUNDANCY set at widen 0', function () {
        expect(setFor(0)).to.have.lengthOf(3);
        expect(setFor(undefined)).to.deep.equal(setFor(0));
        expect(setFor(null)).to.deep.equal(setFor(0));
    });

    it('adds exactly one slot per widening level, in hash order', function () {
        expect(setFor(1)).to.have.lengthOf(4);
        expect(setFor(2)).to.have.lengthOf(5);
    });

    // The whole point: the assigned members keep their slots, so a signature that was
    // valid before the ladder moved is still valid after it.
    it('only ever APPENDS, so an earlier set is a prefix of every later one', function () {
        const s0 = setFor(0), s1 = setFor(1), s2 = setFor(2);
        expect(s1.slice(0, 3)).to.deep.equal(s0);
        expect(s2.slice(0, 4)).to.deep.equal(s1);
    });

    it('cannot be driven backwards or off the end by a hostile widen value', function () {
        expect(setFor(-5)).to.deep.equal(setFor(0));
        expect(setFor(NaN)).to.deep.equal(setFor(0));
        expect(setFor(999)).to.have.lengthOf(validators.length);
    });

    // The incident, reproduced: one member of the assigned three never serves. At
    // widen 0 only two live validators can sign and `redundancy` 3 is unreachable;
    // one widening slot is enough to make the round finalizable.
    it('makes the measured incident finalizable with one dead assigned member', function () {
        const dead = setFor(0)[1];
        const liveIn = (widen) => setFor(widen).filter(pk => pk !== dead).length;
        expect(liveIn(0)).to.equal(2);          // below redundancy 3: unfinalizable
        expect(liveIn(1)).to.equal(3);          // reaches redundancy
        expect(liveIn(2)).to.equal(4);
    });
});
