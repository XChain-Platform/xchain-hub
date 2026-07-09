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

const sinon                = require('sinon');
const crypto               = require('crypto');
const { expect }           = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { createMockHub }    = require('../helpers/mockHub');

// Minimal provider registry: the COMMIT/buffer paths exercised here never
// call into a provider (no agree() / no def lookups for unsigned commits).
function makeProviderRegistry() {
    return {
        getDef:    sinon.stub().returns(null),
        getModule: sinon.stub().returns(null)
    };
}

// ---- Full-PBFT-flow helpers (real ed25519 keys so sign/verify is genuine) ----

const flush = () => new Promise(r => setImmediate(r));

function mkIdentity() {
    return new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
}
function pub(id) { return id.getPubkeyHex().toLowerCase(); }

// Mirror of AttestationConsensus._buildCanonical so peers can sign the exact
// bytes the consensus engine will verify against.
function buildCanonical(rid, providerId, body, status, meta) {
    let hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    return Buffer.from(String(rid) + String(providerId) + hash + String(status) + String(meta || ''), 'utf8');
}

// Build a signed PROPOSE/PREPARE/COMMIT envelope from a peer identity.
function signEnv(type, rid, providerId, id, body, meta, status) {
    status = status || 'ok';
    meta   = meta || '';
    let sig = id.sign(buildCanonical(rid, providerId, body, status, meta).toString('utf8'));
    return {
        type,
        data: {
            requestId:  rid,
            providerId,
            body_b64:   body.toString('base64'),
            meta,
            status,
            sig_pubkey: pub(id),
            sig
        }
    };
}

// Provider registry whose agree() returns the first proposal by default.
function makeRealProviderRegistry(agreeFn, strategy, maxBytes) {
    return {
        getDef: sinon.stub().returns({
            max_response_bytes: maxBytes || 65536,
            consensus_strategy: strategy || 'byte_equality'
        }),
        getModule: sinon.stub().returns({ agree: agreeFn || ((proposals) => proposals[0]) })
    };
}

// roundState passed to propose().
function roundState(me, responsibleIds, body, providerId, redundancy, meta) {
    return {
        request:      { request_id: 'req' },
        providerId,
        redundancy,
        snapshot:     {},
        responsible:  responsibleIds.map(i => ({ pubkey: pub(i) })),
        leaderPubkey: pub(me),
        role:         'leader',
        myProposal:   { body, meta: meta || '' }
    };
}

describe('AttestationConsensus', function () {

    let hub, consensus;

    beforeEach(function () {
        hub = createMockHub();
        consensus = new AttestationConsensus(hub, makeProviderRegistry());
    });

    afterEach(function () {
        for (let [, p] of consensus.pending) {
            if (p.timer) clearTimeout(p.timer);
        }
        sinon.restore();
    });

    // Build a `pending` in the post-PROPOSE / pre-winner window: the round
    // exists but provider.agree() (async) hasn't yet set a winner. This is the
    // exact window in which a fast peer's COMMIT can arrive.
    function seedPendingNoWinner(rid, peerPubkey) {
        let pending = {
            requestId:   rid,
            providerId:  'http_get',
            redundancy:  3,
            quorum:      3,
            responsible: [{ pubkey: peerPubkey }],
            commits:     new Set(),
            prepares:    new Set(),
            signatures:  new Map(),
            winner:      null,
            status:      'ok',
            finalized:   false,
            timer:       null
        };
        consensus.pending.set(rid, pending);
        return pending;
    }

    // Unsigned COMMIT envelope: omitting `sig` skips signature verification in
    // _handleCommit, so the test asserts vote-counting (commits.add) without
    // needing real validator crypto. The buffering decision under test happens
    // before any signature check regardless.
    function commitEnvelope(rid, peerPubkey) {
        return { type: 'ATTEST_COMMIT', data: { requestId: rid, sig_pubkey: peerPubkey } };
    }

    describe('_handleCommit: early COMMIT (before winner is set)', function () {

        const RID  = 'deadbeefdeadbeefdeadbeefdeadbeef';
        const PEER = '11'.repeat(32);

        it('buffers an early COMMIT instead of silently dropping it', function () {
            let pending = seedPendingNoWinner(RID, PEER);

            // Route through the public dispatch path, mirroring the drain.
            consensus._handleMessage(commitEnvelope(RID, PEER));

            // The vote is held, NOT applied yet (winner not known) and, the
            // regression this guards, NOT discarded.
            expect(consensus.earlyCommits.get(RID)).to.have.lengthOf(1);
            expect(pending.commits.size).to.equal(0);
        });

        it('counts the buffered COMMIT once the winner is established and drained', function () {
            let pending = seedPendingNoWinner(RID, PEER);
            consensus._handleCommit(commitEnvelope(RID, PEER));
            expect(pending.commits.size).to.equal(0);

            // Winner gets established (provider.agree() resolved); drain replays
            // the buffered COMMIT so the peer's vote now counts toward quorum.
            pending.winner = { body: Buffer.from('winning-body'), meta: '' };
            consensus._drainEarlyCommits(RID);

            expect(pending.commits.has(PEER)).to.equal(true);
            expect(consensus.earlyCommits.has(RID)).to.equal(false);
        });

        it('caps the per-request early-commit buffer', function () {
            seedPendingNoWinner(RID, PEER);
            let over = consensus.earlyCommitMaxPerRid + 5;
            for (let i = 0; i < over; i++) {
                consensus._handleCommit(commitEnvelope(RID, PEER));
            }
            expect(consensus.earlyCommits.get(RID).length).to.equal(consensus.earlyCommitMaxPerRid);
        });
    });

    describe('_handleCommit: COMMIT after winner is set', function () {

        const RID  = 'cafecafecafecafecafecafecafecafe';
        const PEER = '22'.repeat(32);

        it('applies the vote directly without buffering', function () {
            let pending = seedPendingNoWinner(RID, PEER);
            pending.winner = { body: Buffer.from('winning-body'), meta: '' };

            consensus._handleCommit(commitEnvelope(RID, PEER));

            expect(pending.commits.has(PEER)).to.equal(true);
            expect(consensus.earlyCommits.has(RID)).to.equal(false);
        });
    });

    describe('_handleCommit: COMMIT before the round exists', function () {

        const RID  = 'f00df00df00df00df00df00df00df00d';
        const PEER = '33'.repeat(32);

        it('still buffers in earlyMessages (unchanged !pending behavior)', function () {
            // No pending for RID; the pre-existing early-arrival path must
            // still capture the COMMIT for replay in propose().
            consensus._handleCommit(commitEnvelope(RID, PEER));

            expect(consensus.earlyMessages.get(RID)).to.have.lengthOf(1);
            expect(consensus.earlyCommits.has(RID)).to.equal(false);
        });
    });
});

describe('AttestationConsensus: lifecycle', function () {

    afterEach(() => sinon.restore());

    it('start() is a no-op when there is no peer manager', async function () {
        let hub = createMockHub();
        let c = new AttestationConsensus(hub, makeProviderRegistry());
        c.peerManager = null;
        await c.start();
        expect(c._messageHandler).to.equal(null);
    });

    it('start() subscribes to peer messages and stop() unsubscribes + clears state', async function () {
        let hub = createMockHub();
        let c = new AttestationConsensus(hub, makeProviderRegistry());
        await c.start();
        expect(c._messageHandler).to.be.a('function');
        expect(hub._peerManager.listenerCount('message')).to.equal(1);

        // Seed some state to confirm stop() clears it.
        c.pending.set('x', { timer: setTimeout(() => {}, 60000) });
        c.earlyMessages.set('x', []);
        c.earlyCommits.set('x', []);
        await c.stop();

        expect(c._messageHandler).to.equal(null);
        expect(hub._peerManager.listenerCount('message')).to.equal(0);
        expect(c.pending.size).to.equal(0);
        expect(c.earlyMessages.size).to.equal(0);
        expect(c.earlyCommits.size).to.equal(0);
    });

    it('_handleMessage ignores unknown message types', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        expect(() => c._handleMessage({ type: 'NOT_AN_ATTEST_MESSAGE', data: {} })).to.not.throw();
    });
});

describe('AttestationConsensus: _buildCanonical / _signCanonical', function () {

    afterEach(() => sinon.restore());

    it('_buildCanonical hashes the body and concatenates the fields deterministically', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        let body = Buffer.from('payload');
        let out = c._buildCanonical('rid1', 'http_get', body, 'ok', 'm');
        let expected = 'rid1' + 'http_get' +
            crypto.createHash('sha256').update(body, 'utf8').digest('hex') + 'ok' + 'm';
        expect(out.toString('utf8')).to.equal(expected);
        // Empty meta normalises to ''.
        let out2 = c._buildCanonical('rid1', 'http_get', body, 'ok', null);
        expect(out2.toString('utf8')).to.equal('rid1http_get' +
            crypto.createHash('sha256').update(body, 'utf8').digest('hex') + 'ok');
    });

    it('_signCanonical returns null when there is no identity', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.identity = null;
        expect(c._signCanonical('rid', 'p', Buffer.from('b'), 'ok', '')).to.equal(null);
    });

    it('_signCanonical returns null (not throw) when identity.sign throws', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.identity = { sign: () => { throw new Error('hsm offline'); } };
        expect(c._signCanonical('rid', 'p', Buffer.from('b'), 'ok', '')).to.equal(null);
    });

    it('_signCanonical produces a verifiable signature with a real identity', function () {
        let id = mkIdentity();
        let hub = createMockHub({ identity: id });
        let c = new AttestationConsensus(hub, makeProviderRegistry());
        let body = Buffer.from('b');
        let sig = c._signCanonical('rid', 'p', body, 'ok', 'm');
        let canonical = buildCanonical('rid', 'p', body, 'ok', 'm').toString('utf8');
        expect(ValidatorIdentity.verify(canonical, sig, pub(id))).to.equal(true);
    });
});

describe('AttestationConsensus: _markFinalized ring buffer', function () {

    it('evicts the oldest request id once finalizedMax is exceeded', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.finalizedMax = 2;
        c._markFinalized('a');
        c._markFinalized('b');
        c._markFinalized('b'); // duplicate is a no-op
        c._markFinalized('c'); // evicts 'a'
        expect(c.finalized.has('a')).to.equal(false);
        expect(c.finalized.has('b')).to.equal(true);
        expect(c.finalized.has('c')).to.equal(true);
        expect(c._finalizedOrder).to.deep.equal(['b', 'c']);
    });
});

describe('AttestationConsensus: early-message buffer', function () {

    let c;
    beforeEach(() => { c = new AttestationConsensus(createMockHub(), makeProviderRegistry()); });
    afterEach(() => sinon.restore());

    it('caps the per-request early-message buffer', function () {
        let env = { type: 'ATTEST_PROPOSE', data: { requestId: 'r' } };
        for (let i = 0; i < c.earlyMessageMaxPerRid + 5; i++) c._bufferEarlyMessage('r', env);
        expect(c.earlyMessages.get('r').length).to.equal(c.earlyMessageMaxPerRid);
    });

    it('prunes expired entries on the next buffer', function () {
        let clock = sinon.useFakeTimers();
        c._bufferEarlyMessage('old', { type: 'ATTEST_PROPOSE', data: { requestId: 'old' } });
        expect(c.earlyMessages.has('old')).to.equal(true);
        clock.tick(c.earlyMessageTtlMs + 1);
        // Buffering anything triggers a prune of the now-expired 'old' entry.
        c._bufferEarlyMessage('new', { type: 'ATTEST_PROPOSE', data: { requestId: 'new' } });
        expect(c.earlyMessages.has('old')).to.equal(false);
        expect(c.earlyMessages.has('new')).to.equal(true);
        clock.restore();
    });

    it('_drainEarlyMessages is a no-op when nothing is buffered', function () {
        expect(() => c._drainEarlyMessages('none')).to.not.throw();
    });
});

describe('AttestationConsensus: propose() guards', function () {

    let me, hub, c;
    beforeEach(() => {
        me  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    });
    afterEach(() => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID = 'ab'.repeat(16);

    it('returns immediately if the request is already finalized', async function () {
        c._markFinalized(RID);
        await c.propose(RID, roundState(me, [me], Buffer.from('b'), 'http_get', 1));
        expect(c.pending.has(RID)).to.equal(false);
    });

    it('returns immediately if a round for the request is already pending', async function () {
        c.pending.set(RID, { timer: null });
        await c.propose(RID, roundState(me, [me], Buffer.from('b'), 'http_get', 1));
        // Untouched sentinel: propose bailed before overwriting it.
        expect(c.pending.get(RID)).to.deep.equal({ timer: null });
    });

    it('creates a round but does not advance when there is no identity (no own proposal)', async function () {
        c.identity = null;
        await c.propose(RID, roundState(me, [me, mkIdentity()], Buffer.from('b'), 'http_get', 2));
        await flush();
        let p = c.pending.get(RID);
        expect(p).to.exist;
        expect(p.winner).to.equal(null);
        expect(p.proposals.size).to.equal(0);
        // Still broadcast a PROPOSE (with null sig_pubkey).
        let propose = hub._peerManager.broadcast.getCalls().find(call => call.args[0] === 'ATTEST_PROPOSE');
        expect(propose).to.exist;
    });

    it('drops a stalled (never-finalized) round when its timeout fires', async function () {
        let clock = sinon.useFakeTimers();
        c.roundTimeoutMs = 1000;
        // Redundancy 3 with only our own proposal → never advances to a winner.
        await c.propose(RID, roundState(me, [me, mkIdentity(), mkIdentity()], Buffer.from('b'), 'http_get', 3));
        c.earlyCommits.set(RID, []); // confirm the timeout also clears the early-commit queue
        expect(c.pending.has(RID)).to.equal(true);
        clock.tick(1001);
        expect(c.pending.has(RID)).to.equal(false);
        expect(c.earlyCommits.has(RID)).to.equal(false);
        clock.restore();
    });
});

describe('AttestationConsensus: single-validator round finalizes end-to-end', function () {

    let me, hub, c, finalized;
    beforeEach(() => {
        me  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
        finalized = [];
        c.on('request:finalized', e => finalized.push(e));
    });
    afterEach(() => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    it('proposes, prepares, commits, and emits request:finalized', async function () {
        const RID  = 'cd'.repeat(16);
        const body = Buffer.from('the-answer');
        await c.propose(RID, roundState(me, [me], body, 'http_get', 1));
        await flush();

        expect(finalized).to.have.length(1);
        expect(finalized[0].requestId).to.equal(RID);
        expect(finalized[0].providerId).to.equal('http_get');
        expect(finalized[0].responseBody.toString()).to.equal('the-answer');
        expect(finalized[0].status).to.equal('ok');
        expect(finalized[0].role).to.equal('leader');
        expect(finalized[0].signatures).to.have.length(1);
        expect(finalized[0].signatures[0].pubkey).to.equal(pub(me));

        // Broadcast all three PBFT phases.
        let types = hub._peerManager.broadcast.getCalls().map(call => call.args[0]);
        expect(types).to.include.members(['ATTEST_PROPOSE', 'ATTEST_PREPARE', 'ATTEST_COMMIT']);

        // Marked finalized; re-proposing the same RID is a no-op.
        expect(c.finalized.has(RID)).to.equal(true);
    });
});

describe('AttestationConsensus: three-validator round finalizes via peer votes', function () {

    let me, p1, p2, hub, c, finalized;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
        finalized = [];
        c.on('request:finalized', e => finalized.push(e));
    });
    afterEach(() => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID  = 'ef'.repeat(16);
    const BODY = Buffer.from('consensus-body');

    it('collects PROPOSE → PREPARE → COMMIT from all three responsible validators', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.equal(null); // only my proposal so far (1 of 3)

        // Peer proposals arrive → 3 proposals → agree() picks a winner.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, BODY));
        await flush();
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal('consensus-body');
        // All three matched the winner → three collected signatures.
        expect(pending.signatures.size).to.equal(3);

        // Peer prepares → prepare quorum (3) → we broadcast COMMIT.
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, BODY));
        expect(pending.prepares.size).to.equal(3);

        // Peer commits → commit quorum (3) → finalize.
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'http_get', p1, BODY));
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'http_get', p2, BODY));
        await flush();

        expect(finalized).to.have.length(1);
        expect(finalized[0].signatures).to.have.length(3);
    });

    it('ignores PROPOSEs from validators outside the responsible set', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let outsider = mkIdentity();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', outsider, BODY));
        expect(c.pending.get(RID).proposals.has(pub(outsider))).to.equal(false);
    });

    it('rejects a PROPOSE with a bad signature', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let env = signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY);
        env.data.sig = 'ff'.repeat(64); // valid hex, wrong signature
        c._handleMessage(env);
        expect(c.pending.get(RID).proposals.has(pub(p1))).to.equal(false);
    });

    it('dedups repeated PROPOSEs from the same peer', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let env = signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY);
        c._handleMessage(env);
        c._handleMessage(env);
        // me + p1 only (deduped); p2 absent.
        expect(c.pending.get(RID).proposals.size).to.equal(2);
    });

    it('rejects an oversized PROPOSE body before decoding', async function () {
        // Tiny per-provider cap so a normal body trips the guard.
        c.providerRegistry = makeRealProviderRegistry((proposals) => proposals[0], 'byte_equality', 4);
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let big = signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, Buffer.from('way-too-large-body'));
        c._handleMessage(big);
        expect(c.pending.get(RID).proposals.has(pub(p1))).to.equal(false);
    });

    it('buffers a PROPOSE that arrives before the round starts and drains it in propose()', async function () {
        // Early PROPOSE from p1: no pending yet, buffered.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        expect(c.earlyMessages.get(RID)).to.have.lengthOf(1);
        // Now start our round → drain replays p1's vote.
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        expect(c.pending.get(RID).proposals.has(pub(p1))).to.equal(true);
        expect(c.earlyMessages.has(RID)).to.equal(false);
    });
});

describe('AttestationConsensus: PREPARE signatures verified against the winner (#3949)', function () {

    let me, p1, p2, hub, c;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    });
    afterEach(() => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID = 'cd'.repeat(16);

    // Seed a round already past PROPOSE→agree with a locked winner. quorum is
    // set deliberately high so a couple of PREPAREs don't reach commit quorum,
    // letting us observe pending.signatures membership directly.
    function seedWithWinner(responsibleIds, winnerBody) {
        let pending = {
            requestId:   RID,
            request:     { block_index: 0 },   // prod always sets this; the EQUIV gate reads request.block_index
            providerId:  'http_get',
            redundancy:  responsibleIds.length,
            quorum:      responsibleIds.length + 1, // unreachable here
            responsible: responsibleIds.map(i => ({ pubkey: pub(i) })),
            proposals:   new Map(),
            prepares:    new Set(),
            commits:     new Set(),
            signatures:  new Map(),
            winner:      { body: winnerBody, meta: '' },
            status:      'ok',
            finalized:   false,
            myPubkey:    null,
            timer:       null
        };
        c.pending.set(RID, pending);
        return pending;
    }

    it('does NOT count a PREPARE signature taken over a divergent body', function () {
        let WINNER  = Buffer.from('winner-body');
        let pending = seedWithWinner([p1, p2], WINNER);
        // p1's signature is valid, but over ITS OWN divergent body, not the winner.
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, Buffer.from('divergent-body')));
        expect(pending.signatures.has(pub(p1))).to.equal(false);
        expect(pending.signatures.size).to.equal(0);
        // The PREPARE participation is still recorded (mirrors _handleCommit).
        expect(pending.prepares.has(pub(p1))).to.equal(true);
    });

    it('DOES count a PREPARE signature taken over the winner body', function () {
        let WINNER  = Buffer.from('winner-body');
        let pending = seedWithWinner([p1, p2], WINNER);
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, WINNER));
        expect(pending.signatures.has(pub(p2))).to.equal(true);
        expect(pending.signatures.size).to.equal(1);
        // And the stored signature actually verifies over the winner bytes.
        let canon = buildCanonical(RID, 'http_get', WINNER, 'ok', '');
        expect(ValidatorIdentity.verify(canon.toString('utf8'), pending.signatures.get(pub(p2)), pub(p2))).to.equal(true);
    });

    it('finalizes a round carrying ONLY winner-body signatures when a peer PREPAREs a divergent body', async function () {
        // redundancy 2 over [me,p1,p2]: winner sets after me+p1 propose the same
        // BODY; p2 then PREPAREs a divergent body whose sig must be excluded.
        let BODY = Buffer.from('agreed-body');
        let finalized = [];
        c.on('request:finalized', e => finalized.push(e));
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 2));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner.body.toString()).to.equal('agreed-body');
        expect(pending.signatures.size).to.equal(2); // me + p1, both over BODY

        // p2 PREPAREs a DIVERGENT body (validly signed over its own bytes).
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, Buffer.from('p2-divergent')));
        await flush();
        // Prepare quorum (2) reached via me+p2 → COMMIT → commit quorum on the
        // 2 winner-body sigs → finalize. p2's divergent sig must be absent.
        expect(finalized).to.have.length(1);
        expect(pending.signatures.has(pub(p2))).to.equal(false);
        let canon = buildCanonical(RID, 'http_get', BODY, 'ok', '');
        for (let s of finalized[0].signatures) {
            expect(ValidatorIdentity.verify(canon.toString('utf8'), s.sig, s.pubkey)).to.equal(true);
        }
    });
});

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () {

    let me, p1, p2, hub, c;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
    });
    afterEach(() => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID  = 'b2'.repeat(16);
    const BODY = Buffer.from('body');

    it('a non-leader does NOT run agree() (waits to adopt the leader PREPARE)', async function () {
        let agreeSpy = sinon.spy(proposals => proposals[0]);
        c = new AttestationConsensus(hub, makeRealProviderRegistry(agreeSpy, 'judge_model'));
        let rs = roundState(me, [me, p1, p2], BODY, 'llm', 2);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';   // p1 is the elected leader
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, Buffer.from('p1-body')));
        await flush();
        let pending = c.pending.get(RID);
        expect(agreeSpy.called).to.equal(false);
        expect(pending.winner).to.equal(null);
    });

    it('the elected leader DOES run agree() and sets the winner', async function () {
        let agreeSpy = sinon.spy(proposals => proposals[0]);
        c = new AttestationConsensus(hub, makeRealProviderRegistry(agreeSpy, 'judge_model'));
        // roundState() makes `me` the leader by default.
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'llm', 2));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, BODY));
        await flush();
        let pending = c.pending.get(RID);
        expect(agreeSpy.called).to.equal(true);
        expect(pending.winner).to.not.equal(null);
    });

    it('threads the round-snapshotted pinnedJudgeModel into agree() (immune to module JUDGE_MODEL drift)', async function () {
        let agreeSpy = sinon.spy(proposals => proposals[0]);
        c = new AttestationConsensus(hub, makeRealProviderRegistry(agreeSpy, 'judge_model'));
        // roundState() makes `me` the leader. AttestationRound snapshots the judge
        // model at round start; a later governance hotReload of the module-mutable
        // JUDGE_MODEL must not change what THIS round judges with.
        let rs = roundState(me, [me, p1, p2], BODY, 'llm', 2);
        rs.pinnedJudgeModel = 'claude-opus-4-7';
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, BODY));
        await flush();
        expect(agreeSpy.called).to.equal(true);
        expect(agreeSpy.firstCall.args[1]).to.deep.equal({ pinnedJudgeModel: 'claude-opus-4-7' });
    });

    it('a follower converges by adopting + re-signing the leader\'s winning body', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(p => p[0], 'judge_model'));
        let myBody = Buffer.from('my-own-divergent-body');
        let rs = roundState(me, [me, p1], myBody, 'llm', 2);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.equal(null);   // did not self-resolve

        let leaderBody = Buffer.from('leader-winning-body');
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, leaderBody));
        expect(pending.winner.body.toString()).to.equal('leader-winning-body');
        // Our own vote is re-signed over the agreed (leader) bytes.
        expect(pending.signatures.has(pub(me))).to.equal(true);
        let canon = buildCanonical(RID, 'llm', leaderBody, 'ok', '');
        expect(ValidatorIdentity.verify(canon.toString('utf8'), pending.signatures.get(pub(me)), pub(me))).to.equal(true);
    });

    it('a Byzantine non-leader PREPARE arriving FIRST does not set the winner (#4195)', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(p => p[0], 'judge_model'));
        let rs = roundState(me, [me, p1, p2], Buffer.from('my-body'), 'llm', 2);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';   // p1 leader; p2 = Byzantine non-leader
        await c.propose(RID, rs);
        await flush();
        let pending = c.pending.get(RID);

        // p2 (responsible but NOT the leader) races a divergent body in first.
        // It must be buffered, not adopted as the winner.
        let byzBody = Buffer.from('byzantine-divergent-body');
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p2, byzBody));
        expect(pending.winner, 'a non-leader judge_model PREPARE must not set the winner').to.equal(null);

        // The leader's PREPARE establishes the real winner; the buffered Byzantine
        // PREPARE then replays and is verified over the CANONICAL WINNER, so its
        // signature (taken over a divergent body) cannot be credited.
        let leaderBody = Buffer.from('leader-winning-body');
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, leaderBody));
        await flush();
        expect(pending.winner.body.toString(), 'winner is the leader body').to.equal('leader-winning-body');

        if (pending.signatures.has(pub(p2))) {
            let winnerCanon = buildCanonical(RID, 'llm', leaderBody, 'ok', '');
            expect(ValidatorIdentity.verify(winnerCanon.toString('utf8'), pending.signatures.get(pub(p2)), pub(p2)),
                'a stored p2 signature must verify over the winner, never the Byzantine body').to.equal(true);
        }
        // The round never adopted the Byzantine body as winner.
        expect(pending.winner.body.toString()).to.not.equal('byzantine-divergent-body');
    });
});

// Regression for commit 128e849: in a judge_model round with N>=3 responsible
// workers the LEADER broadcasts its PREPARE but followers never ran agree() and
// never re-broadcast their own PREPARE, so prepares.size stalled at 1 (leader
// only) and PREPARE-quorum (max(quorum, REDUNDANCY)) was never reached, deadlocking
// the round. The fix: when a follower adopts the leader's PREPARE it immediately
// re-broadcasts its own endorsing PREPARE over the canonical winner body.
describe('AttestationConsensus: judge_model multi-hub PREPARE-quorum (#128e849)', function () {

    let me, p1, p2, hub, c, finalized;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry(proposals => proposals[0], 'judge_model'));
        finalized = [];
        c.on('request:finalized', e => finalized.push(e));
    });
    afterEach(() => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID       = 'aa'.repeat(16);
    const MY_BODY   = Buffer.from('my-body');
    const P1_BODY   = Buffer.from('p1-body');  // leader body (byte-divergent per judge_model)
    const REDUNDANCY = 3;

    // Seed a follower round: me + p2 are workers; p1 is the elected leader.
    async function seedFollowerRound() {
        let rs = roundState(me, [me, p1, p2], MY_BODY, 'llm', REDUNDANCY);
        rs.leaderPubkey = pub(p1);
        rs.role         = 'follower';
        await c.propose(RID, rs);
        await flush();
        // p2 also proposes (byte-divergent per judge_model convention)
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, Buffer.from('p2-body')));
        await flush();
        return c.pending.get(RID);
    }

    it('a follower re-broadcasts ATTEST_PREPARE exactly once on leader adoption (128e849 fix)', async function () {
        await seedFollowerRound();

        let beforeCount = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;

        // Leader's PREPARE arrives and is adopted as winner.
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, P1_BODY));
        await flush();

        let prepBroadcasts = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE');
        // Exactly one new PREPARE broadcast (ours, endorsing the canonical winner).
        expect(prepBroadcasts.length - beforeCount).to.equal(1);
        let sent = prepBroadcasts[prepBroadcasts.length - 1].args[1];
        expect(sent.sig_pubkey).to.equal(pub(me));
        expect(Buffer.from(sent.body_b64, 'base64').toString()).to.equal(P1_BODY.toString());
    });

    it('prepares.size reaches max(quorum, REDUNDANCY) after leader + follower re-broadcasts', async function () {
        let pending = await seedFollowerRound();

        // Leader PREPARE (p1) arrives.
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, P1_BODY));
        // Follower p2 adopts the leader PREPARE and re-broadcasts its own.
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p2, P1_BODY));
        await flush();

        // Our own re-broadcast is counted locally (pending.prepares.add(myPubkey)
        // runs in _handlePrepare), so all three workers' PREPAREs are now counted.
        let needed = Math.max(pending.quorum, REDUNDANCY);
        expect(pending.prepares.size).to.be.at.least(needed);
    });

    it('a follower PREPARE arriving BEFORE the leader is buffered, not adopted as winner', async function () {
        let pending = await seedFollowerRound();

        // p2 (follower, not leader) races a PREPARE first.
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p2, Buffer.from('p2-early-body')));
        expect(pending.winner, 'follower PREPARE must not set winner before leader').to.equal(null);
        // Leader arrives; winner must be the leader body, not p2's.
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, P1_BODY));
        await flush();
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal(P1_BODY.toString());
    });

    it('byte_equality round is unaffected: no extra re-broadcast', async function () {
        // Replace the provider registry with a byte_equality one.
        c = new AttestationConsensus(hub, makeRealProviderRegistry(proposals => proposals[0], 'byte_equality'));
        c.on('request:finalized', e => finalized.push(e));
        const BODY = Buffer.from('shared-body');
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', REDUNDANCY));
        await flush();
        let prepBefore = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;

        // Simulate leader PREPARE (p1) arriving at our byte_equality follower.
        c._handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        await flush();

        let prepAfter = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;
        // byte_equality: we already broadcast our own PREPARE from _maybeAdvanceFromProposals;
        // handling a peer PREPARE must NOT trigger a second re-broadcast.
        expect(prepAfter - prepBefore).to.equal(0);
    });
});

describe('AttestationConsensus: _maybeAdvanceFromProposals consensus outcomes', function () {

    let me, p1, p2, hub, c;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
    });
    afterEach(() => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID  = 'a1'.repeat(16);
    const BODY = Buffer.from('body');

    async function seedThreeProposals(reg) {
        c = new AttestationConsensus(hub, reg);
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, BODY));
        await flush();
        return c.pending.get(RID);
    }

    it('does not advance when the provider exposes no agree()', async function () {
        let reg = makeRealProviderRegistry();
        reg.getModule.returns(null);
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.equal(null);
    });

    it('escalates a thrown agree() to a no_quorum outcome (Phase 4)', async function () {
        let reg = makeRealProviderRegistry(() => { throw new Error('judge model down'); });
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.length).to.equal(0);
        expect(pending.winner.meta).to.equal('');
        expect(pending.status).to.equal('no_quorum');
    });

    it('escalates a null agree() result to a no_quorum outcome (Phase 4)', async function () {
        let reg = makeRealProviderRegistry(() => null);
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.length).to.equal(0);
        expect(pending.winner.meta).to.equal('');
        expect(pending.status).to.equal('no_quorum');
    });

    it('supports an async agree() (judge_model style)', async function () {
        let reg = makeRealProviderRegistry(async (proposals) => proposals[0], 'judge_model');
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.not.equal(null);
    });

    it('records a slash candidate for a byte_equality divergence', async function () {
        hub.slashDetector = { recordAttestationDivergence: sinon.stub().resolves() };
        c = new AttestationConsensus(hub, makeRealProviderRegistry());
        // Two agree on BODY, one (p2) diverges.
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, Buffer.from('different')));
        await flush();

        expect(hub.slashDetector.recordAttestationDivergence.calledOnce).to.equal(true);
        let args = hub.slashDetector.recordAttestationDivergence.firstCall.args;
        expect(args[0]).to.equal(pub(p2)); // the divergent validator
        expect(args[2]).to.equal('http_get');
    });
});

describe('AttestationConsensus: _handlePrepare adoption + guards', function () {

    let me, p1, p2, hub, c;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    });
    afterEach(() => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID  = 'b2'.repeat(16);
    const BODY = Buffer.from('leader-body');

    it('adopts the leader body as the winner from a PREPARE when none is set yet', async function () {
        // redundancy 3 so propose() does not establish a winner from one proposal.
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.equal(null);

        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal('leader-body');
        // My own matching proposal contributes its signature on adoption.
        expect(pending.signatures.has(pub(me))).to.equal(true);
        expect(pending.prepares.has(pub(p1))).to.equal(true);
    });

    it('buffers a PREPARE that arrives before the round exists', function () {
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        expect(c.earlyMessages.get(RID)).to.have.lengthOf(1);
    });

    it('ignores a PREPARE from outside the responsible set', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let outsider = mkIdentity();
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', outsider, BODY));
        expect(c.pending.get(RID).prepares.has(pub(outsider))).to.equal(false);
    });

    it('rejects a PREPARE with a bad signature', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let env = signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY);
        env.data.sig = 'ee'.repeat(64);
        c._handleMessage(env);
        expect(c.pending.get(RID).prepares.has(pub(p1))).to.equal(false);
    });

    it('rejects an unsigned PREPARE in the no-winner path (item 4559: must not set the winner)', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let env = signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY);
        delete env.data.sig; // unsigned: must not establish the winner or count as a vote
        c._handleMessage(env);
        let pending = c.pending.get(RID);
        expect(pending.prepares.has(pub(p1))).to.equal(false);
        expect(pending.signatures.has(pub(p1))).to.equal(false);
        expect(!!pending.winner).to.equal(false);
    });

    it('rejects an oversized PREPARE body before decoding', async function () {
        c.providerRegistry = makeRealProviderRegistry((p) => p[0], 'byte_equality', 4);
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let big = signEnv('ATTEST_PREPARE', RID, 'http_get', p1, Buffer.from('way-too-large-body'));
        c._handleMessage(big);
        expect(c.pending.get(RID).prepares.has(pub(p1))).to.equal(false);
    });
});

describe('AttestationConsensus: _handleCommit signed verification', function () {

    let me, p1, p2, hub, c;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    });
    afterEach(() => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    const RID  = 'c3'.repeat(16);
    const BODY = Buffer.from('committed-body');

    async function seedWithWinner() {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, BODY));
        await flush();
        return c.pending.get(RID);
    }

    it('records a valid COMMIT signature and counts the vote', async function () {
        let pending = await seedWithWinner();
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'http_get', p1, BODY));
        expect(pending.commits.has(pub(p1))).to.equal(true);
        expect(pending.signatures.has(pub(p1))).to.equal(true);
    });

    it('counts a COMMIT vote even when its signature fails to verify', async function () {
        let pending = await seedWithWinner();
        // Drop p2's collected sig so we can prove a bad COMMIT sig is not stored.
        pending.signatures.delete(pub(p2));
        let env = signEnv('ATTEST_COMMIT', RID, 'http_get', p2, BODY);
        env.data.sig = 'dd'.repeat(64);
        c._handleMessage(env);
        expect(pending.commits.has(pub(p2))).to.equal(true);
        expect(pending.signatures.has(pub(p2))).to.equal(false);
    });

    it('ignores a COMMIT from outside the responsible set', async function () {
        let pending = await seedWithWinner();
        let outsider = mkIdentity();
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'http_get', outsider, BODY));
        expect(pending.commits.has(pub(outsider))).to.equal(false);
    });
});

describe('AttestationConsensus: message guards & internal early-returns', function () {

    let me, p1, hub, c;
    const BODY = Buffer.from('b');
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    });
    afterEach(() => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    ['ATTEST_PROPOSE', 'ATTEST_PREPARE', 'ATTEST_COMMIT'].forEach(function (type) {
        it(type + ': ignores an envelope with no data', function () {
            expect(() => c._handleMessage({ type })).to.not.throw();
            expect(c.earlyMessages.size).to.equal(0);
        });
        it(type + ': ignores an envelope with no requestId', function () {
            c._handleMessage({ type, data: {} });
            expect(c.earlyMessages.size).to.equal(0);
        });
        it(type + ': ignores a message for an already-finalized request', function () {
            let rid = '1a'.repeat(16);
            c._markFinalized(rid);
            c._handleMessage({ type, data: { requestId: rid, sig_pubkey: pub(p1) } });
            expect(c.earlyMessages.has(rid)).to.equal(false);
            expect(c.pending.has(rid)).to.equal(false);
        });
    });

    it('_handlePropose ignores a proposal carrying no sig_pubkey', async function () {
        let rid = '2b'.repeat(16);
        await c.propose(rid, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        let before = c.pending.get(rid).proposals.size;
        c._handleMessage({ type: 'ATTEST_PROPOSE', data: { requestId: rid, body_b64: '', sig: 'x' } });
        expect(c.pending.get(rid).proposals.size).to.equal(before);
    });

    it('_maybeAdvanceFromProposals returns for an unknown request', async function () {
        await c._maybeAdvanceFromProposals('does-not-exist'); // !pending guard
    });

    it('_maybeAdvanceFromProposals returns when a winner already exists', async function () {
        c.pending.set('z', { finalized: false, winner: { body: Buffer.from('x'), meta: '' } });
        await c._maybeAdvanceFromProposals('z'); // winner guard
    });

    it('_checkPrepareQuorum returns early when no winner is set', function () {
        c.pending.set('z', { winner: null, finalized: false, prepares: new Set(), quorum: 1, redundancy: 1 });
        expect(() => c._checkPrepareQuorum('z')).to.not.throw();
    });

    it('_checkPrepareQuorum returns early when a commit was already sent', function () {
        c.pending.set('z', { winner: {}, finalized: false, _commitSent: true, prepares: new Set() });
        expect(() => c._checkPrepareQuorum('z')).to.not.throw();
    });

    it('_checkCommitQuorum returns early for a finalized round', function () {
        c.pending.set('z', { finalized: true });
        expect(() => c._checkCommitQuorum('z')).to.not.throw();
    });

    it('constructor tolerates a hub without getIdentity / p2pConfig', function () {
        let bare = new AttestationConsensus({ getPeerManager: () => null, db: {} }, makeRealProviderRegistry());
        expect(bare.identity).to.equal(null);
        expect(bare.config).to.deep.equal({});
    });

    it('_maybeAdvanceFromProposals returns when an agree() is already in flight', async function () {
        c.pending.set('z', { finalized: false, winner: null, _agreeing: true });
        await c._maybeAdvanceFromProposals('z'); // _agreeing guard
    });

    it('abandons the round if it is pruned while agree() is awaiting', async function () {
        const RID = '4d'.repeat(16);
        // Async agree() deletes the round mid-flight, modelling a timeout firing
        // during the judge_model API call.
        c.providerRegistry = makeRealProviderRegistry(async (proposals) => {
            c.pending.delete(RID);
            return proposals[0];
        });
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        // Round was deleted; no winner survived, no throw.
        expect(c.pending.has(RID)).to.equal(false);
    });

    it('applies field defaults when a PROPOSE omits meta/status (sig still matches)', async function () {
        const RID = '5e'.repeat(16);
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        // signEnv signs with status 'ok' + meta '' ; deleting them lets the
        // handler's `|| 'ok'` / `|| ''` defaults reproduce the signed canonical.
        let env = signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY);
        delete env.data.meta;
        delete env.data.status;
        c._handleMessage(env);
        expect(c.pending.get(RID).proposals.has(pub(p1))).to.equal(true);
    });

    it('applies field defaults when a PREPARE omits meta/status', async function () {
        const RID = '6f'.repeat(16);
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        let env = signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY);
        delete env.data.meta;
        delete env.data.status;
        c._handleMessage(env);
        expect(c.pending.get(RID).prepares.has(pub(p1))).to.equal(true);
    });

    it('broadcasts an empty body_b64 when our own proposal has no body', async function () {
        const RID = '7a'.repeat(16);
        // A null body makes _signCanonical throw→null and myBody falsy.
        await c.propose(RID, roundState(me, [me, p1], null, 'http_get', 2));
        await flush();
        let propose = hub._peerManager.broadcast.getCalls().find(call => call.args[0] === 'ATTEST_PROPOSE');
        expect(propose.args[1].body_b64).to.equal('');
        expect(c.pending.get(RID).proposals.size).to.equal(0); // own proposal not stored
    });

    it('rejects a PROPOSE with a missing signature', async function () {
        const RID = '8b'.repeat(16);
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        let env = signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY);
        delete env.data.sig;
        c._handleMessage(env);
        expect(c.pending.get(RID).proposals.has(pub(p1))).to.equal(false);
    });

    it('ignores a PREPARE with neither sig_pubkey nor body_b64', async function () {
        const RID = '9c'.repeat(16);
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        c._handleMessage({ type: 'ATTEST_PREPARE', data: { requestId: RID } });
        expect(c.pending.get(RID).prepares.size).to.equal(0);
    });

    it('ignores a COMMIT with no sig_pubkey', function () {
        const RID = '1d'.repeat(16);
        let pending = {
            requestId: RID, providerId: 'http_get', responsible: [{ pubkey: pub(p1) }],
            winner: { body: BODY, meta: '' }, status: 'ok', commits: new Set(),
            signatures: new Map(), finalized: false, quorum: 1, redundancy: 2, prepares: new Set()
        };
        c.pending.set(RID, pending);
        c._handleMessage({ type: 'ATTEST_COMMIT', data: { requestId: RID, body_b64: BODY.toString('base64') } });
        expect(pending.commits.size).to.equal(0);
    });

    it('does NOT finalize a byte_equality round when our body genuinely diverges (only one valid sig)', async function () {
        const RID   = '3c'.repeat(16);
        const MINE  = Buffer.from('my-body');
        const OTHER = Buffer.from('peer-body');
        let finalized = [];
        c.on('request:finalized', e => finalized.push(e));
        // agree() picks the peer's (divergent) body as the winner.
        c.providerRegistry = makeRealProviderRegistry((proposals) =>
            proposals.find(p => p.body.toString() === 'peer-body'));

        await c.propose(RID, roundState(me, [me, p1], MINE, 'http_get', 2));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, OTHER));
        await flush();

        let pending = c.pending.get(RID);
        expect(pending.winner.body.toString()).to.equal('peer-body');
        // Our proposal diverged under byte_equality → we hold no signature for
        // the winning body, and (correctly) we do NOT re-sign it: a byte
        // divergence is a genuine disagreement, not a semantic one.
        expect(pending.signatures.has(pub(me))).to.equal(false);

        // Peer's PREPARE + COMMIT over the winner give exactly ONE valid sig.
        // needed = max(quorum=2, redundancy=2) = 2, so the round must NOT
        // finalize on participation alone; emitting a 1-sig payload here is the
        // F-2 defect. The round falls through to deadline expiry instead.
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, OTHER));
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'http_get', p1, OTHER));
        await flush();
        expect(pending.signatures.size).to.equal(1);
        expect(finalized).to.have.length(0);
    });
});

describe('AttestationConsensus: judge_model re-signs the canonical winner', function () {

    let me, p1, p2, hub, c, finalized;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        finalized = [];
    });
    afterEach(() => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    // judge_model registry whose agree() picks the proposal whose body matches
    // `winnerText`: modelling the judge selecting one of N byte-divergent but
    // semantically-equivalent proposals as canonical.
    function judgeRegistry(winnerText) {
        return makeRealProviderRegistry(
            (proposals) => proposals.find(p => p.body.toString() === winnerText),
            'judge_model'
        );
    }

    it('redundancy=3: every responsible validator re-signs the judge-selected body so the round finalizes with REDUNDANCY sigs', async function () {
        const RID    = 'd4'.repeat(16);
        const MINE   = Buffer.from('answer-alpha');   // my divergent body
        const P1BODY = Buffer.from('answer-beta');    // judge picks THIS one
        const P2BODY = Buffer.from('answer-gamma');   // p2's divergent body
        const WINNER = P1BODY;

        c = new AttestationConsensus(hub, judgeRegistry('answer-beta'));
        c.on('request:finalized', e => finalized.push(e));

        // me proposes its own (divergent) body.
        await c.propose(RID, roundState(me, [me, p1, p2], MINE, 'llm', 3));
        await flush();

        // Peers propose their own divergent bodies → 3 proposals → judge_model
        // agree() selects p1's body as canonical.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, P1BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, P2BODY));
        await flush();

        let pending = c.pending.get(RID);
        expect(pending.winner.body.toString()).to.equal('answer-beta');

        // THE FIX: even though my body diverged from the winner, I re-signed the
        // canonical winning body; so I hold a verifying signature for it.
        expect(pending.signatures.has(pub(me))).to.equal(true);
        let myCanonical = buildCanonical(RID, 'llm', WINNER, 'ok', '').toString('utf8');
        expect(ValidatorIdentity.verify(myCanonical, pending.signatures.get(pub(me)), pub(me))).to.equal(true);

        // Peers re-sign the winner too and contribute it on PREPARE/COMMIT.
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'llm', p1, WINNER));
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'llm', p2, WINNER));
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'llm', p1, WINNER));
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'llm', p2, WINNER));
        await flush();

        // Three genuine signatures over the single canonical body → finalizes,
        // and the on-chain response carries exactly REDUNDANCY (3) signatures.
        expect(pending.signatures.size).to.equal(3);
        expect(finalized).to.have.length(1);
        expect(finalized[0].responseBody.toString()).to.equal('answer-beta');
        expect(finalized[0].signatures).to.have.length(3);
        let pubkeys = finalized[0].signatures.map(s => s.pubkey).sort();
        expect(pubkeys).to.deep.equal([pub(me), pub(p1), pub(p2)].sort());
        // Every emitted signature verifies against the canonical winner.
        let canonical = buildCanonical(RID, 'llm', WINNER, 'ok', '').toString('utf8');
        for (let s of finalized[0].signatures) {
            expect(ValidatorIdentity.verify(canonical, s.sig, s.pubkey)).to.equal(true);
        }
    });

    it('redundancy=1: single-validator judge_model still finalizes with one valid signature', async function () {
        const RID  = 'e5'.repeat(16);
        const BODY = Buffer.from('the-only-answer');
        c = new AttestationConsensus(hub, judgeRegistry('the-only-answer'));
        c.on('request:finalized', e => finalized.push(e));

        await c.propose(RID, roundState(me, [me], BODY, 'llm', 1));
        await flush();

        expect(finalized).to.have.length(1);
        expect(finalized[0].signatures).to.have.length(1);
        expect(finalized[0].signatures[0].pubkey).to.equal(pub(me));
        let canonical = buildCanonical(RID, 'llm', BODY, 'ok', '').toString('utf8');
        expect(ValidatorIdentity.verify(canonical, finalized[0].signatures[0].sig, pub(me))).to.equal(true);
    });
});

// ---- Non-ok outcomes: Phase 4 status publication --------------------------

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () {

    const RID  = 'e2'.repeat(16);
    const BODY = Buffer.from('payload');
    const EMPTY = Buffer.alloc(0);

    let me, p1, p2, hub, c;
    beforeEach(() => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
    });
    afterEach(() => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    function errorRoundState(id, responsibleIds, redundancy) {
        let rs = roundState(id, responsibleIds, EMPTY, 'llm', redundancy);
        rs.myProposal = { body: EMPTY, meta: '', status: 'provider_error' };
        return rs;
    }

    it('an all-error round converges on a provider_error winner and finalizes', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(null, 'judge_model'));
        let finalized = [];
        c.on('request:finalized', ev => finalized.push(ev));

        await c.propose(RID, errorRoundState(me, [me, p1, p2], 3));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, EMPTY, '', 'provider_error'));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, EMPTY, '', 'provider_error'));
        await flush();

        let pending = c.pending.get(RID);
        expect(pending.status).to.equal('provider_error');
        expect(pending.winner.body.length).to.equal(0);
        // All three error PROPOSEs signed the identical canonical, so their
        // sigs transfer to the winner without any re-signing round-trip.
        expect(pending.signatures.size).to.equal(3);

        // Peers' COMMITs land; the round finalizes with the non-ok status.
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'llm', p1, EMPTY, '', 'provider_error'));
        c._handleMessage(signEnv('ATTEST_COMMIT', RID, 'llm', p2, EMPTY, '', 'provider_error'));
        await flush();
        expect(finalized.length).to.equal(1);
        expect(finalized[0].status).to.equal('provider_error');
        expect(finalized[0].signatures.length).to.equal(3);
    });

    it('a non-ok finalization stays retryable: rid is NOT marked finalized', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(null, 'judge_model'));
        await c.propose(RID, errorRoundState(me, [me], 1));
        await flush();
        expect(c.finalized.has(RID)).to.equal(false);
        expect(c.nonOkPublished.get(RID)).to.exist;
        expect(c.nonOkPublished.get(RID).has('provider_error')).to.equal(true);
        // A later retry round may start again for the same rid.
        c.pending.delete(RID);
        await c.propose(RID, errorRoundState(me, [me], 1));
        expect(c.pending.has(RID)).to.equal(true);
    });

    it('throttles: the same non-ok status is not established twice for one rid', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(null, 'judge_model'));
        let finalized = [];
        c.on('request:finalized', ev => finalized.push(ev));
        await c.propose(RID, errorRoundState(me, [me], 1));
        await flush();
        expect(finalized.length).to.equal(1);
        // Retry round with the provider still down: winner must stay null.
        c.pending.delete(RID);
        await c.propose(RID, errorRoundState(me, [me], 1));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.equal(null);
        expect(finalized.length).to.equal(1);
    });

    it('an ok retry after a published non-ok still finalizes normally', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry((proposals) => proposals[0], 'judge_model'));
        let finalized = [];
        c.on('request:finalized', ev => finalized.push(ev));
        await c.propose(RID, errorRoundState(me, [me], 1));
        await flush();
        expect(finalized.length).to.equal(1);
        c.pending.delete(RID);
        await c.propose(RID, roundState(me, [me], BODY, 'llm', 1));
        await flush();
        expect(finalized.length).to.equal(2);
        expect(finalized[1].status).to.equal('ok');
        expect(c.finalized.has(RID)).to.equal(true);
    });

    it('a follower whose own fetch FAILED co-signs a provider_error PREPARE', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(null, 'judge_model'));
        // I am a follower (p1 is leader) with an error proposal of my own.
        let rs = errorRoundState(me, [p1, me, p2], 3);
        rs.leaderPubkey = pub(p1);
        rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        // Leader's provider_error PREPARE arrives before enough PROPOSEs.
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'llm', p1, EMPTY, '', 'provider_error'));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.exist;
        expect(pending.status).to.equal('provider_error');
        expect(pending.signatures.has(pub(me))).to.equal(true);
    });

    it('a follower whose own fetch SUCCEEDED abstains from a provider_error PREPARE', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(null, 'judge_model'));
        let rs = roundState(me, [p1, me, p2], BODY, 'llm', 3);
        rs.leaderPubkey = pub(p1);
        rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'llm', p1, EMPTY, '', 'provider_error'));
        await flush();
        let pending = c.pending.get(RID);
        // Adopts the deterministic outcome (sender's sig verified) but does
        // NOT vouch for an outage it has direct evidence against.
        expect(pending.status).to.equal('provider_error');
        expect(pending.signatures.has(pub(me))).to.equal(false);
        expect(pending.signatures.has(pub(p1))).to.equal(true);
    });

    it('rejects a non-ok PREPARE carrying a non-canonical (non-empty) body', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(null, 'judge_model'));
        let rs = errorRoundState(me, [p1, me], 3);
        rs.leaderPubkey = pub(p1);
        rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'llm', p1, Buffer.from('sneaky'), '', 'provider_error'));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.equal(null);
    });

    it('an honest provider_error proposal never accrues a byte_equality slash candidate', async function () {
        hub.slashDetector = { recordAttestationDivergence: sinon.stub().resolves() };
        c = new AttestationConsensus(hub, makeRealProviderRegistry());
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, EMPTY, '', 'provider_error'));
        await flush();
        expect(hub.slashDetector.recordAttestationDivergence.called).to.equal(false);
    });
});
