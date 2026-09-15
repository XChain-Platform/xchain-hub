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
function registryWithWindows(windows) {
        const providers = new Map(Object.entries(windows).map(
            ([id, w]) => [id, { deadline_window_blocks: w, consensus_strategy: 'byte_equality' }]));
        return {
            getDef:  (id) => providers.get(id) || null,
            getModule: () => ({ agree: (p) => p[0] }),
            maxDeadlineWindowBlocks() {
                let blocks = 0, providerId = null;
                for (const [id, def] of providers) {
                    const w = Number(def.deadline_window_blocks);
                    if (Number.isFinite(w) && w > blocks) { blocks = w; providerId = id; }
                }
                return { blocks, providerId };
            }
        };
    }

const hookAt118158 = () => sinon.restore();

describe('AttestationConsensus: nonOkPublished sizing floor vs governance windows (item 3421)', function () { afterEach(hookAt118158); it('is satisfied by the shipped default at the 100-block http_get window', function () {
        const c = new AttestationConsensus(createMockHub(), registryWithWindows({ http_get: 100, llm: 20 }));
        const r = c.checkNonOkSizingFloor();
        expect(r.ok).to.equal(true);
        expect(r.blocks).to.equal(100);
        expect(r.providerId).to.equal('http_get');
        expect(r.floor).to.equal(40000);   // the default is sized exactly to this
        expect(r.cap).to.equal(40000);
    }); });

describe('AttestationConsensus: nonOkPublished sizing floor vs governance windows (item 3421)', function () { afterEach(hookAt118158); it('warns, naming the provider, once governance widens a window past the floor', function () {
        const warn = sinon.stub(console, 'warn');
        const c = new AttestationConsensus(createMockHub(), registryWithWindows({ http_get: 100, slow_oracle: 250 }));
        const r = c.checkNonOkSizingFloor();
        expect(r.ok).to.equal(false);
        expect(r.blocks).to.equal(250);          // the WIDEST def wins, not http_get
        expect(r.providerId).to.equal('slow_oracle');
        expect(r.floor).to.equal(100000);
        expect(warn.called).to.equal(true);
        const msg = warn.getCalls().map(x => String(x.args[0])).join(' ');
        expect(msg).to.include('slow_oracle');
        expect(msg).to.include('100000');
    }); });

describe('AttestationConsensus: nonOkPublished sizing floor vs governance windows (item 3421)', function () { afterEach(hookAt118158); it('stays quiet when the operator has raised the cap to cover the wider window', function () {
        const warn = sinon.stub(console, 'warn');
        const hub  = createMockHub();
        hub.p2pConfig = Object.assign({}, hub.p2pConfig, { ATTESTATION_NONOK_PUBLISHED_MAX: '120000' });
        const c = new AttestationConsensus(hub, registryWithWindows({ slow_oracle: 250 }));
        expect(c.nonOkPublishedMax).to.equal(120000);
        const r = c.checkNonOkSizingFloor();
        expect(r.ok).to.equal(true);
        expect(warn.called).to.equal(false);
    }); });

describe('AttestationConsensus: nonOkPublished sizing floor vs governance windows (item 3421)', function () { afterEach(hookAt118158); it('returns null rather than guessing when no def declares a usable window', function () {
        const c = new AttestationConsensus(createMockHub(), registryWithWindows({ http_get: 'not-a-number' }));
        expect(c.checkNonOkSizingFloor()).to.equal(null);
    }); });

describe('AttestationConsensus: nonOkPublished sizing floor vs governance windows (item 3421)', function () { afterEach(hookAt118158); it('is a no-op against a registry that predates the accessor', function () {
        const c = new AttestationConsensus(createMockHub(), { getDef: () => null, getModule: () => null });
        expect(c.checkNonOkSizingFloor()).to.equal(null);
    }); });
}
