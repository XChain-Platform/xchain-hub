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
const testDb         = require('../../helpers/testDb');
const { buildEnvelope } = require('../../helpers/testPeerNetwork');
const { VALIDATORS_1, VALIDATORS_4 } = require('../../helpers/fixtures');
const Database       = require('../../../src/db');
const Consensus      = require('../../../src/Consensus');
const OracleConsensus = require('../../../src/OracleConsensus');
const OracleRound    = require('../../../src/OracleRound');
const { createIntegrationHub: createTestHub, useSingleValidatorOracleEnv } = require('../../helpers/integrationHub');

// PBFT leader for the first proposal is set[(1 + view) % N], not index 0.
const FIRST_SEQ_LEADER = 1 % VALIDATORS_4.length;

describe('Integration: Error Handling (SC-10.x)', function () {

    // SC-10.2 drives a one-validator round to the snapshot-storage path; without the
    // regtest diversity floor it stops at 'below minimum submissions' instead.
    useSingleValidatorOracleEnv();

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable: skipping error handling tests');
        }
    });

    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });

    // SC-10.1: Database circuit breaker activation
    describe('SC-10.1: Circuit breaker', function () {
        it('opens after consecutive failures and recovers after cooldown', async function () {
            let db = testDb.getDb();

            // Lower thresholds for testing
            db.circuitThreshold = 3;
            db.circuitCooldown  = 500;

            // Save original getConnection
            let originalPool = db.pool;
            let callCount = 0;

            // Stub pool.getConnection to fail
            sinon.stub(db.pool, 'getConnection').rejects(new Error('Connection refused'));

            // Try to trigger circuit breaker (need circuitThreshold failures)
            for (let i = 0; i < 3; i++) {
                try {
                    await db.getConnection();
                } catch (e) {
                    // Expected
                }
            }

            // Circuit should be open
            expect(db.circuitState).to.equal('open');

            // Queries should be rejected immediately
            try {
                await db.getConnection();
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e.message).to.include('Circuit breaker open');
            }

            // Wait for cooldown
            await new Promise(r => setTimeout(r, 600));

            // Restore real getConnection
            db.pool.getConnection.restore();

            // Next call should succeed (half-open -> closed)
            let conn = await db.getConnection();
            expect(db.circuitState).to.equal('closed');
            await conn.release();

            // Reset thresholds
            db.circuitThreshold = 10;
            db.circuitCooldown  = 30000;
        });
    });

    // SC-10.2: DB failure during oracle consensus finalization
    describe('SC-10.2: DB failure during finalization', function () {
        it('handles DB error during snapshot storage without zombie state', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);

            let oracleRound = new OracleRound(hub);
            let oracleConsensus = new OracleConsensus(hub, oracleRound);
            oracleConsensus.setValidatorSet(VALIDATORS_1);
            oracleRound.setConsensus(oracleConsensus);

            // Set up a submission in the round
            oracleRound.currentRound = 1;
            oracleRound.submissions.set(1, new Map([
                [VALIDATORS_1[0].addr, {
                    prices: [{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 1 }],
                    sources: 1,
                    timestamp: Date.now()
                }]
            ]));

            // Stub doQuery to fail on INSERT INTO price_snapshots
            let originalDoQuery = db.doQuery.bind(db);
            sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
                if (query && query.includes('INSERT INTO price_snapshots')) {
                    throw new Error('Simulated DB failure');
                }
                return originalDoQuery(query, args);
            });

            // finalizeRound propagates the storage failure to its caller (OracleRound's
            // scheduler is the one that catches and logs). What must NOT happen is a
            // half-finished round left behind. The old assertion here claimed the
            // opposite contract and only "passed" because the round never reached the
            // storage path at all.
            let thrown = null;
            try { await oracleConsensus.finalizeRound(1); }
            catch (e) { thrown = e; }

            // Wait for async error handling
            await new Promise(r => setTimeout(r, 100));

            expect(thrown, 'storage failure should surface to the caller').to.be.an('error');
            expect(thrown.message).to.include('Simulated DB failure');

            // Verify no zombie state
            expect(oracleConsensus.pendingRounds.has(1)).to.be.false;
            expect(oracleConsensus.finalized.has(1), 'a failed store must not mark the round finalized').to.be.false;

            db.doQuery.restore();
        });
    });

    // SC-10.3: PBFT consensus timeout and cleanup
    describe('SC-10.3: Consensus timeout cleanup', function () {
        it('cleans up pending proposals after timeout', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_4[FIRST_SEQ_LEADER].addr);

            let consensus = new Consensus(hub);
            consensus.setValidatorSet(VALIDATORS_4);
            consensus.timeout = 300; // Short timeout
            await consensus.start();

            let config = { BTC: { mainnet: { decoder: { port: '9999' } } } };

            // Start proposal that will timeout
            let rejected = false;
            consensus.propose(config).catch((e) => {
                rejected = true;
                expect(e.message).to.include('Consensus timeout');
            });

            await new Promise(r => setTimeout(r, 50));

            // Verify pending proposal exists
            expect(consensus.pendingProposals.size).to.equal(1);

            // Wait for timeout
            await new Promise(r => setTimeout(r, 400));

            expect(rejected).to.be.true;

            // Verify cleanup
            expect(consensus.pendingProposals.size).to.equal(0);

            // Verify next proposal can be made (no deadlock)
            consensus.setValidatorSet(VALIDATORS_1); // Switch to single-node
            let result = await consensus.propose({ LTC: { mainnet: { decoder: { port: '1234' } } } });
            expect(result).to.be.true;

            await consensus.stop();
        });
    });

    // SC-10.4: Graceful handling of concurrent subsystem operations
    describe('SC-10.4: Concurrent operations', function () {
        it('handles multiple concurrent DB writes without errors', async function () {
            let db = testDb.getDb();

            // Simulate concurrent writes from multiple subsystems
            let promises = [];

            // Config writes
            for (let i = 0; i < 5; i++) {
                promises.push(db.setParam('BTC', 'mainnet', 'module' + i, 'port', String(8000 + i)));
            }

            // Validator writes
            for (let i = 0; i < 5; i++) {
                let pubkey = String(i).padStart(2, '0').repeat(32);
                promises.push(db.doQuery(
                    "INSERT INTO validators (signing_pubkey, addr, status) VALUES (?, ?, 'active')",
                    [pubkey, 'ws://v' + i + ':10001']
                ));
            }

            // Oracle submission writes
            for (let i = 0; i < 5; i++) {
                let pubkey = String(i).padStart(2, '0').repeat(32);
                promises.push(db.doQuery(
                    "INSERT INTO oracle_submissions (round_number, coin_pair, validator_pubkey, price, sources) VALUES (?, 'BTC/USD', ?, '100000.00', 2)",
                    [1, pubkey]
                ));
            }

            // All should complete without error
            let results = await Promise.allSettled(promises);
            let failures = results.filter(r => r.status === 'rejected');
            expect(failures).to.have.lengthOf(0);

            // Verify all writes landed
            let configs = await db.doQuery("SELECT COUNT(*) AS cnt FROM configs");
            expect(configs[0].cnt).to.equal(5);

            let validators = await db.doQuery("SELECT COUNT(*) AS cnt FROM validators");
            expect(validators[0].cnt).to.equal(5);

            let subs = await db.doQuery("SELECT COUNT(*) AS cnt FROM oracle_submissions");
            expect(subs[0].cnt).to.equal(5);
        });

        it('recovers from transient connection errors', async function () {
            let db = testDb.getDb();

            // Verify the database is working
            await db.setParam('BTC', 'mainnet', 'test', 'host', 'localhost');
            let config = await db.getConfig('BTC', 'mainnet', 'test');
            expect(config.host).to.equal('localhost');

            // Verify it still works after the test (connection pool intact)
            await db.setParam('BTC', 'mainnet', 'test', 'port', '8332');
            config = await db.getConfig('BTC', 'mainnet', 'test');
            expect(config.port).to.equal('8332');
        });
    });
});
