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

// A judge_model round that never finalizes, reproduced from a live federation
// where four validators each held an identical `status=ok` llm body against a
// redundancy of 3 and every hub logged `round timeout` on a two-minute cadence
// indefinitely. http_get rounds finalized on the same hubs throughout.
//
// This pins the ADMISSION gate, not the early-message buffer. The buffered
// PREPAREs that expire are downstream: they are parked at the non-leader
// judge_model guard awaiting a winner the leader never emits. The leader never
// emits one because `if(pending.proposals.size < need) return` in
// _maybeAdvanceFromProposals is never satisfied, and under judge_model only the
// elected leader may run agree(). So the federation waits on one hub's count.
//
// The one way that count falls short leaving NO trace is the responsible-set
// check at the top of _handlePropose, `return; // Outsider proposal; ignore`. A
// proposal refused there is indistinguishable from one that never arrived.

const sinon                = require('sinon');
const { expect }           = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { createMockHub }    = require('../helpers/mockHub');

function mkIdentity() {
    return new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
}
function pub(id) { return id.getPubkeyHex().toLowerCase(); }

// judge_model needs an agree() to exist; the leader gate is reached before it is
// called, and the falsification case asserts it IS called once the set matches.
function makeProviderRegistry(agreeSpy) {
    return {
        getDef:    sinon.stub().returns(null),
        getModule: sinon.stub().returns({ agree: agreeSpy })
    };
}

describe('AttestationConsensus: judge_model leader stalls when its responsible set omits its proposers', function () {

    const RID  = 'cd'.repeat(16);       // 32 hex chars
    const BODY = Buffer.from('4');      // the live rounds all carried body=1B

    let hub, consensus, agreeSpy;
    let leader, fB, fC, fD, community1, community2;

    // A PROPOSE signed the way _handlePropose verifies it: over the canonical
    // built from the wire values. mirrorEra is false on the round, so
    // _readWireEffectiveTime returns null and the canonical takes no stamp.
    function proposeFrom(identity) {
        let canonical = consensus._buildCanonical(RID, 'llm', BODY, 'ok', '', 0, null).toString('utf8');
        return {
            type: 'ATTEST_PROPOSE',
            data: {
                requestId:  RID,
                providerId: 'llm',
                body_b64:   BODY.toString('base64'),
                meta:       '',
                status:     'ok',
                sig_pubkey: pub(identity),
                sig:        identity.sign(canonical)
            }
        };
    }

    function makeRound(responsibleIdentities) {
        return {
            request:      { request_id: 'req', block_index: 0 },
            providerId:   'llm',
            pinnedConsensusStrategy: 'judge_model',
            redundancy:   3,
            quorum:       3,
            mirrorEra:    false,
            responsible:  responsibleIdentities.map(id => ({ pubkey: pub(id) })),
            commits:      new Set(),
            prepares:     new Set(),
            signatures:   new Map(),
            proposals:    new Map(),
            winner:       null,
            status:       'ok',
            myPubkey:     pub(leader),
            leaderPubkey: pub(leader),
            role:         'leader',
            finalized:    false,
            timer:        null
        };
    }

    beforeEach(function () {
        hub        = createMockHub();
        agreeSpy   = sinon.stub().returns({ body: BODY, meta: '' });
        consensus  = new AttestationConsensus(hub, makeProviderRegistry(agreeSpy));
        leader     = mkIdentity();
        fB         = mkIdentity();
        fC         = mkIdentity();
        fD         = mkIdentity();
        community1 = mkIdentity();
        community2 = mkIdentity();
    });

    afterEach(function () {
        for (let [, p] of consensus.pending) { if (p.timer) clearTimeout(p.timer); }
        sinon.restore();
    });

    it('admits only the proposers inside its own responsible set, and the three it drops leave no trace', function () {
        // The leader's set is the right SIZE (5, i.e. redundancy 3 + widen 2) and
        // holds itself plus four community members that carry no llm transport and
        // therefore never propose. Its three transport-carrying peers are absent.
        let pending = makeRound([leader, community1, community2, mkIdentity(), mkIdentity()]);
        consensus.pending.set(RID, pending);

        // The leader's own body is inserted directly by the round, not gossiped.
        pending.proposals.set(pub(leader), { body: BODY, meta: '', status: 'ok' });

        // All three peers propose an identical ok body, exactly as the live fleet did.
        consensus._handlePropose(proposeFrom(fB));
        consensus._handlePropose(proposeFrom(fC));
        consensus._handlePropose(proposeFrom(fD));

        // Constraint 1: assert the admitted SET, not its size.
        let admitted = [...pending.proposals.keys()].sort();
        expect(admitted).to.deep.equal([pub(leader)].sort());
        for (let peer of [fB, fC, fD]) {
            expect(pending.proposals.has(pub(peer)),
                'peer ' + pub(peer).slice(0, 8) + ' must have been refused by the membership gate').to.equal(false);
        }
    });

    it('never advances to a winner, so under judge_model the whole federation waits on it', async function () {
        let pending = makeRound([leader, community1, community2, mkIdentity(), mkIdentity()]);
        consensus.pending.set(RID, pending);
        pending.proposals.set(pub(leader), { body: BODY, meta: '', status: 'ok' });

        consensus._handlePropose(proposeFrom(fB));
        consensus._handlePropose(proposeFrom(fC));
        consensus._handlePropose(proposeFrom(fD));

        await consensus._maybeAdvanceFromProposals(RID);

        // One proposal against a need of 3: the gate returns and no winner exists.
        // agree() is never reached, so no canonical body is ever broadcast and the
        // followers' PREPAREs have nothing to adopt. This is the live stall.
        expect(pending.winner).to.equal(null);
        expect(agreeSpy.called, 'agree() must not have run: the leader never reached its threshold').to.equal(false);
        expect(pending.finalized).to.equal(false);
    });

    it('reads healthy from every single hub while the sets disagree, which is why per-hub logs cannot see it', function () {
        // Each hub's own set is the right size and contains itself, so each hub
        // reports a well-formed round. Constraint 2: the fault is only visible
        // when the sets are compared ACROSS hubs.
        let leaderSet   = makeRound([leader, community1, community2, fB, fC]);
        let followerSet = makeRound([fB, fC, fD, leader, community1]);

        let asKeys = r => r.responsible.map(v => v.pubkey).sort().join(',');

        expect(leaderSet.responsible).to.have.lengthOf(5);
        expect(followerSet.responsible).to.have.lengthOf(5);
        expect(asKeys(leaderSet)).to.not.equal(asKeys(followerSet),
            'this rig is only meaningful while the two sets differ');

        // fD is responsible in the follower's view and an outsider in the leader's,
        // so fD's proposal is admitted by one hub and silently discarded by the other.
        expect(followerSet.responsible.some(v => v.pubkey === pub(fD))).to.equal(true);
        expect(leaderSet.responsible.some(v => v.pubkey === pub(fD))).to.equal(false);
    });

    it('FALSIFICATION: with the leader\'s set matching its peers, the same proposals are admitted and it advances', async function () {
        // Same messages and bodies; the only change is that the leader's set now
        // contains its proposers. If this cannot go green, the tests above pin
        // something other than the membership gate.
        let pending = makeRound([leader, fB, fC, fD, community1]);
        consensus.pending.set(RID, pending);
        pending.proposals.set(pub(leader), { body: BODY, meta: '', status: 'ok' });

        consensus._handlePropose(proposeFrom(fB));
        consensus._handlePropose(proposeFrom(fC));
        consensus._handlePropose(proposeFrom(fD));

        let admitted = [...pending.proposals.keys()].sort();
        expect(admitted).to.deep.equal([pub(leader), pub(fB), pub(fC), pub(fD)].sort());

        await consensus._maybeAdvanceFromProposals(RID);

        // Past the threshold, the leader runs the judge and establishes a winner.
        expect(agreeSpy.called, 'agree() must run once the leader is over its threshold').to.equal(true);
        expect(pending.winner).to.not.equal(null);
    });
});
