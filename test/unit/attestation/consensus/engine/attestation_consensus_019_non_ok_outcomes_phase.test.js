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
const AttestationConsensus = require('../../../../../src/attestation/consensus');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { createMockHub }    = require('../../../../helpers/mockHub');

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

// Mirror of AttestationConsensus.buildCanonical so peers can sign the exact
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
const RID  = 'e2'.repeat(16);

const BODY = Buffer.from('payload');

const EMPTY = Buffer.alloc(0);

let me, p1, p2, hub, c;

const hookAt89269 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
    };

const hookAt89431 = () => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

function errorRoundState(id, responsibleIds, redundancy) {
        let rs = roundState(id, responsibleIds, EMPTY, 'llm', redundancy);
        rs.myProposal = { body: EMPTY, meta: '', status: 'provider_error' };
        return rs;
    }

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('an all-error round converges on a provider_error winner and finalizes', async function () {
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
    }); });

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('a non-ok finalization stays retryable: rid is NOT marked finalized', async function () {
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
    }); });

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('throttles: the same non-ok status is not established twice for one rid', async function () {
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
    }); });

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('an ok retry after a published non-ok still finalizes normally', async function () {
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
    }); });

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('a follower whose own fetch FAILED co-signs a provider_error PREPARE', async function () {
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
    }); });

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('a follower whose own fetch SUCCEEDED abstains from a provider_error PREPARE', async function () {
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
    }); });

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('rejects a non-ok PREPARE carrying a non-canonical (non-empty) body', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(null, 'judge_model'));
        // redundancy matches the responsible-set size so propose() admits the
        // round (a shrunken set below redundancy is now skipped as unfinalizable);
        // this test exercises PREPARE-body rejection, not finalization.
        let rs = errorRoundState(me, [p1, me], 2);
        rs.leaderPubkey = pub(p1);
        rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'llm', p1, Buffer.from('sneaky'), '', 'provider_error'));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.equal(null);
    }); });

describe('AttestationConsensus: non-ok outcomes (Phase 4)', function () { beforeEach(hookAt89269); afterEach(hookAt89431); it('an honest provider_error proposal never accrues a byte_equality slash candidate', async function () {
        hub.slashDetector = { recordAttestationDivergence: sinon.stub().resolves() };
        c = new AttestationConsensus(hub, makeRealProviderRegistry());
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, EMPTY, '', 'provider_error'));
        await flush();
        expect(hub.slashDetector.recordAttestationDivergence.called).to.equal(false);
    }); });
}
