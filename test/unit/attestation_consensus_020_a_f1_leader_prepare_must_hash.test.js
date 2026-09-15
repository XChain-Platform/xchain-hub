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

const hookAt96861 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry(p => p[0], 'judge_model'));
    };

const hookAt97120 = () => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

const RID = 'c3'.repeat(16);

// Follower round: p1 is leader; everyone has proposed, so the A-F1 check runs.
    async function seedFullProposals() {
        let rs = roundState(me, [me, p1, p2], Buffer.from('my-body'), 'llm', 3);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, Buffer.from('p1-body')));
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, Buffer.from('p2-body')));
        await flush();
        return c.pending.get(RID);
    }

describe('AttestationConsensus: A-F1 leader PREPARE must hash-match a collected proposal', function () { beforeEach(hookAt96861); afterEach(hookAt97120); it('rejects a leader PREPARE whose body matches NO collected proposal (fabricated winner)', async function () {
        let pending = await seedFullProposals();
        expect(pending.proposals.size).to.equal(3);

        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, Buffer.from('fabricated-never-proposed')));
        await flush();
        expect(pending.winner, 'a fabricated leader body must not be adopted').to.equal(null);
        expect(pending.signatures.has(pub(me)), 'we must not re-sign it').to.equal(false);
    }); });

describe('AttestationConsensus: A-F1 leader PREPARE must hash-match a collected proposal', function () { beforeEach(hookAt96861); afterEach(hookAt97120); it('rejects a leader PREPARE whose body matches a proposal but whose meta diverges', async function () {
        let pending = await seedFullProposals();
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, Buffer.from('p1-body'), 'tampered-meta'));
        await flush();
        expect(pending.winner).to.equal(null);
    }); });

describe('AttestationConsensus: A-F1 leader PREPARE must hash-match a collected proposal', function () { beforeEach(hookAt96861); afterEach(hookAt97120); it('buffers a too-early leader PREPARE and adopts it once proposals catch up', async function () {
        // Only OUR proposal is in (1 of 3 needed): the leader PREPARE cannot be
        // hash-checked yet and must be buffered, not adopted on faith.
        let rs = roundState(me, [me, p1, p2], Buffer.from('my-body'), 'llm', 3);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        let pending = c.pending.get(RID);

        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, Buffer.from('p1-body')));
        expect(pending.winner, 'not adopted before the proposal set can vouch').to.equal(null);
        expect(c.earlyMessages.get(RID), 'held for replay').to.have.lengthOf(1);

        // Remaining PROPOSEs land; the drain replays the buffered PREPARE, which
        // now hash-matches p1's own proposal and is adopted.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, Buffer.from('p1-body')));
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, Buffer.from('p2-body')));
        await flush();
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.toString()).to.equal('p1-body');
        // And our vote was re-signed over the adopted canonical.
        expect(pending.signatures.has(pub(me))).to.equal(true);
    }); });

describe('AttestationConsensus: A-F1 leader PREPARE must hash-match a collected proposal', function () { beforeEach(hookAt96861); afterEach(hookAt97120); it('rejects a leader PREPARE that only hash-matches a peer ERROR proposal (AF1-R1: empty-body ok-winner)', async function () {
        // p2's fetch failed: provider_error with the canonical EMPTY body. A
        // Byzantine leader then announces status='ok' with an empty body, which
        // hash-matches that error proposal. Only OK proposals may vouch.
        let rs = roundState(me, [me, p1, p2], Buffer.from('my-body'), 'llm', 3);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, Buffer.from('p1-body')));
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, Buffer.alloc(0), '', 'provider_error'));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.proposals.size).to.equal(3);

        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, Buffer.alloc(0)));
        await flush();
        expect(pending.winner, 'an empty-body ok winner vouched only by an error proposal must not latch').to.equal(null);
        expect(pending.signatures.has(pub(me)), 'we must not re-sign it').to.equal(false);
    }); });
}
