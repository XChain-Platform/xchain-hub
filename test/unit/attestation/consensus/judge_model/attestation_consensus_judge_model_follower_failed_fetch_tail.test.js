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

// A judge_model follower whose own provider fetch failed must abstain from
// signing the leader's winner, yet still run the PREPARE tail: count the
// leader's vote and replay the PREPAREs and COMMITs buffered before the winner.

const flush = () => new Promise(r => setImmediate(r));
const mkIdentity = () => new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
const pub = (id) => id.getPubkeyHex().toLowerCase();

function buildCanonical(rid, providerId, body, status, meta) {
    let hash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    return Buffer.from(String(rid) + String(providerId) + hash + String(status) + String(meta || ''), 'utf8');
}

function signEnv(type, rid, id, body, status) {
    status = status || 'ok';
    let sig = id.sign(buildCanonical(rid, 'llm', body, status, '').toString('utf8'));
    return {
        type,
        data: { requestId: rid, providerId: 'llm', body_b64: body.toString('base64'), meta: '', status, sig_pubkey: pub(id), sig }
    };
}

function judgeRegistry() {
    return {
        getDef: sinon.stub().returns({ max_response_bytes: 65536, consensus_strategy: 'judge_model' }),
        getModule: sinon.stub().returns({ agree: (proposals) => proposals[0] })
    };
}

const RID     = 'cd'.repeat(16);
const EMPTY   = Buffer.alloc(0);
const P1_BODY = Buffer.from('leader-body');

async function bufferVotesBeforeWinner(consensus, p2, pending) {
    // Park both votes until the leader's PREPARE establishes a winner.
    consensus.handlePrepare(signEnv('ATTEST_PREPARE', RID, p2, P1_BODY));
    consensus.handleMessage(signEnv('ATTEST_COMMIT', RID, p2, P1_BODY));
    await flush();
    expect(pending.winner, 'non-leader PREPARE must not establish').to.equal(null);
    expect(pending.prepares.size).to.equal(0);
}

function ownPrepareBroadcastCount(hub, me) {
    return hub._peerManager.broadcast.getCalls()
        .filter(call => call.args[0] === 'ATTEST_PREPARE' && call.args[1].sig_pubkey === pub(me)).length;
}

function expectReplayedVotes(pending, p1, p2) {
    expect(pending.prepares.has(pub(p1)), 'leader PREPARE counted').to.equal(true);
    expect(pending.prepares.has(pub(p2)), 'buffered non-leader PREPARE replayed').to.equal(true);
    expect(pending.commits.has(pub(p2)), 'buffered COMMIT replayed').to.equal(true);
    let canon = buildCanonical(RID, 'llm', P1_BODY, 'ok', '').toString('utf8');
    expect(ValidatorIdentity.verify(canon, pending.signatures.get(pub(p2)), pub(p2))).to.equal(true);
}

describe('AttestationConsensus: judge_model follower with a failed own fetch', function () {
    let me, p1, p2, hub, c, finalized;

    beforeEach(function () {
        me  = mkIdentity();
        p1  = mkIdentity();
        p2  = mkIdentity();
        hub = createMockHub({ identity: me });
        c   = new AttestationConsensus(hub, judgeRegistry());
        finalized = [];
        c.on('request:finalized', e => finalized.push(e));
    });

    afterEach(function () {
        for (let [, p] of (c ? c.pending : [])) if (p.timer) clearTimeout(p.timer);
        sinon.restore();
    });

    async function seedFailedFollower() {
        await c.propose(RID, {
            request:      { request_id: 'req' },
            providerId:   'llm',
            redundancy:   3,
            snapshot:     {},
            responsible:  [me, p1, p2].map(i => ({ pubkey: pub(i) })),
            leaderPubkey: pub(p1),
            role:         'follower',
            myProposal:   { body: EMPTY, meta: '', status: 'provider_error' },
            pinnedConsensusStrategy: 'judge_model'
        });
        await flush();
        c.handleMessage(signEnv('ATTEST_PROPOSE', RID, p2, Buffer.from('p2-body')));
        c.handleMessage(signEnv('ATTEST_PROPOSE', RID, p1, P1_BODY));
        await flush();
        return c.pending.get(RID);
    }

    it('abstains from signing but still counts the leader PREPARE and replays buffered votes', async function () {
        let pending = await seedFailedFollower();
        await bufferVotesBeforeWinner(c, p2, pending);

        let prepBefore = ownPrepareBroadcastCount(hub, me);
        c.handlePrepare(signEnv('ATTEST_PREPARE', RID, p1, P1_BODY));
        await flush();

        expect(pending.winner.body.toString()).to.equal(P1_BODY.toString());
        expect(pending.signatures.has(pub(me)), 'no signature over bytes this hub never evaluated').to.equal(false);
        let prepAfter = ownPrepareBroadcastCount(hub, me);
        expect(prepAfter - prepBefore, 'no endorsing PREPARE echo from an abstaining hub').to.equal(0);
        expectReplayedVotes(pending, p1, p2);
    });
});
