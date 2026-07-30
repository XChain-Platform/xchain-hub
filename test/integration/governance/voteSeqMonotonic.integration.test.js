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

// Integration: GOV-VOTE-REPLAY-1  monotonic vote seq, against a real
// MariaDB.
//
// WHY THIS EXISTS SEPARATELY FROM THE UNIT SUITE. The replay guard is one atomic
// ON DUPLICATE KEY UPDATE with IF(VALUES(vote_seq) > COALESCE(vote_seq, 0), ...)
// and GREATEST(...). It is a single statement on purpose: _handleVote is
// fire-and-forget, so several gossiped copies of one voter's votes can be in
// flight together and a read-compare-write would let the loser land last. A
// stubbed db can only assert the statement's TEXT, which would pass just as
// happily if MariaDB evaluated it differently than intended. These tests assert
// the resulting ROW, which is the thing consensus actually tallies.
//
// The unit half (signed bytes, seq binding, refusal paths) is in
// test/unit/governanceVoteReplay.test.js.

const { expect }   = require('chai');
const testDb       = require('../../helpers/testDb');
const Governance   = require('../../../src/Governance');
const ValidatorIdentity = require('../../../src/ValidatorIdentity');
const { createMockHub } = require('../../helpers/mockHub');

const PROPOSAL = 'gov:MIN_STAKE:seq';

describe('Integration: governance vote seq is monotonic (GOV-VOTE-REPLAY-1)', function () {

    let db, gov, kp, idn;

    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.warn('MariaDB unavailable; skipping governance vote-seq tests');
        }
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) this.skip();
        await testDb.truncateAll();
        kp  = ValidatorIdentity.generate();
        idn = new ValidatorIdentity(kp.privkeyHex);
        let hub = createMockHub({ db });
        gov = new Governance(hub);
        gov.setValidatorSet([{ pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
    });

    after(async function () {
        if (gov && gov._tallyTimer) clearInterval(gov._tallyTimer);
        await testDb.teardown();
    });

    async function storedVote() {
        let rows = await db.doQuery(
            "SELECT vote, vote_seq FROM governance_votes WHERE proposal_id = ? AND voter_pubkey = ?",
            [PROPOSAL, kp.pubkeyHex]);
        return rows.length ? { vote: rows[0].vote, seq: Number(rows[0].vote_seq) } : null;
    }

    function sig(vote, seq) {
        return idn.sign(Governance.voteSigningPayload(PROPOSAL, vote, kp.pubkeyHex, seq));
    }

    it('the vote_seq column exists on the live table (schema drift migration applied it)', async function () {
        let cols = await db.doQuery(
            "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.columns " +
            "WHERE table_name = 'governance_votes' AND COLUMN_NAME = 'vote_seq'");
        expect(cols.length, 'vote_seq is present').to.equal(1);
        expect(String(cols[0].COLUMN_DEFAULT), 'pre- rows backfill to 0').to.equal('0');
    });

    it('THE ATTACK: replaying a captured earlier vote does NOT reinstate it', async function () {
        // The validator votes approve, then changes to reject. Both are genuine and
        // correctly signed at increasing seqs.
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 1000), 1000);
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'reject',  sig('reject', 2000),  2000);
        expect(await storedVote()).to.deep.equal({ vote: 'reject', seq: 2000 });

        // An attacker re-broadcasts the captured approve. Its signature is perfectly
        // valid, which is precisely why the pre-fix sink accepted it.
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 1000), 1000);

        expect(await storedVote(), 'the superseded approve did not come back')
            .to.deep.equal({ vote: 'reject', seq: 2000 });
    });

    it('an equal seq does not overwrite (idempotent redelivery is not a vote change)', async function () {
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'reject', sig('reject', 2000), 2000);
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 2000), 2000);
        expect((await storedVote()).vote, 'same seq cannot flip the choice').to.equal('reject');
    });

    it('a strictly greater seq DOES overwrite, so a validator can still change their vote', async function () {
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 1000), 1000);
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'reject',  sig('reject', 1001),  1001);
        expect(await storedVote()).to.deep.equal({ vote: 'reject', seq: 1001 });
    });

    it('a late-arriving loser cannot lower the stored seq (GREATEST keeps the bar up)', async function () {
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'reject', sig('reject', 5000), 5000);
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 10), 10);
        let after = await storedVote();
        expect(after.vote, 'choice unchanged').to.equal('reject');
        expect(after.seq, 'stored seq did not regress, so seq 11 cannot win next').to.equal(5000);
    });

    it('the stored signature always matches the stored vote after a refused replay', async function () {
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 1000), 1000);
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'reject',  sig('reject', 2000),  2000);
        await gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 1000), 1000);

        let rows = await db.doQuery(
            "SELECT vote, signature, vote_seq FROM governance_votes WHERE proposal_id = ? AND voter_pubkey = ?",
            [PROPOSAL, kp.pubkeyHex]);
        // A partial overwrite (new signature, old vote) would leave a row whose
        // evidence does not authenticate, and _ingestResultVotes would then drop
        // this voter on every follower. Prove they moved together.
        expect(ValidatorIdentity.verify(
            Governance.voteSigningPayload(PROPOSAL, rows[0].vote, kp.pubkeyHex, Number(rows[0].vote_seq)),
            rows[0].signature, kp.pubkeyHex),
            'stored (vote, signature, seq) is a self-consistent triple').to.equal(true);
    });

    it('concurrent copies of the same voter converge on the highest seq, in any arrival order', async function () {
        // The real hazard the single-statement guard exists for: _handleVote does not
        // await, so these interleave. Whatever order the DB serialises them in, every
        // hub must end up with the same row or the tally diverges.
        await Promise.all([
            gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 1000), 1000),
            gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'reject',  sig('reject', 3000),  3000),
            gov._upsertVote(PROPOSAL, kp.pubkeyHex, 'approve', sig('approve', 2000), 2000)
        ]);
        expect(await storedVote(), 'highest seq wins regardless of interleaving')
            .to.deep.equal({ vote: 'reject', seq: 3000 });
    });
});
