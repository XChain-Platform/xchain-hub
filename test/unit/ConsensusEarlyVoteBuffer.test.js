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
//
// The config-change twin of finding F7 (already pinned for OracleConsensus and
// AttestationConsensus): a PREPARE/COMMIT that arrives before this hub has
// opened the round it votes on used to be dropped with nothing left to
// re-deliver it.
//
// _handlePrePrepare is async - it locks the validator snapshot at the leader's
// block boundary - while the vote handlers are synchronous, and the whole PBFT
// burst completes inside that window. It bites hardest under
// STAKE_WEIGHTED_QUORUM: a leader holding more than two thirds of the stake
// meets the threshold on its own vote, so it sends PRE_PREPARE and COMMIT back
// to back, and a follower that loses that race never applies the config the
// federation just finalized. Nothing retries: the leader has already resolved,
// and the remaining small COMMITs cannot carry the threshold between them.

const sinon      = require('sinon');
const { expect } = require('chai');
const Consensus  = require('../../src/Consensus');
const { createMockHub } = require('../helpers/mockHub');
const { WEIGHTED_VALIDATORS_4, makeWeightSnapshot, pubkeyForTestSender } = require('../helpers/fixtures');

// S = 1000 + 100 + 100 + 100 = 1300. The whale alone clears 3*1000 > 2*1300;
// the three small sources together (300) never do. Sorted by pubkey, the whale
// is member 0, so it leads every seq where seq % 4 === 0.
const WHALE = WEIGHTED_VALIDATORS_4[0];
const SELF  = WEIGHTED_VALIDATORS_4[1];
const PEER  = WEIGHTED_VALIDATORS_4[2];
const SEQ   = 4;
const BLOCK = 800000;
const CONFIG = { BTC: { regtest: { node: { GAS_PRICE: '700700' } } } };

function prePrepareEnvelope(consensus, seq) {
    return {
        type:       'PBFT_PRE_PREPARE',
        sender:     WHALE.addr,
        sig_pubkey:     WHALE.pubkey,
        sig_pubkey: WHALE.pubkey,
        data: {
            seq:            seq === undefined ? SEQ : seq,
            view:           0,
            config:         CONFIG,
            configDigest:   consensus._digest(CONFIG),
            btcBlockHeight: BLOCK
        }
    };
}

function voteEnvelope(type, validator, digest, seq) {
    return {
        type:       type,
        sender:     validator.addr,
        sig_pubkey:     validator.pubkey,
        sig_pubkey: validator.pubkey,
        data:       { seq: seq === undefined ? SEQ : seq, configDigest: digest }
    };
}

describe('Consensus: early-arrival vote buffer (config-change PBFT)', function () {

    let hub, consensus, digest;

    beforeEach(function () {
        const identity = {
            getPubkeyHex: sinon.stub().returns(SELF.pubkey),
            sign:         sinon.stub().returns('bb'.repeat(64)),
            signEnvelope: sinon.stub().returns('cc'.repeat(64))
        };
        const validatorPubkeys = new Map(WEIGHTED_VALIDATORS_4.map((v) => [v.addr, v.pubkey]));

        hub = createMockHub({ validatorAddr: SELF.addr, identity, validatorPubkeys });
        hub.network = 'regtest';                 // STAKE_WEIGHTED_QUORUM active from height 0
        hub.capabilitySnapshot = {
            getActiveWeightSnapshot:    sinon.stub().resolves(makeWeightSnapshot(WEIGHTED_VALIDATORS_4, BLOCK)),
            getActiveValidatorSnapshot: sinon.stub().resolves(makeWeightSnapshot(WEIGHTED_VALIDATORS_4, BLOCK)),
            getQuorum:                  sinon.stub().returns(3)
        };
        hub._resolveBtcLatestBlock = sinon.stub().resolves(BLOCK);

        consensus = new Consensus(hub);
        consensus.setValidatorSet(WEIGHTED_VALIDATORS_4);
        digest = consensus._digest(CONFIG);
    });

    afterEach(function () {
        for (let [, prop] of consensus.pendingProposals) {
            if (prop && prop.timer) clearTimeout(prop.timer);
        }
        sinon.restore();
    });

    describe('holding a vote for a round that is not open yet', function () {

        it('buffers a COMMIT instead of dropping it', function () {
            consensus._handleCommit(voteEnvelope('PBFT_COMMIT', WHALE, digest));
            expect(consensus.pendingProposals.has(SEQ)).to.be.false;
            expect(consensus.earlyVotes.get(SEQ)).to.have.length(1);
        });

        it('buffers a PREPARE instead of dropping it', function () {
            consensus._handlePrepare(voteEnvelope('PBFT_PREPARE', PEER, digest));
            expect(consensus.earlyVotes.get(SEQ)).to.have.length(1);
        });

        it('does not buffer a vote from an unregistered sender', function () {
            // The known-sender guard runs before the buffer, so the buffer can
            // never become a way in for a sender the tally would refuse.
            consensus._handleCommit({
                type: 'PBFT_COMMIT', sender: 'ws://stranger:10009', sig_pubkey: pubkeyForTestSender('ws://stranger:10009'),
                data: { seq: SEQ, configDigest: digest }
            });
            expect(consensus.earlyVotes.has(SEQ)).to.be.false;
        });

        it('does not buffer a vote for an already-applied round', function () {
            consensus.lastAppliedSeq = SEQ;
            consensus._handleCommit(voteEnvelope('PBFT_COMMIT', WHALE, digest));
            expect(consensus.earlyVotes.has(SEQ)).to.be.false;
        });
    });

    describe('bounds (the sender picks seq, so both dimensions are capped)', function () {

        it('caps the votes held per seq', function () {
            for (let i = 0; i < 200; i++) {
                consensus._bufferEarlyVote(voteEnvelope('PBFT_COMMIT', WHALE, digest));
            }
            expect(consensus.earlyVotes.get(SEQ).length).to.equal(64);
        });

        it('caps the number of distinct seqs and evicts the oldest first', function () {
            for (let s = 1; s <= 500; s++) {
                consensus._bufferEarlyVote(voteEnvelope('PBFT_COMMIT', WHALE, digest, s));
            }
            expect(consensus.earlyVotes.size).to.equal(64);
            expect(consensus.earlyVotes.has(1)).to.be.false;     // evicted (FIFO)
            expect(consensus.earlyVotes.has(500)).to.be.true;
            expect(consensus.earlyVoteTtl.size).to.equal(64);    // the TTL map cannot outgrow it
        });

        it('drops votes older than the round timeout', function () {
            consensus._bufferEarlyVote(voteEnvelope('PBFT_COMMIT', WHALE, digest));
            expect(consensus.earlyVotes.has(SEQ)).to.be.true;
            consensus._pruneEarlyVotes(Date.now() + consensus.timeout + 1);
            expect(consensus.earlyVotes.has(SEQ)).to.be.false;
            expect(consensus.earlyVoteTtl.has(SEQ)).to.be.false;
        });

        it('is cleared when the engine stops', async function () {
            consensus._bufferEarlyVote(voteEnvelope('PBFT_COMMIT', WHALE, digest));
            await consensus.stop();
            expect(consensus.earlyVotes.size).to.equal(0);
            expect(consensus.earlyVoteTtl.size).to.equal(0);
        });
    });

    describe('replay once the round opens', function () {

        it('applies the config from a whale COMMIT that beat the PRE_PREPARE', async function () {
            // The whale-COMMIT race, in order: the leader's COMMIT lands while this
            // hub is still locking its snapshot.
            consensus._handleCommit(voteEnvelope('PBFT_COMMIT', WHALE, digest));
            expect(consensus.earlyVotes.get(SEQ)).to.have.length(1);

            await consensus._handlePrePrepare(prePrepareEnvelope(consensus));
            await new Promise((r) => setImmediate(r));   // the apply is async

            expect(consensus.earlyVotes.has(SEQ), 'buffer must drain').to.be.false;
            expect(hub.applyConfig.calledOnce, 'the follower must apply the finalized config').to.be.true;
            expect(hub.applyConfig.firstCall.args[0]).to.deep.equal(CONFIG);
        });

        it('counts a replayed PREPARE toward this hub sending its own COMMIT', async function () {
            consensus._handlePrepare(voteEnvelope('PBFT_PREPARE', PEER, digest));

            await consensus._handlePrePrepare(prePrepareEnvelope(consensus));

            const proposal = consensus.pendingProposals.get(SEQ);
            expect(proposal, 'the round must be open').to.exist;
            expect(proposal.prepares.has(PEER.addr), 'the replayed PREPARE must be tallied').to.be.true;
        });

        it('ignores a replayed vote whose digest does not match the round', async function () {
            consensus._handleCommit(voteEnvelope('PBFT_COMMIT', WHALE, 'ff'.repeat(32)));

            await consensus._handlePrePrepare(prePrepareEnvelope(consensus));
            await new Promise((r) => setImmediate(r));

            const proposal = consensus.pendingProposals.get(SEQ);
            expect(proposal.commits.has(WHALE.addr), 'a mismatched digest must not be counted').to.be.false;
            expect(hub.applyConfig.called).to.be.false;
        });

        it('does not re-buffer a vote that finds the round already gone', function () {
            // A replay that still finds no proposal (the round expired) must not
            // land back in the buffer it was just drained from.
            consensus._bufferEarlyVote(voteEnvelope('PBFT_COMMIT', WHALE, digest));
            consensus._replayEarlyVotes(SEQ);
            expect(consensus.earlyVotes.has(SEQ)).to.be.false;
        });
    });
});
