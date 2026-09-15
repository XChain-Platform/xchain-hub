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
let hub, c;

const hookAt105945 = () => {
        hub = createMockHub();
        c   = new AttestationConsensus(hub, makeProviderRegistry());
    };

const hookAt106076 = () => sinon.restore();

function env(rid, extra) {
        return { type: 'ATTEST_PREPARE', data: Object.assign({ requestId: rid, body_b64: 'aGk=' }, extra || {}) };
    }

describe('AttestationConsensus: A-F5 early-buffer bounds (attestation half)', function () { beforeEach(hookAt105945); afterEach(hookAt106076); it('caps the number of DISTINCT buffered requestIds with FIFO eviction', function () {
        c.earlyMessageMaxDistinctIds = 3;
        for (let i = 0; i < 4; i++) c.bufferEarlyMessage('rid' + i, env('rid' + i));
        expect(c.earlyMessages.size).to.equal(3);
        expect(c.earlyMessages.has('rid0'), 'oldest rid evicted').to.equal(false);
        expect(c.earlyMessages.has('rid3'), 'newest rid kept').to.equal(true);
        expect(c.earlyMessageTtl.has('rid0'), 'evicted rid TTL cleaned').to.equal(false);
    }); });

describe('AttestationConsensus: A-F5 early-buffer bounds (attestation half)', function () { beforeEach(hookAt105945); afterEach(hookAt106076); it('drops an oversized envelope instead of buffering it', function () {
        c.earlyMessageMaxBytes = 64;
        c.bufferEarlyMessage('rid-big', env('rid-big', { body_b64: 'A'.repeat(1000) }));
        expect(c.earlyMessages.has('rid-big')).to.equal(false);
        // A normal-sized envelope still buffers.
        c.bufferEarlyMessage('rid-ok', env('rid-ok'));
        expect(c.earlyMessages.get('rid-ok')).to.have.lengthOf(1);
    }); });

describe('AttestationConsensus: A-F5 early-buffer bounds (attestation half)', function () { beforeEach(hookAt105945); afterEach(hookAt106076); it('drops an unserializable (cyclic) envelope instead of throwing', function () {
        let data = { requestId: 'rid-cycle' };
        data.self = data;
        expect(() => c.bufferEarlyMessage('rid-cycle', { type: 'ATTEST_PREPARE', data })).to.not.throw();
        expect(c.earlyMessages.has('rid-cycle')).to.equal(false);
    }); });
}
