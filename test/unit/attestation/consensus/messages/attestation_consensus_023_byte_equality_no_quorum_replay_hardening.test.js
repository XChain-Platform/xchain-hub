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
const httpAgree = require('../../../../../src/providers/http_get').agree;

const RID   = 'c4'.repeat(16);

const BODY  = Buffer.from('replicated-body');

const EMPTY = Buffer.alloc(0);

let me, p1, p2, hub, c;

const hookAt107990 = () => {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        // Real http_get.agree so the expectedN denominator is exercised end-to-end.
        c   = new AttestationConsensus(hub, makeRealProviderRegistry(httpAgree, 'byte_equality'));
    };

const hookAt108336 = () => {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

// item 2642: the majority denominator is the responsible-set size, not the
    // surviving ok-proposal count, so a lone unreplicated body cannot win.
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('a minority-ok byte_equality round yields no_quorum, not a lone-body winner (2642)', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        // Two of three fetches failed; only this hub holds an ok body.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, EMPTY, '', 'provider_error'));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, EMPTY, '', 'provider_error'));
        await flush();
        let pending = c.pending.get(RID);
        // With N pinned to redundancy=3, agree([1 ok]) needs ceil(4/2)=2 and
        // returns null; the round establishes the deterministic no_quorum row
        // instead of seating the lone body as winner.
        expect(pending.winner).to.not.equal(null);
        expect(pending.status).to.equal('no_quorum');
        expect(pending.winner.body.length).to.equal(0);
    }); });

// item 2641 / 2579: a hub holding an ok body must not co-sign a lone
    // no_quorum PREPARE it cannot itself derive; it buffers pending derivation.
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('does not co-sign a lone no_quorum PREPARE while holding an ok body (2641/2579)', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        let pending = c.pending.get(RID);
        // A single responsible validator races a signed no_quorum PREPARE before
        // this hub has collected `need` proposals.
        c._handleMessage(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, EMPTY, '', 'no_quorum'));
        await flush();
        expect(pending.winner).to.equal(null);
        expect(pending.signatures.has(pub(me))).to.equal(false);
        // Held for local derivation, not adopted on faith.
        expect(c.earlyMessages.has(RID)).to.equal(true);
    }); });

// item 2641 liveness: a genuinely split round (no byte majority) still
    // converges on no_quorum once this hub derives it itself.
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('a genuinely split byte_equality round still records no_quorum (2641 liveness)', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, Buffer.from('body-b')));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, Buffer.from('body-c')));
        await flush();
        expect(c.pending.get(RID).status).to.equal('no_quorum');
    }); });

// item 5305: the self-derivation gate keys on the pinned STRATEGY while the
    // sync/async shape of agree() rides the MODULE, so a byte_equality provider
    // exporting an async agree() reaches this synchronous handler. Its pending
    // Promise is truthy, and reading it as a derived ok winner would refuse every
    // no_quorum PREPARE for that provider until the round hit its deadline. The
    // gate must read a thenable as "cannot derive", say so, and consume the
    // orphaned settlement so a rejecting agree() cannot fell the process.
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('reads an async agree() as underivable, not as a derived winner (5305)', function () {
        let thenSpy = sinon.spy();
        let cc = new AttestationConsensus(hub, {
            getDef:    sinon.stub().returns({ max_response_bytes: 65536, consensus_strategy: 'byte_equality' }),
            getModule: sinon.stub().returns({ agree: () => ({ then: thenSpy }) })
        });
        cc.pending.set(RID, {
            requestId:   RID,
            request:     { request_id: 'req' },
            providerId:  'http_get',
            redundancy:  1,
            responsible: [{ pubkey: pub(p1) }],
            myPubkey:    pub(me),
            proposals:   new Map([[pub(me), { body: BODY, meta: '', sig: 'aa', status: 'ok' }]]),
            prepares:    new Set(),
            commits:     new Set(),
            signatures:  new Map(),
            winner:      null,
            status:      'ok',
            pinnedConsensusStrategy: 'byte_equality',
            finalized:   false,
            timer:       null
        });
        let errs = [];
        sinon.stub(console, 'error').callsFake((m) => errs.push(String(m)));

        cc.handlePrepare(signEnv('ATTEST_PREPARE', RID, 'http_get', p1, EMPTY, '', 'no_quorum'));

        let pending = cc.pending.get(RID);
        expect(pending.winner).to.equal(null);                    // not adopted on a truthy Promise
        expect(pending.signatures.has(pub(p1))).to.equal(false);  // and not co-signed
        expect(thenSpy.calledOnce).to.equal(true);                // settlement consumed, not orphaned
        expect(errs.some(m => m.indexOf('async agree()') !== -1)).to.equal(true);
    }); });

// item 5306: the inbound body gate is pinned for the round's lifetime from the
    // cap the round fetched under, so a hotReload that lowers max_response_bytes
    // mid-round cannot make this hub reject peer bodies the size of its own.
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('gates inbound bodies on the round-pinned cap, not the live registry (5306)', async function () {
        let reg = makeRealProviderRegistry(require('../../../../../src/providers/http_get').agree, 'byte_equality', 65536);
        c = new AttestationConsensus(hub, reg);
        let rs = roundState(me, [me, p1, p2], BODY, 'http_get', 3);
        rs.pinnedMaxResponseBytes = 65536;
        await c.propose(RID, rs);
        await flush();
        let pending = c.pending.get(RID);
        expect(pending.maxBodyB64Length).to.equal(Math.ceil(65536 * 1.4));
        // Governance lowers the cap mid-round; the registry now reports 4 bytes.
        reg.getDef.returns({ max_response_bytes: 4, consensus_strategy: 'byte_equality' });
        // Control: a live read would now reject this body outright.
        expect(c.maxBodyB64Length('http_get')).to.be.below(BODY.toString('base64').length);
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        await flush();
        // Accepted under the pinned cap: the live read would have rejected a body
        // byte-identical to the one this hub proposed itself.
        expect(pending.proposals.has(pub(p1))).to.equal(true);
    }); });

// item 2640: a torn-down rid drops (not parks) late envelopes, and a fresh
    // round reopening clears the mark so its own early messages buffer again.
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('suppresses buffering for a torn-down rid until a fresh round reopens (2640)', async function () {
        c.markTornDown(RID);
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY));
        expect(c.earlyMessages.has(RID)).to.equal(false);  // dropped, not parked
        await c.propose(RID, roundState(me, [me, p1, p2], BODY, 'http_get', 3));
        await flush();
        expect(c.tornDown.has(RID)).to.equal(false);
    }); });

// item 2640: the non-ok finalization teardown (which does NOT enter
    // this.finalized) clears the early-message buffer and marks the rid torn
    // down, closing the post-teardown replay window.
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('clears earlyMessages and marks tornDown on non-ok finalization (2640)', async function () {
        let rs = roundState(me, [me], EMPTY, 'http_get', 1);
        rs.myProposal = { body: EMPTY, meta: '', status: 'provider_error' };
        await c.propose(RID, rs);
        await flush();
        expect(c.finalized.has(RID)).to.equal(false);   // stays retryable
        expect(c.tornDown.has(RID)).to.equal(true);
        expect(c.earlyMessages.has(RID)).to.equal(false);
    }); });

// item 6489: the already-marked branch must not build a drop event from an
    // `envelope` this method never takes, so a second teardown for one rid threw
    // ReferenceError out of the bare round-timeout timer (an uncaught hub fault).
describe('AttestationConsensus: byte_equality no_quorum + replay hardening', function () { beforeEach(hookAt107990); afterEach(hookAt108336); it('markTornDown is idempotent and does not throw when the rid is already marked (6489)', function () {
        c.markTornDown(RID);
        expect(() => c.markTornDown(RID)).to.not.throw();
        expect(c.tornDown.has(RID)).to.equal(true);
        expect(c._tornDownOrder.filter(r => r === RID).length).to.equal(1);
    }); });
}
