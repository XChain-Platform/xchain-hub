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
let me, hub, c;

const hookAt21126 = () => {
        me  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, makeRealProviderRegistry());
    };

const hookAt21305 = () => {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    };

const RID = 'ab'.repeat(16);

describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); it('returns immediately if the request is already finalized', async function () {
        c.markFinalized(RID);
        await c.propose(RID, roundState(me, [me], Buffer.from('b'), 'http_get', 1));
        expect(c.pending.has(RID)).to.equal(false);
    }); });

describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); it('returns immediately if a round for the request is already pending', async function () {
        c.pending.set(RID, { timer: null });
        await c.propose(RID, roundState(me, [me], Buffer.from('b'), 'http_get', 1));
        // Untouched sentinel: propose bailed before overwriting it.
        expect(c.pending.get(RID)).to.deep.equal({ timer: null });
    }); });

describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); it('creates a round but does not advance when there is no identity (no own proposal)', async function () {
        c.identity = null;
        await c.propose(RID, roundState(me, [me, mkIdentity()], Buffer.from('b'), 'http_get', 2));
        await flush();
        let p = c.pending.get(RID);
        expect(p).to.exist;
        expect(p.winner).to.equal(null);
        expect(p.proposals.size).to.equal(0);
        // Still broadcast a PROPOSE (with null sig_pubkey).
        let propose = hub._peerManager.broadcast.getCalls().find(call => call.args[0] === 'ATTEST_PROPOSE');
        expect(propose).to.exist;
    }); });

describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); it('skips an unfinalizable round when the responsible set is smaller than redundancy', async function () {
        // redundancy=3 but only 1 responsible validator: needed=max(quorum,3)=3 > 1,
        // so signatures can never reach the gate. propose() must skip admission
        // (no pending, no PROPOSE broadcast) and let the request expire + refund.
        await c.propose(RID, roundState(me, [me], Buffer.from('b'), 'http_get', 3));
        expect(c.pending.has(RID)).to.equal(false);
        let propose = hub._peerManager.broadcast.getCalls().find(call => call.args[0] === 'ATTEST_PROPOSE');
        expect(propose).to.not.exist;
    }); });

describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); it('admits a round when the responsible set meets redundancy', async function () {
        // Regression guard: a healthy set (responsible.length === redundancy)
        // still starts the round normally.
        await c.propose(RID, roundState(me, [me, mkIdentity(), mkIdentity()], Buffer.from('b'), 'http_get', 3));
        expect(c.pending.has(RID)).to.equal(true);
        let propose = hub._peerManager.broadcast.getCalls().find(call => call.args[0] === 'ATTEST_PROPOSE');
        expect(propose).to.exist;
    }); });

// item 6490: the liveness ladder widens the responsible set to
    // max(1, redundancy) + widen, and computing the PBFT quorum over that widened
    // length raised `needed` above redundancy for small redundancies, stalling the
    // very rounds the ladder fires for. Pin the threshold to redundancy at every
    // widening level the ladder can produce (maxSlots = 2).
describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); [
        { redundancy: 1, widen: 0 },
        { redundancy: 1, widen: 1 },
        { redundancy: 1, widen: 2 },
        { redundancy: 3, widen: 1 },
        { redundancy: 3, widen: 2 },
        { redundancy: 5, widen: 2 }
    ].forEach(({ redundancy, widen }) => {
        it('keeps needed == redundancy ' + redundancy + ' at widen ' + widen + ' (6490)', async function () {
            let members = [me];
            while(members.length < redundancy + widen) members.push(mkIdentity());
            await c.propose(RID, roundState(me, members, Buffer.from('b'), 'http_get', redundancy));
            let pending = c.pending.get(RID);
            expect(pending, 'round admitted').to.exist;
            expect(pending.responsible.length).to.equal(redundancy + widen);
            // The gate both quorum checks read is max(quorum, redundancy); widening
            // must not move it off redundancy.
            expect(Math.max(pending.quorum, pending.redundancy)).to.equal(redundancy);
        });
    }); });

describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); it('drops a stalled (never-finalized) round when its timeout fires', async function () {
        let clock = sinon.useFakeTimers();
        c.roundTimeoutMs = 1000;
        // Redundancy 3 with only our own proposal → never advances to a winner.
        await c.propose(RID, roundState(me, [me, mkIdentity(), mkIdentity()], Buffer.from('b'), 'http_get', 3));
        c.earlyCommits.set(RID, []); // confirm the timeout also clears the early-commit queue
        expect(c.pending.has(RID)).to.equal(true);
        clock.tick(1001);
        expect(c.pending.has(RID)).to.equal(false);
        expect(c.earlyCommits.has(RID)).to.equal(false);
        clock.restore();
    }); });

describe('AttestationConsensus: propose() guards', function () { beforeEach(hookAt21126); afterEach(hookAt21305); it('counts a timed-out round so quorum loss reaches the stats rail (item 8c1148c0)', async function () {
        // Before this counter the timeout handler only warned, so a hub losing
        // every round to quorum timeout still reported a clean attestation rail:
        // the only other counter, failed_count, sees local fetch errors alone.
        let clock = sinon.useFakeTimers();
        c.roundTimeoutMs = 1000;
        expect(c.roundTimeoutCount).to.equal(0);
        await c.propose(RID, roundState(me, [me, mkIdentity(), mkIdentity()], Buffer.from('b'), 'http_get', 3));
        clock.tick(1001);
        expect(c.roundTimeoutCount).to.equal(1);
        clock.restore();
    }); });
}
