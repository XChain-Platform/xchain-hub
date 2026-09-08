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
const zc  = require('../../src/attest_zero_conf_activation.js');
const AttestationRound = require('../../src/AttestationRound.js');

// The measured incident this ladder exists for: BTC testnet4 request
// 77f37a86..., admitted at 150699 with deadlineBlocks 10, redundancy 3.
const REQ = 150699;
const DEADLINE = 150709;

// Stage-1 (pre-zero-conf) heights: regtest arms ATTEST_ZERO_CONF_ACTIVATION at 0 (D91),
// so every regtest request now runs the V2 ladder below. Stage-1 numbers are asserted on
// testnet instead, at or above the widening height (150780) where zero-conf stays the
// null (unratified) sentinel, so widenSlots keeps taking the `if(zc.isZeroConfActive(...))`
// false branch byte for byte.
const REQ_S1      = 150780;
const DEADLINE_S1 = 150790;

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
            // Derived from the maps, never a hardcoded network list (D91): where zero-conf
            // is armed on the request's own block the ladder runs V2 and the ceiling is
            // headroom + maxSlots; where it is not, the ceiling is stage-1's bare maxSlots.
            const zcActive = zc.isZeroConfActive(height, net);
            const expected = zcActive
                ? wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots
                : wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots;
            expect(wid.widenSlots(height + 21, height, height + 30, net),
                net + ': a request at the height must widen').to.equal(expected);
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

describe('attest_responsible_widening: the ladder (stage 1, testnet: widening armed, request below the zero-conf flip)', function () {

    before(function () {
        // Vacuity guard (D91): stage-1 numbers can only be asserted where widening is
        // armed AND the REQUEST block sits below the zero-conf flip (the stage is keyed
        // on the request block, D106). Regtest arms zero-conf at 0, so testnet with a
        // request below 151800 is the shape; fail loudly if that ever stops being true.
        expect(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet).to.be.a('number');
        expect(zc.ATTEST_ZERO_CONF_ACTIVATION.testnet).to.be.a('number');
        expect(REQ_S1).to.be.below(zc.ATTEST_ZERO_CONF_ACTIVATION.testnet);
        expect(REQ_S1).to.be.at.least(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet);
    });

    it('grants nothing inside the first segment, so a healthy round never sees a widened set', function () {
        // serviceable at REQ_S1+3, span 7, three segments of 7/3.
        for (const at of [REQ_S1, REQ_S1 + 1, REQ_S1 + 3, REQ_S1 + 4, REQ_S1 + 5]) {
            expect(wid.widenSlots(at, REQ_S1, DEADLINE_S1, 'testnet'), 'block ' + at).to.equal(0);
        }
    });

    it('reaches both slots BEFORE the deadline on the measured 10-block window', function () {
        expect(wid.widenSlots(REQ_S1 + 6, REQ_S1, DEADLINE_S1, 'testnet')).to.equal(1);
        expect(wid.widenSlots(REQ_S1 + 8, REQ_S1, DEADLINE_S1, 'testnet')).to.equal(2);
        expect(wid.widenSlots(DEADLINE_S1, REQ_S1, DEADLINE_S1, 'testnet')).to.equal(2);
    });

    it('scales with the request window rather than a fixed block count', function () {
        // A 100-block deadline gets a proportionally longer grace period.
        expect(wid.widenSlots(REQ_S1 + 10, REQ_S1, REQ_S1 + 100, 'testnet')).to.equal(0);
        expect(wid.widenSlots(REQ_S1 + 40, REQ_S1, REQ_S1 + 100, 'testnet')).to.equal(1);
        expect(wid.widenSlots(REQ_S1 + 70, REQ_S1, REQ_S1 + 100, 'testnet')).to.equal(2);
    });

    it('never exceeds maxSlots, however far past the deadline', function () {
        for (const at of [DEADLINE_S1 + 1, DEADLINE_S1 + 100, DEADLINE_S1 + 100000]) {
            expect(wid.widenSlots(at, REQ_S1, DEADLINE_S1, 'testnet')).to.equal(wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots);
        }
    });

    it('is monotone non-decreasing in height, which is what makes hub and indexer agree', function () {
        let prev = 0;
        for (let at = REQ_S1; at <= DEADLINE_S1 + 20; at++) {
            const v = wid.widenSlots(at, REQ_S1, DEADLINE_S1, 'testnet');
            expect(v, 'block ' + at).to.be.at.least(prev);
            prev = v;
        }
    });

    it('grants nothing on a degenerate span (deadline at or inside the confirmation lag)', function () {
        expect(wid.widenSlots(REQ_S1 + 50, REQ_S1, REQ_S1, 'testnet')).to.equal(0);
        expect(wid.widenSlots(REQ_S1 + 50, REQ_S1, REQ_S1 + 3, 'testnet')).to.equal(0);
        expect(wid.widenSlots(REQ_S1 + 50, REQ_S1, REQ_S1 - 5, 'testnet')).to.equal(0);
    });

    it('grants nothing for unusable heights', function () {
        expect(wid.widenSlots(NaN, REQ_S1, DEADLINE_S1, 'testnet')).to.equal(0);
        expect(wid.widenSlots(REQ_S1 + 8, undefined, DEADLINE_S1, 'testnet')).to.equal(0);
        expect(wid.widenSlots(REQ_S1 + 8, REQ_S1, null, 'testnet')).to.equal(0);
    });
});

describe('attest_responsible_widening: the V2 ladder (zero-conf armed, D27, D28)', function () {

    before(function () {
        // regtest arms ATTEST_ZERO_CONF_ACTIVATION at 0 (D91), so REQ/DEADLINE (BTC
        // testnet4's measured incident block numbers, reused here as arbitrary regtest
        // heights) run the V2 branch of widenSlots.
        expect(zc.isZeroConfActive(REQ, 'regtest')).to.equal(true);
    });

    it('grants headroom at the request block, where elapsed is 0 (D27)', function () {
        expect(wid.widenSlots(REQ, REQ, DEADLINE, 'regtest')).to.equal(wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
    });

    it('grants headroom at elapsed 0 generally, including before the request block', function () {
        expect(wid.widenSlots(REQ - 2, REQ, DEADLINE, 'regtest')).to.equal(wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
    });

    it('grants headroom, never 0, on a degenerate span (D27)', function () {
        expect(wid.widenSlots(REQ + 50, REQ, REQ, 'regtest')).to.equal(wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
        expect(wid.widenSlots(REQ + 50, REQ, REQ - 5, 'regtest')).to.equal(wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
    });

    it('reaches headroom+1 and headroom+2 before the deadline on the measured 10-block window', function () {
        // start=REQ, span=10, segment=10/3=3.333: idx 1 at elapsed>=3.333 (elapsed 4),
        // idx 2 (clamped to maxSlots) at elapsed>=6.667 (elapsed 7).
        expect(wid.widenSlots(REQ + 4, REQ, DEADLINE, 'regtest'))
            .to.equal(wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + 1);
        expect(wid.widenSlots(REQ + 7, REQ, DEADLINE, 'regtest'))
            .to.equal(wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots);
        expect(wid.widenSlots(DEADLINE, REQ, DEADLINE, 'regtest'))
            .to.equal(wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots);
    });

    it('clamps to headroom+maxSlots (3) past the deadline, however far past it', function () {
        const ceiling = wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots;
        expect(ceiling).to.equal(3);
        for (const at of [DEADLINE + 1, DEADLINE + 100, DEADLINE + 100000]) {
            expect(wid.widenSlots(at, REQ, DEADLINE, 'regtest')).to.equal(ceiling);
        }
    });

    it('is monotone non-decreasing in atBlock', function () {
        let prev = 0;
        for (let at = REQ - 5; at <= DEADLINE + 20; at++) {
            const v = wid.widenSlots(at, REQ, DEADLINE, 'regtest');
            expect(v, 'block ' + at).to.be.at.least(prev);
            prev = v;
        }
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
