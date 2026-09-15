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
const AttestationConsensus = require('../../src/attestation/consensus');
const ValidatorIdentity    = require('../../src/validators/identity');
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
//
// pinnedConsensusStrategy travels ON the round state, exactly as AttestationRound
// resolves it: ONCE, from the BLOCK-ANCHORED provider history at the request's own
// block, never from the live registry at each decision site (a hotReload between two
// messages of one round would otherwise flip this hub's PBFT state machine). Defaulted
// from the provider id against ProviderRegistry.DEFAULTS (http_get -> byte_equality,
// llm -> judge_model) so a fixture cannot pin a strategy its provider does not have;
// pass `strategy` to model a governance change that moved it.
function roundState(me, responsibleIds, body, providerId, redundancy, meta, strategy) {
    return {
        request:      { request_id: 'req' },
        providerId,
        redundancy,
        snapshot:     {},
        responsible:  responsibleIds.map(i => ({ pubkey: pub(i) })),
        leaderPubkey: pub(me),
        role:         'leader',
        myProposal:   { body, meta: meta || '' },
        pinnedConsensusStrategy: strategy || (providerId === 'llm' ? 'judge_model' : 'byte_equality')
    };
}

// Regression for commit 128e849: in a judge_model round with N>=3 responsible
// workers the LEADER broadcasts its PREPARE but followers never ran agree() and
// never re-broadcast their own PREPARE, so prepares.size stalled at 1 (leader
// only) and PREPARE-quorum (max(quorum, REDUNDANCY)) was never reached, deadlocking
// the round. The fix: when a follower adopts the leader's PREPARE it immediately
// re-broadcasts its own endorsing PREPARE over the canonical winner body.

// ---- Non-ok outcomes: Phase 4 status publication --------------------------

// ---- Validator-sec R2 hardening: A-F1 / A-F4 / A-F5 (attestation half) ----

// ---- byte_equality no_quorum hardening + replay guards (items 2640/2641/2579/2642) ----

// item 3421: the nonOkPublished ring cap is a fixed operator/env value chosen once at
// startup, but the horizon it has to clear is max(deadline_window_blocks) across the
// provider defs, which is governance-controlled JSON that nothing upper-bounds. A
// proposal widening that window once invalidated the documented sizing floor in
// silence, with the first symptom being evictions that had already re-burned BTC fees
// on retry rounds. The check is log-only on purpose: an undersized ring wastes fees,
// it does not fork, so refusing to run would be the worse failure.

{
let me, p1, p2, hub, c, finalized;

const hookAt53313 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry(proposals => proposals[0], 'judge_model'));
        finalized = [];
        c.on('request:finalized', e => finalized.push(e));
    };

const hookAt53671 = () => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

const RID       = 'aa'.repeat(16);

const MY_BODY   = Buffer.from('my-body');

const P1_BODY   = Buffer.from('p1-body');

// leader body (byte-divergent per judge_model)
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
        // The leader's PROPOSE always precedes its PREPARE on the wire; A-F1
        // requires the follower to hold it so the winner can be hash-checked.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, P1_BODY));
        await flush();
        return c.pending.get(RID);
    }

describe('AttestationConsensus: judge_model multi-hub PREPARE-quorum (#128e849)', function () { beforeEach(hookAt53313); afterEach(hookAt53671); it('a follower re-broadcasts ATTEST_PREPARE exactly once on leader adoption (128e849 fix)', async function () {
        await seedFollowerRound();

        let beforeCount = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;

        // Leader's PREPARE arrives and is adopted as winner.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, P1_BODY));
        await flush();

        let prepBroadcasts = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE');
        // Exactly one new PREPARE broadcast (ours, endorsing the canonical winner).
        expect(prepBroadcasts.length - beforeCount).to.equal(1);
        let sent = prepBroadcasts[prepBroadcasts.length - 1].args[1];
        expect(sent.sig_pubkey).to.equal(pub(me));
        expect(Buffer.from(sent.body_b64, 'base64').toString()).to.equal(P1_BODY.toString());
    }); });

describe('AttestationConsensus: judge_model multi-hub PREPARE-quorum (#128e849)', function () { beforeEach(hookAt53313); afterEach(hookAt53671); it('prepares.size reaches max(quorum, REDUNDANCY) after leader + follower re-broadcasts', async function () {
        let pending = await seedFollowerRound();

        // Leader PREPARE (p1) arrives.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, P1_BODY));
        // Follower p2 adopts the leader PREPARE and re-broadcasts its own.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p2, P1_BODY));
        await flush();

        // Our own re-broadcast is counted locally (pending.prepares.add(myPubkey)
        // runs in handlePrepare), so all three workers' PREPAREs are now counted.
        let needed = Math.max(pending.quorum, REDUNDANCY);
        expect(pending.prepares.size).to.be.at.least(needed);
    }); });

describe('AttestationConsensus: judge_model multi-hub PREPARE-quorum (#128e849)', function () { beforeEach(hookAt53313); afterEach(hookAt53671); it('a follower PREPARE arriving BEFORE the leader is buffered, not adopted as winner', async function () {
        let pending = await seedFollowerRound();

        // p2 (follower, not leader) races a PREPARE first.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p2, Buffer.from('p2-early-body')));
        expect(pending.winner, 'follower PREPARE must not set winner before leader').to.equal(null);
        // Leader arrives; winner must be the leader body, not p2's.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, P1_BODY));
        await flush();
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal(P1_BODY.toString());
    }); });

// byte_equality PREPARE-adoption (gossip reordering: a peer's PREPARE arrives
    // while we still hold fewer than `need` proposals, so we adopt before running
    // our own agree()). The adopt path must echo our own endorsing PREPARE and
    // self-add to prepares, or the winner-set early-return in
    // maybeAdvanceFromProposals silences this node for the whole round: every
    // responsible node then caps at R-1 prepares < max(quorum, REDUNDANCY), no
    // COMMIT is ever sent, and the round expires (permanent request loss).
describe('AttestationConsensus: judge_model multi-hub PREPARE-quorum (#128e849)', function () { beforeEach(hookAt53313); afterEach(hookAt53671); it('byte_equality adopt: echoes own PREPARE once + self-adds, so the round un-deadlocks', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(proposals => proposals[0], 'byte_equality'));
        c.on('request:finalized', e => finalized.push(e));
        const BODY = Buffer.from('shared-body');
        // Only OUR proposal is in (1 of 3 needed): winner is NOT yet set, so the
        // incoming peer PREPARE takes the adoption path.
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', REDUNDANCY));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner, 'pre-winner adopt window').to.equal(null);
        let prepBefore = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;

        // p1's PREPARE (byte-identical body) arrives first: adopted as winner.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        await flush();

        let prepBroadcasts = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE');
        expect(prepBroadcasts.length - prepBefore, 'exactly one endorsing echo').to.equal(1);
        let sent = prepBroadcasts[prepBroadcasts.length - 1].args[1];
        expect(sent.sig_pubkey).to.equal(pub(me));
        expect(Buffer.from(sent.body_b64, 'base64').toString()).to.equal(BODY.toString());
        expect(pending.prepares.has(pub(me)), 'self-vote recorded').to.equal(true);
        // Our stored signature verifies over the winner canonical.
        let canon = buildCanonical(RID, 'http_get', BODY, 'ok', '');
        expect(ValidatorIdentity.verify(canon.toString('utf8'), pending.signatures.get(pub(me)), pub(me))).to.equal(true);

        // p2's PREPARE lands: prepares = {me, p1, p2} reaches max(quorum, REDUNDANCY)
        // and the COMMIT goes out - the round no longer deadlocks to expiry.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, BODY));
        await flush();
        expect(pending.prepares.size).to.be.at.least(Math.max(pending.quorum, REDUNDANCY));
        expect(pending._commitSent, 'COMMIT sent after prepare-quorum').to.equal(true);

        // A further PREPARE re-delivery must NOT echo again (fires once per round).
        let prepAfterQuorum = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        await flush();
        let prepFinal = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;
        expect(prepFinal - prepAfterQuorum, 'no second echo').to.equal(0);
    }); });

describe('AttestationConsensus: judge_model multi-hub PREPARE-quorum (#128e849)', function () { beforeEach(hookAt53313); afterEach(hookAt53671); it('byte_equality adopt: a DIVERGENT own body still abstains (no echo, no self-sig)', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(proposals => proposals[0], 'byte_equality'));
        await c.propose(RID, roundState(me, [me, p1, p2], Buffer.from('my-divergent-body'), 'http_get', REDUNDANCY));
        await flush();
        let pending = c.pending.get(RID);
        let prepBefore = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;

        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, Buffer.from('winner-body')));
        await flush();

        let prepAfter = hub._peerManager.broadcast.getCalls()
            .filter(call => call.args[0] === 'ATTEST_PREPARE').length;
        expect(prepAfter - prepBefore, 'divergence is never papered over').to.equal(0);
        expect(pending.prepares.has(pub(me))).to.equal(false);
        expect(pending.signatures.has(pub(me))).to.equal(false);
    }); });
}
