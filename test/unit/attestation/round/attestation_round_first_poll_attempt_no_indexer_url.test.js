'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A hub with no resolvable BTC indexer URL still attempts a poll every tick, so it stamps
// firstPollAttemptAt and reports how long its feed has gone without a usable poll. An
// observer-only hub never attempts one and stays unstamped.

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const EventEmitter   = require('events');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

let axiosStub, AttestationRound;

function makeRound(opts) {
    opts = opts || {};
    let pm = new EventEmitter();
    pm.broadcast = sinon.stub();
    let hub = {
        db: { ...DB_METHODS, doQuery: sinon.stub().resolves([]) },
        p2pConfig: {},
        getPeerManager: () => pm,
        getIdentity: () => ({ getPubkeyHex: () => 'aa'.repeat(32) }),
        capabilitySnapshot: null,
        resolveBtcIndexerUrl: sinon.stub().resolves(null),
        btcIndexerHeaders: () => ({})
    };
    let ar = new AttestationRound(hub, { isKnown: () => true });
    if (opts.observer) ar.identity = null;
    return ar;
}

describe('AttestationRound: first poll attempt without an indexer URL', function () {
    before(function () {
        this.timeout(60000);
        axiosStub = { post: null };
        AttestationRound = proxyquire('../../../../src/attestation/round', { axios: axiosStub });
    });
    beforeEach(function () { axiosStub.post = sinon.stub(); });
    afterEach(function () { sinon.restore(); });

    it('stamps firstPollAttemptAt and reports a failing-for age with no URL', async function () {
        let clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
        let ar = makeRound();
        await ar.pollPending();
        expect(ar.firstPollAttemptAt).to.equal(1000000);
        clock.tick(250000);
        expect(ar.getStats().poll_unsuccessful_for_ms).to.equal(250000);
        expect(axiosStub.post.called).to.equal(false);
    });

    it('keeps the first stamp across later URL-less ticks', async function () {
        let clock = sinon.useFakeTimers({ now: 5000, toFake: ['Date'] });
        let ar = makeRound();
        await ar.pollPending();
        clock.tick(60000);
        await ar.pollPending();
        expect(ar.firstPollAttemptAt).to.equal(5000);
    });

    it('leaves an observer-only hub unstamped', async function () {
        let ar = makeRound({ observer: true });
        await ar.pollPending();
        expect(ar.firstPollAttemptAt).to.equal(null);
        expect(ar.getStats().poll_unsuccessful_for_ms).to.equal(null);
    });
});
