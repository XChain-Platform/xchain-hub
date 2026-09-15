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
let me, p1, p2, hub, c;

const hookAt101470 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry(p => p[0], 'byte_equality'));
    };

const hookAt101731 = () => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

const RID = 'f6'.repeat(16);

describe('AttestationConsensus: A-F4 byte_equality winner needs own-match or corroboration', function () { beforeEach(hookAt101470); afterEach(hookAt101731); it('a single foreign PREPARE that diverges from our own body does NOT latch the winner', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], Buffer.from('honest-body'), 'http_get', 3));
        await flush();
        let pending = c.pending.get(RID);

        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, Buffer.from('byzantine-body')));
        await flush();
        expect(pending.winner, 'one uncorroborated divergent PREPARE must not wedge the round').to.equal(null);
        expect(pending.signatures.has(pub(p1)), 'its sig is held as a candidate, not credited').to.equal(false);
    }); });

describe('AttestationConsensus: A-F4 byte_equality winner needs own-match or corroboration', function () { beforeEach(hookAt101470); afterEach(hookAt101731); it('two distinct responsible signers corroborating the same body DO latch it (and both sigs carry over)', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], Buffer.from('my-divergent-body'), 'http_get', 3));
        await flush();
        let pending = c.pending.get(RID);
        const BODY = Buffer.from('agreed-body');

        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        expect(pending.winner).to.equal(null);
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, BODY));
        await flush();

        expect(pending.winner, 'corroborated by 2 responsible signers').to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal('agreed-body');
        let canon = buildCanonical(RID, 'http_get', BODY, 'ok', '');
        for (let pk of [pub(p1), pub(p2)]) {
            expect(pending.signatures.has(pk), pk + ' sig credited on latch').to.equal(true);
            expect(ValidatorIdentity.verify(canon.toString('utf8'), pending.signatures.get(pk), pk)).to.equal(true);
        }
        // Our own divergent body still abstains from co-signing.
        expect(pending.signatures.has(pub(me))).to.equal(false);
    }); });

describe('AttestationConsensus: A-F4 byte_equality winner needs own-match or corroboration', function () { beforeEach(hookAt101470); afterEach(hookAt101731); it('an own-matching PREPARE still adopts immediately (no corroboration needed)', async function () {
        const BODY = Buffer.from('shared-body');
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let pending = c.pending.get(RID);

        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY));
        await flush();
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal('shared-body');
    }); });

describe('AttestationConsensus: A-F4 byte_equality winner needs own-match or corroboration', function () { beforeEach(hookAt101470); afterEach(hookAt101731); it('a sender re-announcing a different body REPLACES its previous candidate (AF4-R1: bounded per sender)', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], Buffer.from('my-divergent-body'), 'http_get', 3));
        await flush();
        let pending = c.pending.get(RID);

        // p1 streams three distinct bodies: only the LAST may remain live.
        for (let i = 0; i < 3; i++) {
            c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, Buffer.from('spam-body-' + i)));
        }
        await flush();
        expect(pending.winner).to.equal(null);
        expect(pending.prepareCandidates.size, 'one live candidate entry per sender').to.equal(1);

        // The stale first body can no longer be corroborated into a winner:
        // p2 matching p1's ABANDONED body finds no partner (p1 moved on), so
        // it holds as p2's own single candidate instead of latching.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, Buffer.from('spam-body-0')));
        await flush();
        expect(pending.winner, 'an abandoned body must not latch off one remaining signer').to.equal(null);

        // Corroboration on a sender's CURRENT body still works.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, Buffer.from('spam-body-2')));
        await flush();
        expect(pending.winner, 'both senders currently on the same body latches').to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal('spam-body-2');
    }); });
}
