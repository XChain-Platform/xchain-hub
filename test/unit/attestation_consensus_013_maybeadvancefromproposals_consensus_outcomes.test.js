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

const hookAt61754 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
    };

const hookAt61916 = () => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

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

describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); it('does not advance when the provider exposes no agree()', async function () {
        let reg = makeRealProviderRegistry();
        reg.getModule.returns(null);
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.equal(null);
    }); });

describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); it('escalates a thrown agree() to a no_quorum outcome (Phase 4)', async function () {
        let reg = makeRealProviderRegistry(() => { throw new Error('judge model down'); });
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.length).to.equal(0);
        expect(pending.winner.meta).to.equal('');
        expect(pending.status).to.equal('no_quorum');
    }); });

describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); it('escalates a null agree() result to a no_quorum outcome (Phase 4)', async function () {
        let reg = makeRealProviderRegistry(() => null);
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.not.equal(null);
        expect(pending.winner.body.length).to.equal(0);
        expect(pending.winner.meta).to.equal('');
        expect(pending.status).to.equal('no_quorum');
    }); });

// The provider's could-not-judge channel (options.outcome) is wired through so the
    // log can tell a judge outage from a genuine not-equivalent verdict; the on-chain
    // status stays no_quorum either way (the reason is leader-local, never canonical).
describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); it('passes options.outcome to agree() and logs the inconclusive reason, still publishing no_quorum', async function () {
        let seenOpts;
        let reg = makeRealProviderRegistry((proposals, options) => {
            seenOpts = options;
            options.outcome.inconclusive = true;
            options.outcome.reason = 'unreachable';
            return null;
        });
        let warn = sinon.stub(console, 'warn');
        let pending = await seedThreeProposals(reg);
        warn.restore();
        expect(seenOpts.outcome).to.be.an('object');
        expect(pending.status).to.equal('no_quorum');
        expect(pending.winner.body.length).to.equal(0);
        let lines = warn.getCalls().map(c => String(c.args[0]));
        expect(lines.some(l => /could not judge: reason=unreachable/.test(l))).to.equal(true);
        expect(lines.some(l => /proposals diverged/.test(l))).to.equal(false);
    }); });

describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); it('keeps the diverged wording when agree() returns null without marking the outcome', async function () {
        let reg = makeRealProviderRegistry(() => null);
        let warn = sinon.stub(console, 'warn');
        let pending = await seedThreeProposals(reg);
        warn.restore();
        expect(pending.status).to.equal('no_quorum');
        let lines = warn.getCalls().map(c => String(c.args[0]));
        expect(lines.some(l => /proposals diverged/.test(l))).to.equal(true);
    }); });

describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); it('supports an async agree() (judge_model style)', async function () {
        let reg = makeRealProviderRegistry(async (proposals) => proposals[0], 'judge_model');
        let pending = await seedThreeProposals(reg);
        expect(pending.winner).to.not.equal(null);
    }); });

describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); it('records a slash candidate for a byte_equality divergence', async function () {
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
    }); });
}
