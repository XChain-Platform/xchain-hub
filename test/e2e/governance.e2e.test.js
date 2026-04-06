'use strict';

const { expect }    = require('chai');
const testDb        = require('../helpers/testDb');
const priceMocks    = require('./helpers/priceMocks');
const { createCluster } = require('./helpers/cluster');
const { callRpc }       = require('./helpers/rpcClient');

describe('E2E: Governance Pipeline', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E governance tests');
            return;
        }
        priceMocks.setup();
    });

    after(async function () {
        this.timeout(10000);
        priceMocks.teardown();
        await testDb.teardown();
    });

    beforeEach(async function () {
        this.timeout(15000);
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        priceMocks.reset();
    });

    afterEach(async function () {
        this.timeout(10000);
        if (cluster) {
            await cluster.stop();
            cluster = null;
        }
    });

    // E2E-GOV-001: Propose → vote → tally → passed
    describe('E2E-GOV-001: Proposal lifecycle — approve', function () {

        it('proposal passes with validator approval and tally', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);
            let db = cluster.getDb();

            // Insert proposal directly (workaround: db.doQuery converts Date to invalid string)
            let proposalId = 'gov:ORACLE_ROUND_INTERVAL:' + Date.now();
            let pubkey = cluster.getKeypair(0).pubkeyHex;
            await db.doQuery(
                `INSERT INTO governance_proposals
                    (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                     rationale, status, voting_start, voting_end)
                 VALUES (?, ?, ?, ?, ?, ?, 'voting', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY))`,
                [proposalId, pubkey, 'ORACLE_ROUND_INTERVAL', '600000', '450000', 'Faster updates']
            );

            // Vote approve via JSON-RPC
            let voteRes = await callRpc(port, 'vote', { proposal_id: proposalId, vote: 'approve' });
            expect(voteRes.result.error).to.not.exist;

            // Verify proposal in voting state
            let proposal = await callRpc(port, 'getproposal', { proposal_id: proposalId });
            expect(proposal.result.proposal).to.exist;
            expect(proposal.result.proposal.status).to.equal('voting');

            // Force expire the voting period and trigger tally
            await db.doQuery(
                "UPDATE governance_proposals SET voting_end = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE proposal_id = ?",
                [proposalId]
            );
            await cluster.triggerGovernanceTally(0);

            // Verify proposal passed
            let updated = await callRpc(port, 'getproposal', { proposal_id: proposalId });
            expect(updated.result.proposal.status).to.equal('passed');

            // Verify it shows in getproposals filtered by status
            let passed = await callRpc(port, 'getproposals', { status: 'passed' });
            expect(passed.result).to.be.an('array');
            expect(passed.result.some(p => p.proposal_id === proposalId)).to.be.true;
        });
    });

    // E2E-GOV-002: Rejection and cooldown
    describe('E2E-GOV-002: Proposal rejection and cooldown', function () {

        it('rejected proposal triggers cooldown preventing re-proposal', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);
            let db = cluster.getDb();
            let pubkey = cluster.getKeypair(0).pubkeyHex;

            // Insert proposal directly (workaround: db.doQuery Date conversion bug)
            let proposalId = 'gov:ORACLE_ROUND_INTERVAL:' + Date.now();
            await db.doQuery(
                `INSERT INTO governance_proposals
                    (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                     rationale, status, voting_start, voting_end)
                 VALUES (?, ?, ?, ?, ?, ?, 'voting', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY))`,
                [proposalId, pubkey, 'ORACLE_ROUND_INTERVAL', '600000', '450000', 'Test']
            );

            await callRpc(port, 'vote', { proposal_id: proposalId, vote: 'reject' });

            // Force expire and tally
            await db.doQuery(
                "UPDATE governance_proposals SET voting_end = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE proposal_id = ?",
                [proposalId]
            );
            await cluster.triggerGovernanceTally(0);

            // Verify it failed
            let updated = await callRpc(port, 'getproposal', { proposal_id: proposalId });
            expect(updated.result.proposal).to.exist;
            expect(updated.result.proposal.status).to.equal('failed');

            // Try to re-propose the same parameter — should be blocked by cooldown
            let retryRes = await callRpc(port, 'propose', {
                parameter: 'ORACLE_ROUND_INTERVAL', current_value: '600000',
                proposed_value: '450000', rationale: 'Retry'
            });
            expect(retryRes.result.error).to.include('Cooldown');
        });
    });

    // E2E-GOV-003: Change bounds enforcement
    describe('E2E-GOV-003: Change bounds enforcement', function () {

        it('rejects proposal exceeding max increase (50%)', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Try to double the value (100% increase, exceeds 50% limit)
            let res = await callRpc(port, 'propose', {
                parameter: 'ORACLE_ROUND_INTERVAL', current_value: '600000',
                proposed_value: '1200000', rationale: 'Too much'
            });
            expect(res.result.error).to.include('exceeds maximum');
        });

        it('rejects proposal exceeding max decrease (33%)', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Try to halve the value (50% decrease, exceeds 33% limit)
            let res = await callRpc(port, 'propose', {
                parameter: 'ORACLE_ROUND_INTERVAL', current_value: '600000',
                proposed_value: '300000', rationale: 'Too much decrease'
            });
            expect(res.result.error).to.include('exceeds maximum');
        });

        it('accepts proposal within bounds', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // 20% increase — within 50% limit
            let res = await callRpc(port, 'propose', {
                parameter: 'ORACLE_ROUND_INTERVAL', current_value: '600000',
                proposed_value: '720000', rationale: 'Within bounds'
            });
            expect(res.result.status).to.equal('voting');
        });

        it('applies stricter bounds for slashing parameters', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // 30% increase on slash param — exceeds 25% limit for slashing
            let res = await callRpc(port, 'propose', {
                parameter: 'SLASH_DEVIATION_THRESHOLD', current_value: '0.05',
                proposed_value: '0.065', rationale: 'Too much for slash param'
            });
            expect(res.result.error).to.include('exceeds maximum');
        });
    });

    // E2E-GOV: Non-validator cannot propose
    describe('E2E-GOV: Authorization', function () {

        it('rejects proposal from non-validator (no identity)', async function () {
            this.timeout(15000);

            // Create a hub without P2P config (no validator identity)
            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Remove the validator from DB to simulate non-validator
            let db = cluster.getDb();
            await db.doQuery("UPDATE validators SET status = 'removed' WHERE 1=1");

            // Reload validator set
            let hub = cluster.getHub(0);
            if (hub.governance) {
                hub.governance.setValidatorSet([]);
            }

            let res = await callRpc(port, 'propose', {
                parameter: 'TEST', current_value: '1', proposed_value: '2', rationale: 'Test'
            });
            expect(res.result.error).to.include('not an active validator');
        });
    });
});
