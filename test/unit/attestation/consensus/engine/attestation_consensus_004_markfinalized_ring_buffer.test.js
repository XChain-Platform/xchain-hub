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
describe('AttestationConsensus: markFinalized ring buffer', function () { it('evicts the oldest request id once finalizedMax is exceeded', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.finalizedMax = 2;
        c.markFinalized('a');
        c.markFinalized('b');
        c.markFinalized('b'); // duplicate is a no-op
        c.markFinalized('c'); // evicts 'a'
        expect(c.finalized.has('a')).to.equal(false);
        expect(c.finalized.has('b')).to.equal(true);
        expect(c.finalized.has('c')).to.equal(true);
        expect(c._finalizedOrder).to.deep.equal(['b', 'c']);
    }); });

describe('AttestationConsensus: markFinalized ring buffer', function () { it('tombstones evicted rids and bounds the tombstone ring by finalizedMax', function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.finalizedMax = 2;
        ['a', 'b', 'c', 'd', 'e'].forEach(r => c.markFinalized(r));
        // a/b/c were evicted, but the tombstone ring is itself capped at
        // finalizedMax, so the oldest tombstone ('a') has aged out and cannot leak.
        expect(c._finalizedEvictedOrder).to.deep.equal(['b', 'c']);
        expect(c._finalizedEvicted.has('a')).to.equal(false);
        expect(c._finalizedEvicted.has('c')).to.equal(true);
        expect(c.finalizedEvictedWhilePendingCount).to.equal(0);   // nothing re-proposed yet
    }); });

describe('AttestationConsensus: markFinalized ring buffer', function () { it('counts and warns when a round is proposed for an already-evicted finalized rid', async function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        c.finalizedMax = 1;
        c.markFinalized('aa');
        c.markFinalized('bb');            // evicts 'aa' -> tombstone
        let warn = sinon.stub(console, 'warn');
        // responsible=[] trips the unfinalizable-round guard immediately after the
        // detector, so no signing or broadcast state is needed to exercise this path.
        await c.propose('AA', { responsible: [], redundancy: 1 });
        sinon.restore();
        expect(c.finalizedEvictedWhilePendingCount).to.equal(1);
        expect(warn.getCalls().some(x => String(x.args[0]).includes('already evicted'))).to.equal(true);
    }); });

describe('AttestationConsensus: markFinalized ring buffer', function () { it('does not count a proposal for a rid that was never evicted', async function () {
        let c = new AttestationConsensus(createMockHub(), makeProviderRegistry());
        await c.propose('never-seen', { responsible: [], redundancy: 1 });
        expect(c.finalizedEvictedWhilePendingCount).to.equal(0);
    }); });
}
