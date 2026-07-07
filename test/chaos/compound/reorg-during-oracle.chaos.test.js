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

const sinon      = require('sinon');
const { expect } = require('chai');
const crypto     = require('crypto');
const OracleRound     = require('../../../src/OracleRound');
const OracleConsensus = require('../../../src/OracleConsensus');
const ReorgHandler    = require('../../../src/ReorgHandler');
const { createMockHub }                = require('../../helpers/mockHub');
const { VALIDATORS_4, SAMPLE_PRICES }  = require('../../helpers/fixtures');
const { buildEnvelope }                = require('../../helpers/testPeerNetwork');
const { runExperiment }                = require('../helpers/chaosRunner');

describe('Chaos: Reorg During Oracle Round (XC-2)', function () {
    this.timeout(15000);

    let hub, oracle, oracleCon, reorgHandler;

    beforeEach(function () {
        hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        oracle = new OracleRound(hub);
        oracleCon = new OracleConsensus(hub, oracle);
        oracle.setConsensus(oracleCon);
        reorgHandler = new ReorgHandler(hub);
        // R2-C2: chaos experiments exercise the round/rollback interplay, not
        // the indexer probe (which has its own unit coverage).
        sinon.stub(reorgHandler, '_verifyReorgAgainstOwnNode').resolves(true);

        // Single-node mode for simpler testing
        oracleCon.validatorSet = [];
        reorgHandler.validatorSet = [];
        hub._peerManager.getPeerStatus.returns([]);

        hub.db.doQuery.resolves([]);

        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        oracle.stop();
        oracleCon.stop();
        reorgHandler.stop();
        sinon.restore();
    });

    it('reorg during active oracle round: both events complete independently', async function () {
        await oracleCon.start();
        await reorgHandler.start();

        // Start an oracle round with submissions
        oracle.currentRound = 10;
        oracle.submissions.set(10, new Map([
            [VALIDATORS_4[0].addr, { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() }]
        ]));

        // Track DB writes
        let dbCalls = [];
        hub.db.doQuery.callsFake((query, args) => {
            dbCalls.push({ query, args });
            return Promise.resolve([]);
        });

        await runExperiment({
            name: 'Reorg during oracle round',

            inject: async () => {
                // Fire both events concurrently
                await Promise.all([
                    oracleCon.finalizeRound(10),
                    reorgHandler.reportReorg('BTC', 500000, Date.now() - 60000, 'a'.repeat(64), 'b'.repeat(64))
                ]);
            },

            observe: () => {
                // Oracle finalization writes
                let snapshotInserts = dbCalls.filter(c =>
                    c.query.includes('price_snapshots') && c.query.includes('finalized'));
                expect(snapshotInserts.length).to.be.gte(1);

                // Reorg rollback writes
                let reorgDeletes = dbCalls.filter(c =>
                    c.query.includes('DELETE FROM attestations'));
                expect(reorgDeletes.length).to.equal(1);

                let reorgUpdates = dbCalls.filter(c =>
                    c.query.includes('disputed'));
                expect(reorgUpdates.length).to.equal(1);

                let reorgInserts = dbCalls.filter(c =>
                    c.query.includes('reorg_attestations'));
                expect(reorgInserts.length).to.equal(1);
            }
        });
    });

    it('reorg rate limit prevents rapid duplicate reorgs', async function () {
        await reorgHandler.start();

        // First reorg succeeds
        await reorgHandler.reportReorg('BTC', 500000, Date.now() - 60000, 'a'.repeat(64), 'b'.repeat(64));

        // Second reorg on same chain within 60s is rate limited
        let err;
        try {
            await reorgHandler.reportReorg('BTC', 500001, Date.now() - 30000, 'a'.repeat(64), 'b'.repeat(64));
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('Rate limit');
    });

    it('reorg on different chain is not rate limited', async function () {
        await reorgHandler.start();

        await reorgHandler.reportReorg('BTC', 500000, Date.now() - 60000, 'a'.repeat(64), 'b'.repeat(64));

        // Different chain should work
        let err;
        try {
            await reorgHandler.reportReorg('LTC', 300000, Date.now() - 60000, 'a'.repeat(64), 'b'.repeat(64));
        } catch (e) {
            err = e;
        }

        expect(err).to.not.exist;
    });

    it('oracle round submissions unaffected by reorg on unrelated data', async function () {
        await oracleCon.start();
        await reorgHandler.start();

        oracle.currentRound = 15;
        oracle.roundStartTime = Date.now();
        oracle.submissions.set(15, new Map());

        // Process a peer submission
        let envelope = {
            type: 'ORACLE_PRICE_SUBMIT',
            sender: VALIDATORS_4[1].addr,
            timestamp: Date.now(),
            data: {
                round: 15,
                prices: SAMPLE_PRICES,
                sources: 2
            }
        };
        oracle._handleMessage(envelope);

        // Process a reorg (on a chain, unrelated to oracle prices)
        await reorgHandler.reportReorg('DOGE', 100000, Date.now() - 120000, 'a'.repeat(64), 'b'.repeat(64));

        // Submission should still be there
        let subs = oracle.getSubmissions(15);
        expect(subs.size).to.equal(1);
        expect(subs.has(VALIDATORS_4[1].addr)).to.be.true;
    });

    it('oracle finalization after reorg still stores correct data', async function () {
        await oracleCon.start();
        await reorgHandler.start();

        // Execute reorg first
        await reorgHandler.reportReorg('BTC', 500000, Date.now() - 120000, 'a'.repeat(64), 'b'.repeat(64));

        // Then finalize oracle round
        oracle.currentRound = 20;
        oracle.submissions.set(20, new Map([
            [VALIDATORS_4[0].addr, { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() }]
        ]));

        await oracleCon.finalizeRound(20);

        // Verify snapshot was stored (single-node mode → direct store)
        let snapshotCalls = hub.db.doQuery.getCalls().filter(c =>
            c.args[0] && c.args[0].includes('price_snapshots') && c.args[0].includes('finalized'));
        expect(snapshotCalls.length).to.be.gte(1);
    });

    it('reorg with invalid chain is rejected', async function () {
        await reorgHandler.start();

        let err;
        try {
            await reorgHandler.reportReorg('ETH', 1000, Date.now());
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('Invalid chain');
    });

    it('reorg with future timestamp is rejected', async function () {
        await reorgHandler.start();

        let err;
        try {
            await reorgHandler.reportReorg('BTC', 1000, Date.now() + 600000, 'a'.repeat(64), 'b'.repeat(64));
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('too far in the future');
    });
});
