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
let me, p1, p2, hub, c;

const hookAt39097 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
    };

const hookAt39259 = () => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

const RID  = 'b2'.repeat(16);

const BODY = Buffer.from('body');

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('a hotReload flipping the LIVE strategy mid-round cannot move the round off judge_model', async function () {
        // The registry is re-parsed from this hub's own configs table on EVERY
        // proposal:finalized event, whatever that proposal was about, so a live read at
        // each decision site let one hub run its own agree() while its peers deferred to
        // the leader for the SAME round. The round runs on the strategy anchored at its
        // request block, so the reload is invisible to it.
        let agreeSpy = sinon.spy(proposals => proposals[0]);
        let reg = makeRealProviderRegistry(agreeSpy, 'judge_model');
        c = new AttestationConsensus(hub, reg);
        let rs = roundState(me, [me, p1, p2], BODY, 'llm', 2);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';   // p1 is the elected leader
        await c.propose(RID, rs);
        await flush();
        // hotReload lands: the live def now says byte_equality, which would make this
        // follower run its own agree() and latch its own winner.
        reg.getDef.returns({ max_response_bytes: 65536, consensus_strategy: 'byte_equality' });
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, Buffer.from('p1-body')));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, Buffer.from('p2-body')));
        await flush();
        let pending = c.pending.get(RID);
        expect(agreeSpy.called, 'a follower must not judge because the live def moved').to.equal(false);
        expect(pending.winner).to.equal(null);
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('a non-leader does NOT run agree() (waits to adopt the leader PREPARE)', async function () {
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
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('the elected leader DOES run agree() and sets the winner', async function () {
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
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('a leader with its own ok body re-signs the canonical winner', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(proposals => proposals[0], 'judge_model'));
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'llm', 2));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, Buffer.from('p1-body')));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.not.equal(null);
        expect(pending.signatures.has(pub(me)), 'leader with genuine work must vouch for the winner').to.equal(true);
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('a leader whose own fetch FAILED does not re-sign the winner (#2235: symmetric to the follower abstention)', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(proposals => proposals[0], 'judge_model'));
        // startRound stores a failed fetch as an error proposal: empty body,
        // status 'provider_error'. The leader still runs agree() over the
        // followers' ok bodies, but it must NOT vouch for bytes it never
        // fetched or evaluated - that improper vote is the one that would push
        // signatures.size to REDUNDANCY with only REDUNDANCY-1 genuine attesters.
        let rs = roundState(me, [me, p1, p2], Buffer.alloc(0), 'llm', 2);
        rs.myProposal = { body: Buffer.alloc(0), meta: '', status: 'provider_error' };
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, Buffer.from('p1-body')));
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, Buffer.from('p2-body')));
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner, 'agree() still runs over the follower ok bodies').to.not.equal(null);
        expect(pending.signatures.has(pub(me)), 'leader must abstain from re-signing work it did not do').to.equal(false);
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('threads the round-snapshotted pinnedJudgeModel into agree() (immune to module JUDGE_MODEL drift)', async function () {
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
        // timeoutMs bounds the judge call to the round's fetch-timeout budget
        // (ATTESTATION_FETCH_TIMEOUT, default 20000ms) so a slow-drip judge
        // vendor cannot overrun the round window.
        // expectedN pins the majority denominator to the responsible-set bound
        // need = min(redundancy=2, responsible.length=3) = 2 (item 2642).
        // pinnedVendors rides alongside the pinned judge model (item 3482): the
        // block-anchored model_vendors map, null when the round carried none.
        // pinnedApprovedModels rides the same way: the block-anchored
        // allowlist the meta gate judges against, null when the round carried none.
        // outcome is the log-only could-not-judge channel agree() fills before an
        // inconclusive null; empty on the way in.
        expect(agreeSpy.firstCall.args[1]).to.deep.equal({ pinnedJudgeModel: 'claude-opus-4-7',
            pinnedVendors: null, pinnedApprovedModels: null, timeoutMs: 20000, expectedN: 2, outcome: {} });
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('an explicit ATTESTATION_FETCH_TIMEOUT still overrides the 20 s default for the judge call', async function () {
        // The raise moves the default only. An operator who tuned the key already
        // (down, for a fast vendor, or up past 20 s) must keep the budget they set, on
        // the judge leg as well as the fetch leg.
        let agreeSpy = sinon.spy(proposals => proposals[0]);
        hub = createMockHub({ identity: me, p2pConfig: { ATTESTATION_FETCH_TIMEOUT: '7500' } });
        c = new AttestationConsensus(hub, makeRealProviderRegistry(agreeSpy, 'judge_model'));
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'llm', 2));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, BODY));
        await flush();
        expect(agreeSpy.called).to.equal(true);
        expect(agreeSpy.firstCall.args[1].timeoutMs).to.equal(7500);
    }); });

// fetch() honours the block-anchored pinned model, so the allowlist
    // that judges the meta it returns has to be block-anchored too. Read from the
    // hub's live set instead, a governance delisting of the pinned model froze the
    // round at no_quorum on every retry until the request expired.
describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('threads the round-snapshotted pinnedApprovedModels into agree()', async function () {
        let agreeSpy = sinon.spy(proposals => proposals[0]);
        c = new AttestationConsensus(hub, makeRealProviderRegistry(agreeSpy, 'judge_model'));
        let rs = roundState(me, [me, p1, p2], BODY, 'llm', 2);
        rs.pinnedApprovedModels = ['retired-model-1', 'claude-opus-4-7'];
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, BODY));
        await flush();
        expect(agreeSpy.called).to.equal(true);
        expect(agreeSpy.firstCall.args[1].pinnedApprovedModels)
            .to.deep.equal(['retired-model-1', 'claude-opus-4-7']);
    }); });

// item 3482: a governance change can add a new-family model id and its
    // model_vendors entry in one block. The map has to reach agree() from the
    // round snapshot, not from each hub's live hotReloaded config, or a laggard
    // hub holds the pinned id with no way to resolve its vendor.
describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('threads the round-snapshotted pinnedVendors into agree() alongside the judge model', async function () {
        let agreeSpy = sinon.spy(proposals => proposals[0]);
        c = new AttestationConsensus(hub, makeRealProviderRegistry(agreeSpy, 'judge_model'));
        let rs = roundState(me, [me, p1, p2], BODY, 'llm', 2);
        rs.pinnedJudgeModel = 'llama-3-70b';
        rs.pinnedVendors    = { 'llama-3-70b': 'openai' };
        await c.propose(RID, rs);
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, BODY));
        await flush();
        expect(agreeSpy.called).to.equal(true);
        expect(agreeSpy.firstCall.args[1].pinnedVendors).to.deep.equal({ 'llama-3-70b': 'openai' });
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('a follower converges by adopting + re-signing the leader\'s winning body', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(p => p[0], 'judge_model'));
        let myBody = Buffer.from('my-own-divergent-body');
        let rs = roundState(me, [me, p1], myBody, 'llm', 2);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';
        await c.propose(RID, rs);
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.winner).to.equal(null);   // did not self-resolve

        let leaderBody = Buffer.from('leader-winning-body');
        // The leader's PROPOSE always precedes its PREPARE on the wire; A-F1
        // requires the follower to hold it so the winner can be hash-checked.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, leaderBody));
        await flush();
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, leaderBody));
        expect(pending.winner.body.toString()).to.equal('leader-winning-body');
        // Our own vote is re-signed over the agreed (leader) bytes.
        expect(pending.signatures.has(pub(me))).to.equal(true);
        let canon = buildCanonical(RID, 'llm', leaderBody, 'ok', '');
        expect(ValidatorIdentity.verify(canon.toString('utf8'), pending.signatures.get(pub(me)), pub(me))).to.equal(true);
    }); });

describe('AttestationConsensus: judge_model winner-selection is leader-gated (#3949)', function () { beforeEach(hookAt39097); afterEach(hookAt39259); it('a Byzantine non-leader PREPARE arriving FIRST does not set the winner (#4195)', async function () {
        c = new AttestationConsensus(hub, makeRealProviderRegistry(p => p[0], 'judge_model'));
        let rs = roundState(me, [me, p1, p2], Buffer.from('my-body'), 'llm', 2);
        rs.leaderPubkey = pub(p1); rs.role = 'follower';   // p1 leader; p2 = Byzantine non-leader
        await c.propose(RID, rs);
        await flush();
        let pending = c.pending.get(RID);

        // p2 (responsible but NOT the leader) races a divergent body in first.
        // It must be buffered, not adopted as the winner.
        let byzBody = Buffer.from('byzantine-divergent-body');
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p2, byzBody));
        expect(pending.winner, 'a non-leader judge_model PREPARE must not set the winner').to.equal(null);

        // The leader's PREPARE establishes the real winner; the buffered Byzantine
        // PREPARE then replays and is verified over the CANONICAL WINNER, so its
        // signature (taken over a divergent body) cannot be credited.
        let leaderBody = Buffer.from('leader-winning-body');
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, leaderBody));   // PROPOSE precedes PREPARE (A-F1)
        await flush();
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'llm', p1, leaderBody));
        await flush();
        expect(pending.winner.body.toString(), 'winner is the leader body').to.equal('leader-winning-body');

        if (pending.signatures.has(pub(p2))) {
            let winnerCanon = buildCanonical(RID, 'llm', leaderBody, 'ok', '');
            expect(ValidatorIdentity.verify(winnerCanon.toString('utf8'), pending.signatures.get(pub(p2)), pub(p2)),
                'a stored p2 signature must verify over the winner, never the Byzantine body').to.equal(true);
        }
        // The round never adopted the Byzantine body as winner.
        expect(pending.winner.body.toString()).to.not.equal('byzantine-divergent-body');
    }); });
}
