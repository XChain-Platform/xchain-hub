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

const hookAt33049 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    };

const hookAt33284 = () => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

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

describe('AttestationConsensus: PREPARE signatures verified against the winner (#3949)', function () { beforeEach(hookAt33049); afterEach(hookAt33284); it('does NOT count a PREPARE signature taken over a divergent body', function () {
        let WINNER  = Buffer.from('winner-body');
        let pending = seedWithWinner([p1, p2], WINNER);
        // p1's signature is valid, but over ITS OWN divergent body, not the winner.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, Buffer.from('divergent-body')));
        expect(pending.signatures.has(pub(p1))).to.equal(false);
        expect(pending.signatures.size).to.equal(0);
        // The PREPARE participation is still recorded (mirrors _handleCommit).
        expect(pending.prepares.has(pub(p1))).to.equal(true);
    }); });

describe('AttestationConsensus: PREPARE signatures verified against the winner (#3949)', function () { beforeEach(hookAt33049); afterEach(hookAt33284); it('DOES count a PREPARE signature taken over the winner body', function () {
        let WINNER  = Buffer.from('winner-body');
        let pending = seedWithWinner([p1, p2], WINNER);
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p2, WINNER));
        expect(pending.signatures.has(pub(p2))).to.equal(true);
        expect(pending.signatures.size).to.equal(1);
        // And the stored signature actually verifies over the winner bytes.
        let canon = buildCanonical(RID, 'http_get', WINNER, 'ok', '');
        expect(ValidatorIdentity.verify(canon.toString('utf8'), pending.signatures.get(pub(p2)), pub(p2))).to.equal(true);
    }); });

// Makes the cross-handler dependency above executable rather than prose.
    // maybeAdvanceFromProposals returns at once when a winner exists, and the
    // winner-canonical sweep runs only at winner establishment, so a late PROPOSE is
    // recorded but contributes NO signature; only that peer's own PREPARE (or COMMIT)
    // does. A change that moves where signatures are counted must trip this test.
describe('AttestationConsensus: PREPARE signatures verified against the winner (#3949)', function () { beforeEach(hookAt33049); afterEach(hookAt33284); it('a post-winner PROPOSE contributes no signature; the same peer\'s PREPARE does', async function () {
        let WINNER  = Buffer.from('winner-body');
        let pending = seedWithWinner([p1, p2], WINNER);

        // p1 proposes the WINNER bytes themselves, correctly signed, AFTER the winner
        // is locked: the most favourable case for the "sigs collected" reading.
        c._handlePropose(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, WINNER));
        await flush();
        expect(pending.proposals.has(pub(p1)), 'the late proposal is still recorded').to.equal(true);
        expect(pending.signatures.has(pub(p1)), 'but its signature is NOT swept in').to.equal(false);
        expect(pending.signatures.size).to.equal(0);

        // The same peer's PREPARE over the winner is what actually counts it.
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, WINNER));
        expect(pending.signatures.has(pub(p1))).to.equal(true);
        let canon = buildCanonical(RID, 'http_get', WINNER, 'ok', '');
        expect(ValidatorIdentity.verify(canon.toString('utf8'), pending.signatures.get(pub(p1)), pub(p1))).to.equal(true);
    }); });

describe('AttestationConsensus: PREPARE signatures verified against the winner (#3949)', function () { beforeEach(hookAt33049); afterEach(hookAt33284); it('finalizes a round carrying ONLY winner-body signatures when a peer PREPAREs a divergent body', async function () {
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
    }); });
}
