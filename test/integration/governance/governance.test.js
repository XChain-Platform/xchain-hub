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

const sinon          = require('sinon');
const { expect }     = require('chai');
const EventEmitter   = require('events');
const testDb         = require('../../helpers/testDb');
const { VALIDATORS_4 } = require('../../helpers/fixtures');
const Governance     = require('../../../src/Governance');
const ValidatorIdentity = require('../../../src/ValidatorIdentity');

// Generate fixed test keypairs
const TEST_KEYS = [];
for (let i = 0; i < 4; i++) {
    TEST_KEYS.push(ValidatorIdentity.generate());
}

function createTestHub(db, keyIndex) {
    let ki = keyIndex || 0;
    let identity = new ValidatorIdentity(TEST_KEYS[ki].privkeyHex);

    let pm = new EventEmitter();
    pm.validatorAddr    = VALIDATORS_4[ki].addr;
    pm.validatorPubkeys = new Map();
    pm.broadcast        = sinon.stub().returns({});
    pm.getPeerStatus    = sinon.stub().returns([]);

    // Build validator set using our test pubkeys
    let validatorSet = VALIDATORS_4.map((v, i) => ({
        pubkey: TEST_KEYS[i].pubkeyHex,
        addr:   v.addr
    }));

    return {
        db: db,
        p2pConfig: {},
        getPeerManager: sinon.stub().returns(pm),
        getIdentity:    sinon.stub().returns(identity),
        getOracle:      sinon.stub().returns(null),
        getConsensus:   sinon.stub().returns(null),
        getCrossChain:  sinon.stub().returns(null),
        _peerManager:   pm,
        _validatorSet:  validatorSet,
        _identity:      identity
    };
}

describe('Integration: Governance (SC-7.x)', function () {

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable: skipping governance tests');
        }
    });

    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });

    // SC-7.1: Proposal creation to passage
    describe('SC-7.1: Proposal passage', function () {
        it('passes proposal with 2/3+ approval', async function () {
            let db = testDb.getDb();
            let hub0 = createTestHub(db, 0);

            let gov = new Governance(hub0);
            gov.setValidatorSet(hub0._validatorSet);
            gov.votingPeriod = 1000; // 1 second for testing

            // Create proposal
            let proposal = await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '900000', 'Increase round interval');
            expect(proposal.status).to.equal('voting');
            expect(proposal.proposalId).to.include('gov:ORACLE_ROUND_INTERVAL:');

            // Vote from 3 validators (3/4 > 2/3)
            for (let i = 0; i < 3; i++) {
                let identity = new ValidatorIdentity(TEST_KEYS[i].privkeyHex);
                let govVoter = new Governance(createTestHub(db, i));
                govVoter.setValidatorSet(hub0._validatorSet);

                await govVoter.vote(proposal.proposalId, 'approve');
            }

            // End the voting window by moving its deadline into the past: the tally
            // reads voting_end, so this is exactly what the sleep was buying, and it
            // cannot lose a race with a busy box.
            await db.doQuery("UPDATE governance_proposals SET voting_end = ? WHERE proposal_id = ?",
                [new Date(Date.now() - 1000), proposal.proposalId]);

            // Tally
            let proposalRow = await db.doQuery(
                "SELECT * FROM governance_proposals WHERE proposal_id = ?",
                [proposal.proposalId]
            );
            // Force tally
            await gov._tallyProposal(proposalRow[0]);

            // Verify passed
            let result = await db.doQuery(
                "SELECT status FROM governance_proposals WHERE proposal_id = ?",
                [proposal.proposalId]
            );
            expect(result[0].status).to.equal('passed');

            // Verify votes stored
            let votes = await db.doQuery(
                "SELECT * FROM governance_votes WHERE proposal_id = ?",
                [proposal.proposalId]
            );
            expect(votes).to.have.lengthOf(3);
        });
    });

    // SC-7.2: Proposal rejection (insufficient approval)
    describe('SC-7.2: Proposal rejection', function () {
        it('fails proposal with insufficient approval', async function () {
            let db = testDb.getDb();
            let hub0 = createTestHub(db, 0);

            let gov = new Governance(hub0);
            gov.setValidatorSet(hub0._validatorSet);
            gov.votingPeriod = 500;

            let proposal = await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '700000', 'Small increase');

            // 2 approve, 2 reject (50% approval < 66.7% threshold)
            for (let i = 0; i < 2; i++) {
                let govVoter = new Governance(createTestHub(db, i));
                govVoter.setValidatorSet(hub0._validatorSet);
                await govVoter.vote(proposal.proposalId, 'approve');
            }
            for (let i = 2; i < 4; i++) {
                let govVoter = new Governance(createTestHub(db, i));
                govVoter.setValidatorSet(hub0._validatorSet);
                await govVoter.vote(proposal.proposalId, 'reject');
            }

            await db.doQuery("UPDATE governance_proposals SET voting_end = ? WHERE proposal_id = ?",
                [new Date(Date.now() - 1000), proposal.proposalId]);

            let proposalRow = await db.doQuery(
                "SELECT * FROM governance_proposals WHERE proposal_id = ?", [proposal.proposalId]
            );
            await gov._tallyProposal(proposalRow[0]);

            let result = await db.doQuery(
                "SELECT status FROM governance_proposals WHERE proposal_id = ?", [proposal.proposalId]
            );
            expect(result[0].status).to.equal('failed');
        });
    });

    // SC-7.3: Change bound validation
    describe('SC-7.3: Change bounds', function () {
        it('rejects proposal exceeding 50% increase', async function () {
            let db = testDb.getDb();
            let hub0 = createTestHub(db, 0);

            let gov = new Governance(hub0);
            gov.setValidatorSet(hub0._validatorSet);

            try {
                await gov.propose('ORACLE_ROUND_INTERVAL', '100', '200', 'Double it');
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e.message).to.include('exceeds maximum');
            }

            // Verify no proposal created in DB
            let proposals = await db.doQuery("SELECT * FROM governance_proposals");
            expect(proposals).to.have.lengthOf(0);
        });

        it('rejects slashing param exceeding 25% increase', async function () {
            let db = testDb.getDb();
            let hub0 = createTestHub(db, 0);

            let gov = new Governance(hub0);
            gov.setValidatorSet(hub0._validatorSet);

            try {
                await gov.propose('SLASH_DEVIATION_THRESHOLD', '0.05', '0.07', 'Increase slash');
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e.message).to.include('exceeds maximum');
            }
        });

        it('accepts proposal within bounds', async function () {
            let db = testDb.getDb();
            let hub0 = createTestHub(db, 0);

            let gov = new Governance(hub0);
            gov.setValidatorSet(hub0._validatorSet);

            // 40% increase is within 50% limit
            let proposal = await gov.propose('ORACLE_ROUND_INTERVAL', '100', '140', 'Moderate increase');
            expect(proposal.status).to.equal('voting');
        });
    });

    // SC-7.4: Cooldown enforcement
    describe('SC-7.4: Cooldown after rejection', function () {
        it('blocks re-proposal within 14-day cooldown', async function () {
            let db = testDb.getDb();
            let hub0 = createTestHub(db, 0);

            let gov = new Governance(hub0);
            gov.setValidatorSet(hub0._validatorSet);
            gov.votingPeriod = 100;

            // Create and fail a proposal
            let proposal = await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '700000', 'Test');

            await db.doQuery("UPDATE governance_proposals SET voting_end = ? WHERE proposal_id = ?",
                [new Date(Date.now() - 1000), proposal.proposalId]);
            let proposalRow = await db.doQuery(
                "SELECT * FROM governance_proposals WHERE proposal_id = ?", [proposal.proposalId]
            );
            await gov._tallyProposal(proposalRow[0]); // No votes = failed

            // Try to re-propose immediately
            try {
                await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '700000', 'Retry');
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e.message).to.include('Cooldown');
            }
        });
    });

    // SC-7.5: Non-validator proposal attempt
    describe('SC-7.5: Non-validator proposal', function () {
        it('rejects proposal from non-validator', async function () {
            let db = testDb.getDb();

            // Use a keypair that's NOT in the validator set
            let outsider = ValidatorIdentity.generate();
            let identity = new ValidatorIdentity(outsider.privkeyHex);

            let pm = new EventEmitter();
            pm.validatorAddr = 'ws://outsider:10001';
            pm.broadcast = sinon.stub().returns({});
            pm.getPeerStatus = sinon.stub().returns([]);

            let hub = {
                db: db,
                p2pConfig: {},
                getPeerManager: sinon.stub().returns(pm),
                getIdentity:    sinon.stub().returns(identity),
                _peerManager:   pm
            };

            let gov = new Governance(hub);
            // Validator set uses TEST_KEYS pubkeys, not outsider's
            gov.setValidatorSet(VALIDATORS_4.map((v, i) => ({
                pubkey: TEST_KEYS[i].pubkeyHex,
                addr:   v.addr
            })));

            try {
                await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '700000', 'From outsider');
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });
    });
});
