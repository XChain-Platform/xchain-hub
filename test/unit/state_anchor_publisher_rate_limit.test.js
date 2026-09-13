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

// _broadcastWithRetry's encoder rate-limit branch. The encoder sheds with 429 +
// JSON-RPC -32029 from two places that want waits ~60x apart (the per-IP limiter's
// 60s window and the concurrency gate's Retry-After: 1), so the publisher honours
// the header instead of spending its whole 5-attempt budget on flat 2.5s waits
// inside a single rate-limit window. A rate-limit wait must not consume an attempt,
// must be clamped, and must be bounded in count so a persistently shedding encoder
// defers the anchor rather than stalling the flush forever.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

function mkPub(){
    const pub = new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    pub.chunkRetryDelayMs     = 2500;
    pub.ambiguousPollDelayMs  = 1;
    pub.ambiguousPollAttempts = 1;
    pub.waits = [];
    // Record instead of waiting: the test asserts the DURATION the publisher chose.
    pub._sleep = async (ms) => { pub.waits.push(ms); };
    return pub;
}

function rateLimitErr(retryAfter){
    const e = new Error('Encoder RPC error: Too many requests');
    e.rpcCode  = -32029;
    e.response = {
        status: 429,
        headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
        data: { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } }
    };
    return e;
}

describe('StateAnchorPublisher: encoder rate-limit waits', function () {

    it('honours the per-IP limiter Retry-After instead of the flat chunk retry delay', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls === 1) throw rateLimitErr(60);
            return { txid: 'tx-ok' };
        };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(res.txid).to.equal('tx-ok');
        expect(pub.waits).to.deep.equal([60000]);
    });

    it('honours the concurrency gate Retry-After: 1 without over-waiting', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls === 1) throw rateLimitErr(1);
            return { txid: 'tx-ok' };
        };
        await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(pub.waits).to.deep.equal([1000]);
    });

    it('clamps a Retry-After above the ceiling to rateLimitMaxWaitMs', async function () {
        const pub = mkPub();
        pub.rateLimitMaxWaitMs = 60000;
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls === 1) throw rateLimitErr(3600);
            return { txid: 'tx-ok' };
        };
        await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(pub.waits).to.deep.equal([60000]);
    });

    it('accepts an HTTP-date Retry-After', async function () {
        const pub = mkPub();
        const when = new Date(Date.now() + 30000).toUTCString();
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls === 1) throw rateLimitErr(when);
            return { txid: 'tx-ok' };
        };
        await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(pub.waits).to.have.lengthOf(1);
        expect(pub.waits[0]).to.be.within(25000, 30000);
    });

    it('falls back to the flat retry delay when the 429 carries no parseable Retry-After', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls === 1) throw rateLimitErr(undefined);
            return { txid: 'tx-ok' };
        };
        await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(pub.waits).to.deep.equal([2500]);
    });

    it('does not charge a rate-limit wait to the attempt budget', async function () {
        const pub = mkPub();
        let calls = 0;
        // One 429 (free) then four transient pre-send failures, which is the FULL
        // 5-attempt budget; the sixth call must still happen and succeed.
        const broadcaster = async () => {
            calls++;
            if (calls === 1) throw rateLimitErr(60);
            if (calls <= 5) throw new Error('no UTXOs available for Dpub1');
            return { txid: 'tx-ok' };
        };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(res.txid).to.equal('tx-ok');
        expect(calls).to.equal(6);
        expect(pub.waits).to.deep.equal([60000, 2500, 2500, 2500, 2500]);
    });

    it('rethrows once rateLimitMaxWaits consecutive rate-limit waits are spent', async function () {
        const pub = mkPub();
        pub.rateLimitMaxWaits = 3;
        let calls = 0;
        const broadcaster = async () => { calls++; throw rateLimitErr(60); };
        let caught = null;
        try { await pub._broadcastWithRetry(broadcaster, 'P', 5); }
        catch (e) { caught = e; }
        expect(caught).to.be.an('error');
        expect(caught.rpcCode).to.equal(-32029);
        expect(calls).to.equal(4);                       // 3 free waits, then give up
        expect(pub.waits).to.deep.equal([60000, 60000, 60000]);
    });

    it('leaves the flat retry path untouched for an error with no status and no rpcCode', async function () {
        const pub = mkPub();
        let calls = 0;
        const broadcaster = async () => {
            calls++;
            if (calls < 3) throw new Error('no UTXOs available for Dpub1');
            return { txid: 'tx-ok' };
        };
        const res = await pub._broadcastWithRetry(broadcaster, 'P', 5);
        expect(res.txid).to.equal('tx-ok');
        expect(pub.waits).to.deep.equal([2500, 2500]);
    });

    it('never treats a non-429 encoder RPC error as a rate limit', async function () {
        const pub = mkPub();
        const e = new Error('Encoder RPC error: insufficient funds');
        e.rpcCode  = -32010;
        e.response = { status: 400, headers: { 'retry-after': '60' } };
        expect(pub._rateLimitWaitMs(e)).to.equal(null);
    });
});
