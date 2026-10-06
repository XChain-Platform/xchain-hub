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

// A poll that never gets a usable HTTP answer (indexer unreachable, timeout, or a 401/403
// key mismatch) never sets lastPollOkAt, so without its own meter a hub that has never once
// reached its indexer reports the same stats as one that just booted. Those failures are
// counted by class, and poll_unsuccessful_for_ms measures how long the feed has gone
// without a usable poll, from the first attempt when none has succeeded.

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
        resolveBtcIndexerUrl: sinon.stub().resolves(opts.url === undefined ? 'http://idx/rpc' : opts.url),
        btcIndexerHeaders: () => ({})
    };
    let ar = new AttestationRound(hub, { isKnown: () => true });
    if (opts.observer) ar.identity = null;
    return ar;
}

// Run fn with console.warn silenced; the warning text is covered by the poll suite.
async function quietly(fn) {
    let orig = console.warn;
    console.warn = () => {};
    try { await fn(); } finally { console.warn = orig; }
}

describe('AttestationRound: poll transport and auth failures are measured', function () {
    before(function () {
        this.timeout(60000);   // one proxyquire load of the round module, shared by every case
        axiosStub = { post: null };
        AttestationRound = proxyquire('../../../../src/attestation/round', { axios: axiosStub });
    });
    beforeEach(function () { axiosStub.post = sinon.stub(); });
    afterEach(function () { sinon.restore(); });

    it('counts an unreachable indexer as a transport error, once per poll', async function () {
        let err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4000'), { code: 'ECONNREFUSED' });
        axiosStub.post.rejects(err);
        let ar = makeRound();
        await quietly(async () => { await ar.pollPending(); await ar.pollPending(); });
        let s = ar.getStats();
        expect(s.poll_transport_error_count).to.equal(2);
        expect(s.poll_auth_error_count).to.equal(0);
        expect(s.poll_rpc_error_count, 'a transport failure is not a JSON-RPC rejection').to.equal(0);
        expect(s.last_successful_poll_age_ms).to.equal(null);
        expect(s.poll_unsuccessful_for_ms).to.be.a('number').and.at.least(0);
    });

    it('counts a 401 as an auth error, not a transport error', async function () {
        axiosStub.post.rejects(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
        let ar = makeRound();
        await quietly(() => ar.pollPending());
        let s = ar.getStats();
        expect(s.poll_auth_error_count).to.equal(1);
        expect(s.poll_transport_error_count).to.equal(0);
        expect(s.poll_unsuccessful_for_ms).to.be.a('number');
    });

    it('reports no failing-for age when no poll was ever attempted', async function () {
        let observer = makeRound({ observer: true });
        let noUrl = makeRound({ url: null });
        await observer.pollPending();
        await noUrl.pollPending();
        for (let ar of [observer, noUrl]) {
            expect(ar.firstPollAttemptAt).to.equal(null);
            expect(ar.getStats().poll_unsuccessful_for_ms).to.equal(null);
        }
        expect(axiosStub.post.called).to.equal(false);
    });

    it('measures from the first attempt, then from the last success once one lands', async function () {
        let clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
        axiosStub.post.rejects(new Error('timeout of 5000ms exceeded'));
        let ar = makeRound();
        await quietly(() => ar.pollPending());
        clock.tick(400000);
        expect(ar.getStats().poll_unsuccessful_for_ms, 'failing since the first attempt').to.equal(400000);
        axiosStub.post.resolves({ data: { result: { latest_block_index: 100, requests: [] } } });
        await ar.pollPending();
        clock.tick(3000);
        let s = ar.getStats();
        expect(s.last_successful_poll_age_ms).to.equal(3000);
        expect(s.poll_unsuccessful_for_ms, 'follows the success once there is one').to.equal(3000);
    });
});
