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
// The anchor payload fields a monitor reads to tell a silent publisher from a
// quiet one: noConfirmedUtxoDeferrals, spendGuard.persistBroken, and the
// per-gate blocked counters on the spend guard and its count ceiling.

const { expect }           = require('chai');
const fs                   = require('fs');
const os                   = require('os');
const path                 = require('path');
const StateAnchorPublisher = require('../../../../src/anchor/publisher');

function newPub(cfg) {
    return new StateAnchorPublisher({ db: {}, p2pConfig: Object.assign({ DOGE_ADDRESS: 'Dpub1' }, cfg || {}) });
}

describe('StateAnchorPublisher payload: blocked counters', function () {
    it('reports noConfirmedUtxoDeferrals as a number from a fresh publisher', function () {
        const s = newPub().getAnchorStats();
        expect(s).to.have.property('noConfirmedUtxoDeferrals', 0);
        expect(s).to.have.property('lastNoConfirmedUtxoAt');
    });

    it('reports a counted deferral in the payload', function () {
        const pub = newPub();
        pub.noConfirmedUtxoDeferrals++;
        expect(pub.getAnchorStats().noConfirmedUtxoDeferrals).to.equal(1);
    });

    it('starts with persistBroken false and zeroed blocked counters', function () {
        const g = newPub().getAnchorStats().spendGuard;
        expect(g.persistBroken).to.equal(false);
        expect(g.blocked).to.deep.equal({ pause: 0, spend: 0, balance: 0, persist: 0 });
        expect(g.count.blocked).to.equal(0);
    });

    it('counts a tripped spend ceiling in the payload', function () {
        const pub = newPub({ ANCHOR_MAX_SPEND_USD_CENTS_PER_WINDOW: 150, ANCHOR_EST_SPEND_USD_CENTS: 100 });
        expect(pub.spendGuard.allow()).to.equal(true);
        pub.spendGuard.record(100);
        const verdict = pub.spendGuard.check();
        expect(verdict.ok).to.equal(false);
        expect(pub.getAnchorStats().spendGuard.blocked.spend).to.be.at.least(1);
    });
});

describe('StateAnchorPublisher payload: persistBroken', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-blocked-'));
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('flips persistBroken and counts a persist refusal when the store cannot be written', function () {
        const pub = newPub();
        // A directory appearing where the state file belongs, after the guard loaded,
        // makes every later write fail.
        const statePath = path.join(dir, 'state.json');
        pub.spendGuard.persistTo(statePath);
        fs.mkdirSync(statePath);

        expect(pub.spendGuard.reserve(), "the refused write rolls the reservation back").to.equal(null);

        const g = pub.getAnchorStats().spendGuard;
        expect(g.persistBroken).to.equal(true);
        expect(g.persistError).to.be.a('string').and.not.empty;
        expect(g.blocked.persist).to.be.at.least(1);
    });

    it('clears persistBroken in the payload once the store accepts writes again', function () {
        const pub = newPub();
        const statePath = path.join(dir, 'state.json');
        pub.spendGuard.persistTo(statePath);
        fs.mkdirSync(statePath);
        pub.spendGuard.reserve();
        expect(pub.getAnchorStats().spendGuard.persistBroken).to.equal(true);

        fs.rmdirSync(statePath);
        expect(pub.spendGuard.allow()).to.equal(true);
        expect(pub.getAnchorStats().spendGuard.persistBroken).to.equal(false);
    });
});
