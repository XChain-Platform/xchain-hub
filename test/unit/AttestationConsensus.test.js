'use strict';

const sinon                = require('sinon');
const { expect }           = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const { createMockHub }    = require('../helpers/mockHub');

// Minimal provider registry — the COMMIT/buffer paths exercised here never
// call into a provider (no agree() / no def lookups for unsigned commits).
function makeProviderRegistry() {
    return {
        getDef:    sinon.stub().returns(null),
        getModule: sinon.stub().returns(null)
    };
}

describe('AttestationConsensus', function () {

    let hub, consensus;

    beforeEach(function () {
        hub = createMockHub();
        consensus = new AttestationConsensus(hub, makeProviderRegistry());
    });

    afterEach(function () {
        for (let [, p] of consensus.pending) {
            if (p.timer) clearTimeout(p.timer);
        }
        sinon.restore();
    });

    // Build a `pending` in the post-PROPOSE / pre-winner window: the round
    // exists but provider.agree() (async) hasn't yet set a winner. This is the
    // exact window in which a fast peer's COMMIT can arrive.
    function seedPendingNoWinner(rid, peerPubkey) {
        let pending = {
            requestId:   rid,
            providerId:  'http_get',
            redundancy:  3,
            quorum:      3,
            responsible: [{ pubkey: peerPubkey }],
            commits:     new Set(),
            prepares:    new Set(),
            signatures:  new Map(),
            winner:      null,
            status:      'ok',
            finalized:   false,
            timer:       null
        };
        consensus.pending.set(rid, pending);
        return pending;
    }

    // Unsigned COMMIT envelope — omitting `sig` skips signature verification in
    // _handleCommit, so the test asserts vote-counting (commits.add) without
    // needing real validator crypto. The buffering decision under test happens
    // before any signature check regardless.
    function commitEnvelope(rid, peerPubkey) {
        return { type: 'ATTEST_COMMIT', data: { requestId: rid, sig_pubkey: peerPubkey } };
    }

    describe('_handleCommit — early COMMIT (before winner is set)', function () {

        const RID  = 'deadbeefdeadbeefdeadbeefdeadbeef';
        const PEER = '11'.repeat(32);

        it('buffers an early COMMIT instead of silently dropping it', function () {
            let pending = seedPendingNoWinner(RID, PEER);

            // Route through the public dispatch path, mirroring the drain.
            consensus._handleMessage(commitEnvelope(RID, PEER));

            // The vote is held, NOT applied yet (winner not known) and — the
            // regression this guards — NOT discarded.
            expect(consensus.earlyCommits.get(RID)).to.have.lengthOf(1);
            expect(pending.commits.size).to.equal(0);
        });

        it('counts the buffered COMMIT once the winner is established and drained', function () {
            let pending = seedPendingNoWinner(RID, PEER);
            consensus._handleCommit(commitEnvelope(RID, PEER));
            expect(pending.commits.size).to.equal(0);

            // Winner gets established (provider.agree() resolved); drain replays
            // the buffered COMMIT so the peer's vote now counts toward quorum.
            pending.winner = { body: Buffer.from('winning-body'), meta: '' };
            consensus._drainEarlyCommits(RID);

            expect(pending.commits.has(PEER)).to.equal(true);
            expect(consensus.earlyCommits.has(RID)).to.equal(false);
        });

        it('caps the per-request early-commit buffer', function () {
            seedPendingNoWinner(RID, PEER);
            let over = consensus.earlyCommitMaxPerRid + 5;
            for (let i = 0; i < over; i++) {
                consensus._handleCommit(commitEnvelope(RID, PEER));
            }
            expect(consensus.earlyCommits.get(RID).length).to.equal(consensus.earlyCommitMaxPerRid);
        });
    });

    describe('_handleCommit — COMMIT after winner is set', function () {

        const RID  = 'cafecafecafecafecafecafecafecafe';
        const PEER = '22'.repeat(32);

        it('applies the vote directly without buffering', function () {
            let pending = seedPendingNoWinner(RID, PEER);
            pending.winner = { body: Buffer.from('winning-body'), meta: '' };

            consensus._handleCommit(commitEnvelope(RID, PEER));

            expect(pending.commits.has(PEER)).to.equal(true);
            expect(consensus.earlyCommits.has(RID)).to.equal(false);
        });
    });

    describe('_handleCommit — COMMIT before the round exists', function () {

        const RID  = 'f00df00df00df00df00df00df00df00d';
        const PEER = '33'.repeat(32);

        it('still buffers in earlyMessages (unchanged !pending behavior)', function () {
            // No pending for RID — the pre-existing early-arrival path must
            // still capture the COMMIT for replay in propose().
            consensus._handleCommit(commitEnvelope(RID, PEER));

            expect(consensus.earlyMessages.get(RID)).to.have.lengthOf(1);
            expect(consensus.earlyCommits.has(RID)).to.equal(false);
        });
    });
});
