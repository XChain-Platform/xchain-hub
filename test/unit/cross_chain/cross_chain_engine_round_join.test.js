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

// Any hub opens an attestation round from a request, whatever its live rotation says, and a
// request for an id already in flight joins that round and settles with it instead of replacing it.

const sinon            = require('sinon');
const { expect }       = require('chai');
const CrossChainEngine = require('../../../src/cross_chain/engine');

const ID     = 'BTC:7:DOGE';
const DIGEST = 'digest-7';
const PROPOSE = 'XCHAIN_ATTEST_PROPOSE';

// A federated hub over a four-member snapshot with a locked quorum of three. Its live set holds
// two other hubs only, so the old seq rotation would never pick it to propose.
function buildHub() {
    let broadcasts = [];
    let pm = { validatorAddr: 'ws://self:10001', broadcast: (type, data) => broadcasts.push({ type, data }) };
    let hub = { getPeerManager: () => pm, db: {}, p2pConfig: {}, network: 'regtest', resolveBtcLatestBlock: async () => 100 };
    let engine = new CrossChainEngine(hub);
    engine.setValidatorSet([{ addr: 'ws://a:10001', pubkey: 'a' }, { addr: 'ws://b:10001', pubkey: 'b' }]);
    engine.timeout              = 1000;
    engine.isKnownSender        = () => true;
    engine.digest               = () => DIGEST;
    engine.verifySourceAction   = async () => true;
    engine.resolveQuorum        = async () => 3;
    engine.resolveMemberPubkeys = async () => new Set(['p1', 'self', 'v2', 'v3']);
    engine.selfPubkey           = () => 'self';
    engine.stored = [];
    engine.storeAttestation = async (a) => { engine.stored.push(a); };
    return { engine, broadcasts };
}

function envelope(pubkey, data) {
    return { sender: 'ws://' + pubkey + ':10001', sig_pubkey: pubkey, data };
}

function proposeFrom(engine, pubkey) {
    return engine.handlePropose(envelope(pubkey, {
        attestationId: ID, sourceChain: 'BTC', sourceActionIndex: 7, destChain: 'DOGE',
        confirmations: 60, digest: DIGEST, btcBlockHeight: 100
    }));
}

function vote(engine, kind, pubkey) {
    let e = envelope(pubkey, { attestationId: ID, digest: DIGEST });
    if (kind === 'prepare') engine.handlePrepare(e); else engine.handleCommit(e);
}

// Let every resolved await in the request path run.
function settle() {
    return new Promise((resolve) => setImmediate(resolve));
}

// Give every case a fresh hub and stop its engine after; cases read the hub from the returned state.
function hubSandbox() {
    let state = { engine: null, broadcasts: null };
    beforeEach(function () {
        Object.assign(state, buildHub());
    });
    afterEach(async function () {
        await state.engine.stop();
        sinon.restore();
    });
    return state;
}

// Open a round, or join the one in flight for the id, and settle every caller with it.
function registerJoinCases(state) {
    it('opens a round and broadcasts PROPOSE on a hub its live rotation would not pick', async function () {
        let { engine, broadcasts } = state;
        let request = engine.requestAttestation('BTC', 7, 'DOGE');
        request.catch(() => {});
        await settle();
        expect(engine.pendingAttestations.has(ID)).to.equal(true);
        expect(broadcasts.filter((b) => b.type === PROPOSE)).to.have.length(1);
    });

    it('joins the round it already follows and settles with it at commit quorum', async function () {
        let { engine, broadcasts } = state;
        await proposeFrom(engine, 'p1');
        let followed = engine.pendingAttestations.get(ID);
        let request = engine.requestAttestation('BTC', 7, 'DOGE');
        await settle();
        // The followed round keeps the proposer's PREPARE and no second PROPOSE goes out.
        expect(engine.pendingAttestations.get(ID)).to.equal(followed);
        expect([...followed.prepares].sort()).to.deep.equal(['p1', 'self']);
        expect(broadcasts.filter((b) => b.type === PROPOSE)).to.have.length(0);
        vote(engine, 'prepare', 'v2');
        vote(engine, 'commit', 'p1');
        vote(engine, 'commit', 'v2');
        let attestation = await request;
        expect(attestation.attestationId).to.equal(ID);
        expect(attestation.status).to.equal('attested');
        expect(engine.stored).to.have.length(1);
    });

    it('joins its own round on a second request and settles both callers with one attestation', async function () {
        let { engine, broadcasts } = state;
        let first = engine.requestAttestation('BTC', 7, 'DOGE');
        await settle();
        let led = engine.pendingAttestations.get(ID);
        let second = engine.requestAttestation('BTC', 7, 'DOGE');
        await settle();
        expect(engine.pendingAttestations.get(ID)).to.equal(led);
        expect(broadcasts.filter((b) => b.type === PROPOSE)).to.have.length(1);
        vote(engine, 'prepare', 'p1');
        vote(engine, 'prepare', 'v2');
        vote(engine, 'commit', 'p1');
        vote(engine, 'commit', 'v2');
        let [a, b] = await Promise.all([first, second]);
        expect(a).to.equal(b);
        expect(engine.stored).to.have.length(1);
    });
}

// Reject a joined caller when its round ends without it, and evict only the round a timer owns.
function registerRejectCases(state) {
    it('rejects a joined caller when the engine stops', async function () {
        let { engine } = state;
        await proposeFrom(engine, 'p1');
        let request = engine.requestAttestation('BTC', 7, 'DOGE');
        await settle();
        await engine.stop();
        let err = await request.then(() => null, (e) => e);
        expect(err && err.message).to.equal('Cross-chain engine stopped');
    });

    it('rejects a joined caller with a timeout when its round never finalizes', async function () {
        let { engine } = state;
        let clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await proposeFrom(engine, 'p1');
        let request = engine.requestAttestation('BTC', 7, 'DOGE');
        await settle();
        clock.tick(engine.timeout + 1);
        let err = await request.then(() => null, (e) => e);
        expect(err && err.message).to.equal('Attestation timeout for ' + ID);
        // The followed round itself lives on until its own eviction.
        expect(engine.pendingAttestations.has(ID)).to.equal(true);
    });

    it('rejects a joined caller when the round it joined is evicted', async function () {
        let { engine } = state;
        let clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let first = engine.requestAttestation('BTC', 7, 'DOGE');
        first.catch(() => {});
        await settle();
        clock.tick(engine.timeout / 2);
        let joined = engine.requestAttestation('BTC', 7, 'DOGE');
        await settle();
        clock.tick(engine.timeout / 2 + 1);
        let err = await joined.then(() => null, (e) => e);
        expect(err && err.message).to.equal('Attestation timeout for ' + ID);
        expect(engine.pendingAttestations.has(ID)).to.equal(false);
    });

    it('leaves a newer round under the same id in place when a stale follower timer fires', async function () {
        let { engine } = state;
        let clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await proposeFrom(engine, 'p1');
        clock.tick(engine.timeout + 10);
        // The followed round is gone (as after a finalize), and this hub's own request opens a new one.
        engine.pendingAttestations.delete(ID);
        let request = engine.requestAttestation('BTC', 7, 'DOGE');
        request.catch(() => {});
        await settle();
        let led = engine.pendingAttestations.get(ID);
        expect(led).to.exist;
        // The followed round's eviction timer fires at twice the timeout, before the new round's own.
        clock.tick(engine.timeout - 5);
        expect(engine.pendingAttestations.get(ID)).to.equal(led);
    });
}

describe('CrossChainEngine round join', function () {
    let state = hubSandbox();
    registerJoinCases(state);
    registerRejectCases(state);
});
