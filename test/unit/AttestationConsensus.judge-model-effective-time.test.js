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

// A mirror-era judge_model round that never finalizes, reproduced from a public
// testnet federation: four validators held an identical status=ok body against a
// redundancy of 3, the elected leader reached agree() and broadcast a PREPARE,
// and every follower logged
//
//     PREPARE effective_time <n> out of window from <leader> for <rid> (rejected)
//
// on a two-minute cadence indefinitely. byte_equality rounds finalized on the
// same hubs throughout.
//
// THE MECHANISM IS THE JUDGE CALL'S LATENCY, NOT THE WINDOW'S WIDTH. The leader
// picks its effective_time once, at proposal time, as now + forward. Under
// judge_model it then spends the whole judge round trip inside agree() before it
// establishes a winner and broadcasts. By the time a follower window-checks that
// stamp, the stamp has aged by the judge latency while the follower's own
// expectation moved forward with its clock, and once the gap exceeds
// ATTEST_RESPONSE_EFFECTIVE_TIME_SLACK_BEHIND_S the PREPARE is refused by every
// follower at once. The observed round put 108 s inside that gap against a 60 s
// slack.
//
// The two suites below pin the two halves of the repair: the leader settling the
// stamp at winner ESTABLISHMENT (part 1), and the judge call being bounded so the
// ageing it can introduce is bounded too (part 2).

const sinon                = require('sinon');
const { expect }           = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const llm                  = require('../../src/providers/llm');
const { createMockHub }    = require('../helpers/mockHub');

const FORWARD_S    = 120;   // lib/attest_response_timing.js ATTEST_RESPONSE_FORWARD_S
const SLACK_BEHIND = 60;    // AttestationConsensus ATTEST_RESPONSE_EFFECTIVE_TIME_SLACK_BEHIND_S
const JUDGE_S      = 108;   // the judge latency the live round actually spent

function mkIdentity() {
    return new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
}
function pub(id) { return id.getPubkeyHex().toLowerCase(); }

describe('AttestationConsensus: a judge_model leader stamps effective_time at winner establishment', function () {

    const RID   = 'ab'.repeat(16);              // 32 hex chars
    const BLOCK = 1000000;
    const BODY  = Buffer.from('{"answer":"42"}');
    const META  = 'claude-sonnet-4-6';
    const T0    = 1788995902;                   // the live round's PROPOSE second

    let leader, f1, f2, silentA, silentB;
    let nodes, wire;

    // One in-process hub: a real signing identity, a peerManager whose broadcast
    // drops onto the shared wire, and the two seams this path reads the world
    // through (the clock and the era gate).
    // `proposedAt` is the second THIS hub polled and proposed, offset from the
    // leader's. Staggered polls are the live shape, and they matter here: they are
    // what makes each hub's proposal-time candidate a different value, so a round
    // that settles on any stamp but the leader's own can only reach redundancy
    // through the leader's PREPARE.
    function makeNode(identity, agreeImpl, proposedAt) {
        let hub  = createMockHub({ identity: identity });
        let node = { identity: identity, pubkey: pub(identity), hub: hub, clock: T0, proposedAt: proposedAt };
        hub._peerManager.broadcast = (type, data) => {
            wire.push({ from: node.pubkey, envelope: { type: type, data: data } });
            return { id: 'msg' };
        };
        node.consensus = new AttestationConsensus(hub, {
            getDef:    sinon.stub().returns(null),
            getModule: sinon.stub().returns({ agree: agreeImpl })
        });
        // Mirror era for the whole round; the activation height itself is covered
        // by attest_response_activation's own suite.
        node.consensus._isMirrorEra = () => true;
        node.consensus._nowSeconds  = () => node.clock;
        return node;
    }

    // The pending record propose() would have built, with mirrorEra on and this
    // hub's own proposal-time candidate already chosen. Built directly rather than
    // through propose() so the round needs no capability snapshot or DB.
    function makeRound(node) {
        return {
            requestId:    RID,
            request:      { request_id: 'req', block_index: BLOCK },
            mirrorEra:    true,
            effectiveTime: T0 + node.proposedAt + FORWARD_S,
            providerId:   'llm',
            pinnedConsensusStrategy: 'judge_model',
            redundancy:   3,
            quorum:       3,
            // Redundancy 3 widened to 5; the two extra members carry no llm
            // transport and never propose, which is the live set's shape.
            responsible:  [leader, f1, f2, silentA, silentB].map(id => ({ pubkey: pub(id) })),
            leaderPubkey: pub(leader),
            role:         node.pubkey === pub(leader) ? 'leader' : 'follower',
            myPubkey:     node.pubkey,
            proposals:    new Map(),
            prepares:     new Set(),
            commits:      new Set(),
            signatures:   new Map(),
            winner:       null,
            status:       'ok',
            finalized:    false,
            timer:        null
        };
    }

    // A proposal as _handlePropose would have stored it: signed by its author over
    // the author's OWN proposal-time stamp, which is what makes the leader's
    // pre-judge stamp the only one any peer could converge on without a round trip.
    function proposalFrom(node, author) {
        let stamp = T0 + author.proposedAt + FORWARD_S;
        let canonical = node.consensus._buildCanonical(RID, 'llm', BODY, 'ok', META, BLOCK, stamp).toString('utf8');
        return { body: BODY, meta: META, status: 'ok', effectiveTime: stamp, sig: author.identity.sign(canonical) };
    }

    // Gossip: one message at a time, in order, delivered to every node but its
    // sender. Deferred rather than re-entrant so a follower's echo reaches the
    // leader the way a real hop does, and so a follower can legitimately see a
    // peer's echo before the leader's own PREPARE.
    function flushWire() {
        let guard = 0;
        while (wire.length) {
            if (++guard > 500) throw new Error('wire did not settle');
            let msg = wire.shift();
            for (let n of nodes) {
                if (n.pubkey === msg.from) continue;
                if (msg.envelope.type === 'ATTEST_PROPOSE') n.consensus._handlePropose(msg.envelope);
                else if (msg.envelope.type === 'ATTEST_PREPARE') n.consensus._handlePrepare(msg.envelope);
                else if (msg.envelope.type === 'ATTEST_COMMIT')  n.consensus._handleCommit(msg.envelope);
            }
        }
    }

    // Stand up the three participating hubs with every proposal already collected
    // (the collection phase is not what this pins), the leader's agree() burning
    // `judgeSeconds` of wall clock on every hub the way a real judge call does.
    function standUp(judgeSeconds) {
        let agreeImpl = async () => {
            for (let n of nodes) n.clock += judgeSeconds;
            return { body: BODY, meta: META };
        };
        let L  = makeNode(leader, agreeImpl, 0);
        let N1 = makeNode(f1, agreeImpl, 1);
        let N2 = makeNode(f2, agreeImpl, 2);
        nodes  = [L, N1, N2];
        for (let n of nodes) {
            let pending = makeRound(n);
            for (let author of nodes)
                pending.proposals.set(author.pubkey, proposalFrom(n, author));
            n.consensus.pending.set(RID, pending);
        }
        return { L: L, N1: N1, N2: N2 };
    }

    beforeEach(function () {
        leader  = mkIdentity();
        f1      = mkIdentity();
        f2      = mkIdentity();
        silentA = mkIdentity();
        silentB = mkIdentity();
        wire    = [];
        nodes   = [];
    });

    afterEach(function () {
        for (let n of nodes)
            for (let [, p] of n.consensus.pending) { if (p.timer) clearTimeout(p.timer); }
        sinon.restore();
    });

    it('carries a stamp every follower accepts, and every follower adopts exactly that stamp', async function () {
        let { L, N1, N2 } = standUp(JUDGE_S);

        await L.consensus._maybeAdvanceFromProposals(RID);
        let prepare = wire.find(m => m.envelope.type === 'ATTEST_PREPARE' && m.from === pub(leader));
        expect(prepare, 'the leader must have broadcast a PREPARE').to.not.equal(undefined);
        let wireStamp = prepare.envelope.data.effective_time;

        flushWire();

        for (let follower of [N1, N2]) {
            let pending = follower.consensus.pending.get(RID);
            // Identity, not shape: the follower's round runs on the leader's bytes.
            expect(pending.effectiveTime,
                'follower ' + follower.pubkey.slice(0, 8) + ' must adopt the leader PREPARE stamp')
                .to.equal(wireStamp);
            // Inside the propagation floor the live rounds fell 48 s short of.
            expect(wireStamp).to.be.at.least(follower.clock + FORWARD_S - SLACK_BEHIND);
            // And still in the future, which is what the floor exists to protect:
            // a stamp at or behind the fleet's clocks forks indexers' action index.
            expect(wireStamp).to.be.above(follower.clock);
        }
    });

    it('collects exactly the leader and the two followers as signers, all over one canonical', async function () {
        let { L } = standUp(JUDGE_S);

        await L.consensus._maybeAdvanceFromProposals(RID);
        flushWire();

        let pending = L.consensus.pending.get(RID);
        // The SET of signers, not its size: a count is satisfied by the wrong three.
        expect([...pending.signatures.keys()].sort())
            .to.deep.equal([pub(leader), pub(f1), pub(f2)].sort());
        // No silent member can have contributed one.
        for (let quiet of [silentA, silentB])
            expect(pending.signatures.has(pub(quiet))).to.equal(false);

        // ONE canonical, built from the round's single settled stamp, and every
        // collected signature has to verify over it. This is the property the
        // indexer re-derives before it will apply the response.
        let canonical = L.consensus._buildCanonical(
            RID, 'llm', pending.winner.body, pending.status, pending.winner.meta, BLOCK, pending.effectiveTime
        ).toString('utf8');
        for (let [pubkey, sig] of pending.signatures)
            expect(ValidatorIdentity.verify(canonical, sig, pubkey),
                'signature from ' + pubkey.slice(0, 8) + ' must verify over the round canonical').to.equal(true);
    });

    it('finalizes the round instead of running it to the two-minute timeout', async function () {
        let { L, N1, N2 } = standUp(JUDGE_S);

        await L.consensus._maybeAdvanceFromProposals(RID);
        flushWire();

        for (let n of [L, N1, N2])
            expect(n.consensus.finalized.has(RID),
                'hub ' + n.pubkey.slice(0, 8) + ' must have finalized the round').to.equal(true);
    });

    it('leaves byte_equality converging on the leader PROPOSAL stamp, which is the only value it can reach', async function () {
        // Same round, byte_equality: every hub runs agree() itself and reaches its
        // own winner with no round trip, so the stamp has to be one already on the
        // wire. A fresh pick here would give each hub its own canonical and no
        // signature would ever transfer.
        let { L } = standUp(0);
        let pending = L.consensus.pending.get(RID);
        pending.pinnedConsensusStrategy = 'byte_equality';
        // Move this hub's clock so a fresh pick would be visibly different from the
        // proposal stamp; the assertion is worthless if the two coincide.
        L.clock = T0 + 30;

        await L.consensus._maybeAdvanceFromProposals(RID);

        expect(pending.effectiveTime).to.equal(T0 + FORWARD_S);
        expect(pending.effectiveTime).to.not.equal(L.clock + FORWARD_S);
    });

    it('leaves a judge_model provider_error round on the proposal stamp, because every hub establishes that one itself', async function () {
        // No ok proposal anywhere: _maybeAdvanceFromProposals reaches provider_error
        // AHEAD of the leader gate, so a follower establishes this outcome locally
        // and its adoption branch only runs while it has no winner of its own. A
        // fresh leader stamp here would sign bytes no follower ever adopts.
        let { L, N1 } = standUp(0);
        for (let n of [L, N1]) {
            let pending = n.consensus.pending.get(RID);
            for (let [pk, p] of pending.proposals)
                pending.proposals.set(pk, Object.assign({}, p, { body: Buffer.alloc(0), status: 'provider_error' }));
        }
        L.clock  = T0 + 30;
        N1.clock = T0 + 30;

        await L.consensus._maybeAdvanceFromProposals(RID);
        await N1.consensus._maybeAdvanceFromProposals(RID);

        let lPending = L.consensus.pending.get(RID);
        let nPending = N1.consensus.pending.get(RID);
        expect(lPending.status).to.equal('provider_error');
        // The leader and an independently-establishing follower on the same bytes.
        expect(lPending.effectiveTime).to.equal(T0 + FORWARD_S);
        expect(nPending.effectiveTime).to.equal(lPending.effectiveTime);
    });
});

describe('llm.agree: the judge call is bounded by options.timeoutMs, measured from entry', function () {

    const PROPOSALS = [
        { body: Buffer.from('a'), meta: 'claude-sonnet-4-6' },
        { body: Buffer.from('b'), meta: 'claude-sonnet-4-6' },
        { body: Buffer.from('c'), meta: 'claude-sonnet-4-6' }
    ];
    const BUDGET_MS = 10000;   // AttestationConsensus's ATTESTATION_FETCH_TIMEOUT default

    let clock;

    beforeEach(function () {
        llm._resetSpendGuardForTest();
        clock = sinon.useFakeTimers({ now: 1788995902000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });

    afterEach(function () {
        llm._setJudgeCallForTest(null);
        // _setConfig writes module globals that outlive this file in a shared
        // mocha process, so put the spec fallbacks back rather than leaving a
        // fallback ladder installed for whatever suite runs next.
        llm._setConfig({ additional_config: {
            approved_models:       ['claude-sonnet-4-6', 'claude-opus-4-7'],
            judge_model:           'claude-haiku-4-5',
            judge_fallback_models: [],
            model_vendors:         {}
        }});
        clock.restore();
        llm._resetSpendGuardForTest();
        sinon.restore();
    });

    it('resolves inconclusive within the budget when the first judge in the ladder hangs', async function () {
        // A transport that honours nothing: no verdict, no error, no timeout of its
        // own. This is the only shape the outer wall exists for, and the shape a
        // 108-second judge call approaches from below.
        let dialled = [];
        llm._setJudgeCallForTest((opts) => { dialled.push(opts.model); return new Promise(() => {}); });

        let outcome = {};
        let startedAt = Date.now();
        let settled = false;
        let p = llm.agree(PROPOSALS, {
            timeoutMs: BUDGET_MS,
            outcome: outcome,
            pinnedApprovedModels: ['claude-sonnet-4-6']
        });
        p.then(() => { settled = true; }, () => { settled = true; });

        await clock.tickAsync(BUDGET_MS - 1);
        expect(settled, 'agree() must not resolve before its budget is spent').to.equal(false);

        await clock.tickAsync(2);
        let verdict = await p;

        expect(verdict).to.equal(null);
        expect(outcome.inconclusive).to.equal(true);
        // The TIME budget, distinct from the spend budget's 'budget_exhausted'.
        expect(outcome.reason).to.equal('judge_timeout');
        expect(Date.now() - startedAt).to.be.at.most(BUDGET_MS + 50);
        // The ladder stopped at the model that hung; nothing walked past it and
        // spent a second budget.
        expect(dialled).to.deep.equal(['claude-haiku-4-5']);
    });

    it('does not let a fallback ladder spend the budget once per model', async function () {
        llm._setConfig({ additional_config: {
            judge_model: 'claude-haiku-4-5',
            judge_fallback_models: ['gpt-5-mini', 'claude-sonnet-4-6'],
            model_vendors: { 'gpt-5-mini': 'openai' }
        }});
        let dialled = [];
        llm._setJudgeCallForTest((opts) => { dialled.push(opts.model); return new Promise(() => {}); });

        let outcome = {};
        let startedAt = Date.now();
        let p = llm.agree(PROPOSALS, {
            timeoutMs: BUDGET_MS,
            outcome: outcome,
            pinnedApprovedModels: ['claude-sonnet-4-6']
        });
        await clock.tickAsync(BUDGET_MS + 1);
        let verdict = await p;

        expect(verdict).to.equal(null);
        expect(outcome.reason).to.equal('judge_timeout');
        // One budget for the whole chain, not one per rung: three models are
        // configured and the wall lands at BUDGET_MS, not at 3 x BUDGET_MS.
        expect(Date.now() - startedAt).to.be.at.most(BUDGET_MS + 50);
        expect(dialled).to.deep.equal(['claude-haiku-4-5']);
    });

    it('still returns a real verdict, and its identity, when the judge answers inside the budget', async function () {
        // Falsifies the two above: if the wall were unconditional they would pass
        // against an agree() that never returns anything.
        llm._setJudgeCallForTest(async () => JSON.stringify({ equivalent: true, canonical_index: 2 }));

        let outcome = {};
        let p = llm.agree(PROPOSALS, {
            timeoutMs: BUDGET_MS,
            outcome: outcome,
            pinnedApprovedModels: ['claude-sonnet-4-6']
        });
        await clock.tickAsync(1);
        let verdict = await p;

        expect(verdict, 'a judge that answers must still produce a winner').to.not.equal(null);
        expect(verdict.body.toString()).to.equal('b');
        expect(verdict.meta).to.equal('claude-sonnet-4-6');
        expect(outcome.inconclusive).to.equal(undefined);
    });
});
