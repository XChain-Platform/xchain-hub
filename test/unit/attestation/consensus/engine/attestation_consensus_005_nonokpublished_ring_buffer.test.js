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
const hookAt16579 = () => sinon.restore();

describe('AttestationConsensus: nonOkPublished ring buffer', function () { afterEach(hookAt16579); it('defaults nonOkPublishedMax independently of finalizedMax and reads the knob', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        expect(c.nonOkPublishedMax).to.equal(40000);
        expect(c.nonOkPublishedMax).to.be.greaterThan(c.finalizedMax);

        let hub = createMockHub();
        hub.p2pConfig = Object.assign({}, hub.p2pConfig, { ATTESTATION_NONOK_PUBLISHED_MAX: '123' });
        let c2 = new AttestationConsensus(hub, makeProviderRegistry());
        expect(c2.nonOkPublishedMax).to.equal(123);
    }); });

describe('AttestationConsensus: nonOkPublished ring buffer', function () { afterEach(hookAt16579); it('caps the ring by nonOkPublishedMax, not finalizedMax', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.finalizedMax      = 1;   // would evict immediately under the old sizing
        c.nonOkPublishedMax = 3;
        c.recordNonOkPublished('a', 'provider_error');
        c.recordNonOkPublished('b', 'no_quorum');
        c.recordNonOkPublished('c', 'provider_error');
        expect(c.nonOkPublished.size).to.equal(3);   // finalizedMax=1 no longer evicts
        c.recordNonOkPublished('d', 'provider_error');
        expect(c.nonOkPublished.has('a')).to.equal(false);
        expect(c.nonOkPublished.has('d')).to.equal(true);
        expect(c._nonOkPublishedOrder).to.deep.equal(['b', 'c', 'd']);
    }); });

describe('AttestationConsensus: nonOkPublished ring buffer', function () { afterEach(hookAt16579); it('accumulates statuses per rid without growing the ring', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.recordNonOkPublished('a', 'provider_error');
        c.recordNonOkPublished('a', 'no_quorum');
        expect(c._nonOkPublishedOrder).to.deep.equal(['a']);
        expect(c.nonOkPublished.get('a').has('provider_error')).to.equal(true);
        expect(c.nonOkPublished.get('a').has('no_quorum')).to.equal(true);
    }); });

describe('AttestationConsensus: nonOkPublished ring buffer', function () { afterEach(hookAt16579); it('warns and counts when a still-pending (never ok-finalized) entry is evicted', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        let warn = sinon.stub(console, 'warn');
        c.nonOkPublishedMax = 1;
        c.recordNonOkPublished('a', 'provider_error');
        c.recordNonOkPublished('b', 'provider_error');   // evicts 'a', still pending
        expect(c.nonOkEvictedWhilePendingCount).to.equal(1);
        expect(warn.getCalls().some(call => /still-pending request a/.test(call.args[0]))).to.equal(true);
        expect(warn.getCalls().some(call => /ATTESTATION_NONOK_PUBLISHED_MAX/.test(call.args[0]))).to.equal(true);
    }); });

describe('AttestationConsensus: nonOkPublished ring buffer', function () { afterEach(hookAt16579); it('does not count eviction of an entry whose request later finalized ok', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        sinon.stub(console, 'warn');
        c.nonOkPublishedMax = 1;
        c.recordNonOkPublished('a', 'provider_error');
        c.markFinalized('a');                            // retry round later succeeded
        c.recordNonOkPublished('b', 'provider_error');   // evicts 'a', now terminal
        expect(c.nonOkEvictedWhilePendingCount).to.equal(0);
    }); });
}
