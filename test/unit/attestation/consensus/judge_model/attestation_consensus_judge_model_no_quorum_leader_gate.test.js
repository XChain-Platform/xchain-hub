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

// A judge_model no_quorum is reachable only behind the leader gate, so only the
// leader's PREPARE may establish it. A non-leader's is buffered like a non-leader
// ok PREPARE, and an outage (provider_error) stays recordable by any sender.

const sinon                = require('sinon');
const crypto               = require('crypto');
const { expect }           = require('chai');
const AttestationConsensus = require('../../../../../src/attestation/consensus');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { createMockHub }    = require('../../../../helpers/mockHub');

const flush = () => new Promise(r => setImmediate(r));
const RID   = 'c3'.repeat(16);
const BODY  = Buffer.from('body');
const EMPTY = Buffer.alloc(0);

function mkIdentity() { return new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex); }
function pub(id) { return id.getPubkeyHex().toLowerCase(); }

// Sign the bytes the engine verifies (mirror of AttestationConsensus.buildCanonical).
function signEnv(type, id, body, status) {
    let hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    let sig = id.sign(RID + 'llm' + hash + String(status || 'ok'));
    return { type, data: { requestId: RID, providerId: 'llm', body_b64: body.toString('base64'), meta: '',
                           status: status || 'ok', sig_pubkey: pub(id), sig } };
}

// Provider registry pinned to judge_model with the given agree().
function registry(agreeFn) {
    return { getDef: sinon.stub().returns({ max_response_bytes: 65536, consensus_strategy: 'judge_model' }),
             getModule: sinon.stub().returns({ agree: agreeFn }) };
}

// A three-hub judge_model round with `leader` elected and `me` proposing `myBody`.
function roundState(me, leader, others, myBody, myStatus) {
    return { request: { request_id: 'req' }, providerId: 'llm', redundancy: 2, snapshot: {},
             responsible: [me, ...others].map(i => ({ pubkey: pub(i) })), leaderPubkey: pub(leader),
             role: leader === me ? 'leader' : 'follower', pinnedConsensusStrategy: 'judge_model',
             myProposal: { body: myBody, meta: '', status: myStatus || 'ok' } };
}

{
let me, p1, p2, c;
const setup = () => { me = mkIdentity(); p1 = mkIdentity(); p2 = mkIdentity(); };
const teardown = () => {
    for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
    sinon.restore();
};

describe('AttestationConsensus: judge_model no_quorum is leader-gated', function () { beforeEach(setup); afterEach(teardown); it('a follower buffers a non-leader no_quorum and adopts the leader ok winner after it', async function () {
    c = new AttestationConsensus(createMockHub({ identity: me }), registry(() => null));
    await c.propose(RID, roundState(me, p1, [p1, p2], BODY));
    await flush();
    c.handleMessage(signEnv('ATTEST_PROPOSE', p1, BODY));   // A-F1: the leader body must match a collected proposal
    await flush();
    c.handleMessage(signEnv('ATTEST_PREPARE', p2, EMPTY, 'no_quorum'));
    await flush();
    let pending = c.pending.get(RID);
    expect(pending.winner, 'a non-leader no_quorum must not establish the winner').to.equal(null);
    expect(pending.signatures.has(pub(me)), 'and this hub must not co-sign it').to.equal(false);
    c.handleMessage(signEnv('ATTEST_PREPARE', p1, BODY));
    await flush();
    expect(pending.status).to.equal('ok');
    expect(pending.winner.body.equals(BODY)).to.equal(true);
    expect(pending.signatures.has(pub(p2)), 'the replayed no_quorum must not count over the ok canonical').to.equal(false);
}); });

describe('AttestationConsensus: judge_model no_quorum is leader-gated', function () { beforeEach(setup); afterEach(teardown); it('a follower still adopts and co-signs the leader no_quorum', async function () {
    c = new AttestationConsensus(createMockHub({ identity: me }), registry(() => null));
    await c.propose(RID, roundState(me, p1, [p1, p2], BODY));
    await flush();
    c.handleMessage(signEnv('ATTEST_PREPARE', p1, EMPTY, 'no_quorum'));
    await flush();
    let pending = c.pending.get(RID);
    expect(pending.status).to.equal('no_quorum');
    expect(pending.signatures.has(pub(me)), 'a participating follower vouches for the leader no_quorum').to.equal(true);
}); });

describe('AttestationConsensus: judge_model no_quorum is leader-gated', function () { beforeEach(setup); afterEach(teardown); it('a leader mid-judge buffers a non-leader no_quorum and keeps its own ok winner', async function () {
    let release;
    c = new AttestationConsensus(createMockHub({ identity: me }),
        registry(() => new Promise((resolve) => { release = () => resolve({ body: BODY, meta: '' }); })));
    await c.propose(RID, roundState(me, me, [p1, p2], BODY));
    await flush();
    c.handleMessage(signEnv('ATTEST_PROPOSE', p1, BODY));
    await flush();
    let pending = c.pending.get(RID);
    expect(pending._agreeing, 'the judge call is in flight').to.equal(true);
    c.handleMessage(signEnv('ATTEST_PREPARE', p2, EMPTY, 'no_quorum'));
    await flush();
    expect(pending.winner).to.equal(null);
    release();
    await flush();
    expect(pending.status).to.equal('ok');
    expect(pending.winner.body.equals(BODY)).to.equal(true);
}); });

describe('AttestationConsensus: judge_model no_quorum is leader-gated', function () { beforeEach(setup); afterEach(teardown); it('a non-leader provider_error is still adopted, so an outage stays recordable', async function () {
    c = new AttestationConsensus(createMockHub({ identity: me }), registry(() => null));
    await c.propose(RID, roundState(me, p1, [p1, p2], EMPTY, 'provider_error'));
    await flush();
    c.handleMessage(signEnv('ATTEST_PREPARE', p2, EMPTY, 'provider_error'));
    await flush();
    expect(c.pending.get(RID).status).to.equal('provider_error');
}); });
}
