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
let me, p1, hub, c;

const BODY = Buffer.from('b');

const hookAt75441 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    };

const hookAt75648 = () => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); ['ATTEST_PROPOSE', 'ATTEST_PREPARE', 'ATTEST_COMMIT'].forEach(function (type) {
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
            c.markFinalized(rid);
            c._handleMessage({ type, data: { requestId: rid, sig_pubkey: pub(p1) } });
            expect(c.earlyMessages.has(rid)).to.equal(false);
            expect(c.pending.has(rid)).to.equal(false);
        });
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('_handlePropose ignores a proposal carrying no sig_pubkey', async function () {
        let rid = '2b'.repeat(16);
        await c.propose(rid, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        let before = c.pending.get(rid).proposals.size;
        c._handleMessage({ type: 'ATTEST_PROPOSE', data: { requestId: rid, body_b64: '', sig: 'x' } });
        expect(c.pending.get(rid).proposals.size).to.equal(before);
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('maybeAdvanceFromProposals returns for an unknown request', async function () {
        await c.maybeAdvanceFromProposals('does-not-exist'); // !pending guard
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('maybeAdvanceFromProposals returns when a winner already exists', async function () {
        c.pending.set('z', { finalized: false, winner: { body: Buffer.from('x'), meta: '' } });
        await c.maybeAdvanceFromProposals('z'); // winner guard
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('checkPrepareQuorum returns early when no winner is set', function () {
        c.pending.set('z', { winner: null, finalized: false, prepares: new Set(), quorum: 1, redundancy: 1 });
        expect(() => c.checkPrepareQuorum('z')).to.not.throw();
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('checkPrepareQuorum returns early when a commit was already sent', function () {
        c.pending.set('z', { winner: {}, finalized: false, _commitSent: true, prepares: new Set() });
        expect(() => c.checkPrepareQuorum('z')).to.not.throw();
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('checkCommitQuorum returns early for a finalized round', function () {
        c.pending.set('z', { finalized: true });
        expect(() => c.checkCommitQuorum('z')).to.not.throw();
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('constructor tolerates a hub without getIdentity / p2pConfig', function () {
        let bare = new AttestationConsensus({ getPeerManager: () => null, db: {} }, makeRealProviderRegistry());
        expect(bare.identity).to.equal(null);
        expect(bare.config).to.deep.equal({});
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('maybeAdvanceFromProposals returns when an agree() is already in flight', async function () {
        c.pending.set('z', { finalized: false, winner: null, _agreeing: true });
        await c.maybeAdvanceFromProposals('z'); // _agreeing guard
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('abandons the round if it is pruned while agree() is awaiting', async function () {
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
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('applies field defaults when a PROPOSE omits meta/status (sig still matches)', async function () {
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
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('applies field defaults when a PREPARE omits meta/status', async function () {
        const RID = '6f'.repeat(16);
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        let env = signEnv('ATTEST_PREPARE', RID, 'http_get', p1, BODY);
        delete env.data.meta;
        delete env.data.status;
        c._handleMessage(env);
        expect(c.pending.get(RID).prepares.has(pub(p1))).to.equal(true);
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('broadcasts an empty body_b64 when our own proposal has no body', async function () {
        const RID = '7a'.repeat(16);
        // A null body makes signCanonical throw→null and myBody falsy.
        await c.propose(RID, roundState(me, [me, p1], null, 'http_get', 2));
        await flush();
        let propose = hub._peerManager.broadcast.getCalls().find(call => call.args[0] === 'ATTEST_PROPOSE');
        expect(propose.args[1].body_b64).to.equal('');
        expect(c.pending.get(RID).proposals.size).to.equal(0); // own proposal not stored
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('rejects a PROPOSE with a missing signature', async function () {
        const RID = '8b'.repeat(16);
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        let env = signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY);
        delete env.data.sig;
        c._handleMessage(env);
        expect(c.pending.get(RID).proposals.has(pub(p1))).to.equal(false);
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('ignores a PREPARE with neither sig_pubkey nor body_b64', async function () {
        const RID = '9c'.repeat(16);
        await c.propose(RID, roundState(me, [me, p1], BODY, 'http_get', 2));
        await flush();
        c._handleMessage({ type: 'ATTEST_PREPARE', data: { requestId: RID } });
        expect(c.pending.get(RID).prepares.size).to.equal(0);
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('ignores a COMMIT with no sig_pubkey', function () {
        const RID = '1d'.repeat(16);
        let pending = {
            requestId: RID, providerId: 'http_get', responsible: [{ pubkey: pub(p1) }],
            winner: { body: BODY, meta: '' }, status: 'ok', commits: new Set(),
            signatures: new Map(), finalized: false, quorum: 1, redundancy: 2, prepares: new Set()
        };
        c.pending.set(RID, pending);
        c._handleMessage({ type: 'ATTEST_COMMIT', data: { requestId: RID, body_b64: BODY.toString('base64') } });
        expect(pending.commits.size).to.equal(0);
    }); });

describe('AttestationConsensus: message guards & internal early-returns', function () { beforeEach(hookAt75441); afterEach(hookAt75648); it('does NOT finalize a byte_equality round when our body genuinely diverges (only one valid sig)', async function () {
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
    }); });
}
