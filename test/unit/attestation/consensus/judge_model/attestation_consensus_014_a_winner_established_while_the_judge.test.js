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

async function raceRound() {
            let release;
            let reg = makeRealProviderRegistry(
                () => new Promise((resolve) => { release = () => resolve({ body: BODY, meta: '' }); }),
                'judge_model');
            c = new AttestationConsensus(hub, reg);
            await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'llm', 3));
            await flush();
            // p1 fetched the same body; p2's own fetch failed, so its proposal is an
            // error report. That is what makes the round advance on two ok bodies
            // while p2 still has standing to send a signed no_quorum PREPARE.
            c.handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p1, BODY));
            await flush();
            c.handleMessage(signEnv('ATTEST_PROPOSE', RID, 'llm', p2, Buffer.alloc(0), '', 'provider_error'));
            await flush();
            let pending = c.pending.get(RID);
            expect(pending._agreeing).to.equal(true);   // judge call in flight
            expect(pending.winner).to.equal(null);

            // The race: a responsible peer's signed no_quorum PREPARE is adopted.
            c.handleMessage(signEnv('ATTEST_PREPARE', RID, 'llm', p2, Buffer.alloc(0), '', 'no_quorum'));
            await flush();
            expect(pending.status).to.equal('no_quorum');

            release();
            await flush();
            return pending;
        }

// A judge_model round is the only one with a real await window: agree() is an
    // API call, and PBFT messages land on the event loop while it runs. If the
    // resumed leader overwrote a winner established during that window, the
    // signatures collected over the OLD canonical would stay in the map and be
    // emitted alongside signatures over the new one, and the indexer rejects a
    // response whose signature count over its own canonical is below redundancy.
    // Every signature in the map must verify over the round's FINAL canonical.
describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); describe('a winner established while the judge ran', function () { it('lets the raced outcome stand rather than overwriting it', async function () {
            let pending = await raceRound();
            expect(pending.status).to.equal('no_quorum');
            expect(pending.winner.body.length).to.equal(0);
            expect(pending.winner.meta).to.equal('');
        }); }); });

// A judge_model round is the only one with a real await window: agree() is an
    // API call, and PBFT messages land on the event loop while it runs. If the
    // resumed leader overwrote a winner established during that window, the
    // signatures collected over the OLD canonical would stay in the map and be
    // emitted alongside signatures over the new one, and the indexer rejects a
    // response whose signature count over its own canonical is below redundancy.
    // Every signature in the map must verify over the round's FINAL canonical.
describe('AttestationConsensus: maybeAdvanceFromProposals consensus outcomes', function () { beforeEach(hookAt61754); afterEach(hookAt61916); describe('a winner established while the judge ran', function () { it('emits no signature that fails over the round canonical', async function () {
            let pending = await raceRound();
            let canonical = c.buildCanonical(RID, pending.providerId, pending.winner.body,
                pending.status, pending.winner.meta,
                Number(pending.request.block_index), pending.effectiveTime).toString('utf8');
            let bad = [...pending.signatures].filter(
                ([pubkey, sig]) => !ValidatorIdentity.verify(canonical, String(sig), pubkey));
            expect(bad.map(([pubkey]) => pubkey)).to.deep.equal([]);
        }); }); });
}
