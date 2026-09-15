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
let me, p1, p2, hub, c, finalized;

const hookAt84542 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        finalized = [];
    };

const hookAt84728 = () => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

// judge_model registry whose agree() picks the proposal whose body matches
    // `winnerText`: modelling the judge selecting one of N byte-divergent but
    // semantically-equivalent proposals as canonical.
    function judgeRegistry(winnerText) {
        return makeRealProviderRegistry(
            (proposals) => proposals.find(p => p.body.toString() === winnerText),
            'judge_model'
        );
    }

describe('AttestationConsensus: judge_model re-signs the canonical winner', function () { beforeEach(hookAt84542); afterEach(hookAt84728); it('redundancy=3: every responsible validator re-signs the judge-selected body so the round finalizes with REDUNDANCY sigs', async function () {
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
    }); });

describe('AttestationConsensus: judge_model re-signs the canonical winner', function () { beforeEach(hookAt84542); afterEach(hookAt84728); it('redundancy=1: single-validator judge_model still finalizes with one valid signature', async function () {
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
    }); });
}
