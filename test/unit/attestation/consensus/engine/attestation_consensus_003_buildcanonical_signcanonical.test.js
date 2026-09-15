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
const hookAt12026 = () => sinon.restore();

describe('AttestationConsensus: buildCanonical / signCanonical', function () { afterEach(hookAt12026); it('buildCanonical hashes the body and concatenates the fields deterministically', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        let body = Buffer.from('payload');
        let out = c.buildCanonical('rid1', 'http_get', body, 'ok', 'm');
        let expected = 'rid1' + 'http_get' +
            crypto.createHash('sha256').update(body, 'utf8').digest('hex') + 'ok' + 'm';
        expect(out.toString('utf8')).to.equal(expected);
        // Empty meta normalises to ''.
        let out2 = c.buildCanonical('rid1', 'http_get', body, 'ok', null);
        expect(out2.toString('utf8')).to.equal('rid1http_get' +
            crypto.createHash('sha256').update(body, 'utf8').digest('hex') + 'ok');
    }); });

describe('AttestationConsensus: buildCanonical / signCanonical', function () { afterEach(hookAt12026); it('signCanonical returns null when there is no identity', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.identity = null;
        expect(c.signCanonical('rid', 'p', Buffer.from('b'), 'ok', '')).to.equal(null);
    }); });

describe('AttestationConsensus: buildCanonical / signCanonical', function () { afterEach(hookAt12026); it('signCanonical returns null (not throw) when identity.sign throws', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.identity = { sign: () => { throw new Error('hsm offline'); } };
        expect(c.signCanonical('rid', 'p', Buffer.from('b'), 'ok', '')).to.equal(null);
    }); });

describe('AttestationConsensus: buildCanonical / signCanonical', function () { afterEach(hookAt12026); it('signCanonical produces a verifiable signature with a real identity', function () {
        let id = mkIdentity();
        let hub = createMockHub({ identity: id });
        let c = new AttestationConsensus(hub, makeProviderRegistry());
        let body = Buffer.from('b');
        let sig = c.signCanonical('rid', 'p', body, 'ok', 'm');
        let canonical = buildCanonical('rid', 'p', body, 'ok', 'm').toString('utf8');
        expect(ValidatorIdentity.verify(canonical, sig, pub(id))).to.equal(true);
    }); });
}
