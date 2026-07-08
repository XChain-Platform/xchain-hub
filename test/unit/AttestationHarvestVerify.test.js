'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: the PROPOSE-signature harvest in
// _maybeAdvanceFromProposals must re-verify each proposal's signature over the
// CANONICAL WINNER (which binds status='ok'), not trust it on a body+meta match.
// A proposal that matches the winner body but was signed over a different status
// must NOT be counted, or its signature inflates the quorum and the on-chain
// response (which the indexer rebuilds with status='ok') is rejected.

const crypto     = require('crypto');
const sinon      = require('sinon');
const { expect } = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { createMockHub }     = require('../helpers/mockHub');

function mkIdentity() { return new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex); }
function pub(id) { return id.getPubkeyHex().toLowerCase(); }
const flush = () => new Promise(r => setImmediate(r));

function buildCanonical(rid, providerId, body, status, meta) {
    let hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    return Buffer.from(String(rid) + String(providerId) + hash + String(status) + String(meta || ''), 'utf8');
}
function signEnv(type, rid, providerId, id, body, status) {
    let sig = id.sign(buildCanonical(rid, providerId, body, status, '').toString('utf8'));
    return { type, data: {
        requestId: rid, providerId, body_b64: body.toString('base64'), meta: '',
        status, sig_pubkey: pub(id), sig
    } };
}
function makeRealProviderRegistry() {
    return {
        getDef: sinon.stub().returns({ max_response_bytes: 65536, consensus_strategy: 'byte_equality' }),
        getModule: sinon.stub().returns({ agree: (proposals) => proposals[0] })
    };
}
function roundState(me, ids, body) {
    return {
        request: { request_id: 'req' }, providerId: 'http_get', redundancy: 3, snapshot: {},
        responsible: ids.map(i => ({ pubkey: pub(i) })), leaderPubkey: pub(me),
        role: 'leader', myProposal: { body, meta: '' }
    };
}

describe('AttestationConsensus harvest sig re-verify (stress-sweep 2026-07-08)', function () {

    let me, p1, p2, hub, c, finalized;
    const RID  = 'ab'.repeat(16);
    const BODY = Buffer.from('agreed-response-body');

    beforeEach(function () {
        me = mkIdentity(); p1 = mkIdentity(); p2 = mkIdentity();
        hub = createMockHub({ identity: me });
        c = new AttestationConsensus(hub, makeRealProviderRegistry());
        finalized = [];
        c.on('request:finalized', e => finalized.push(e));
    });
    afterEach(function () {
        for (let [, p] of c.pending) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    it('does NOT harvest a matching-body proposal whose sig is over a divergent status', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY));
        await flush();
        // p1: matching body, honest 'ok' status.
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY, 'ok'));
        // p2: matching body but signed over status='fail' (poison sig).
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, BODY, 'fail'));
        await flush();

        let pending = c.pending.get(RID);
        expect(pending.signatures.has(pub(me))).to.equal(true);
        expect(pending.signatures.has(pub(p1))).to.equal(true);
        // The poison sig must be rejected: it does not verify over the winner canonical.
        expect(pending.signatures.has(pub(p2))).to.equal(false);
        // Only 2 valid harvested sigs, below redundancy 3.
        expect(pending.signatures.size).to.equal(2);
    });

    it('harvests a matching-body proposal signed over the correct status (control)', async function () {
        await c.propose(RID, roundState(me, [me, p1, p2], BODY));
        await flush();
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p1, BODY, 'ok'));
        c._handleMessage(signEnv('ATTEST_PROPOSE', RID, 'http_get', p2, BODY, 'ok'));
        await flush();

        let pending = c.pending.get(RID);
        // All three sign over the correct status => all three harvested.
        expect(pending.signatures.has(pub(p2))).to.equal(true);
        expect(pending.signatures.size).to.equal(3);
    });
});
