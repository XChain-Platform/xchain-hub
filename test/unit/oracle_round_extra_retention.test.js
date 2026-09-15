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
// Extra OracleRound tests covering branches not already exercised by
// the existing OracleRound.test.js:
//   - stop() clears all timers
//   - _handleMessage: invalid round, late submission, duplicate sender,
//     max submissions, invalid prices, known validator pubkey → DB persist path
//   - scheduleFinalization: fallback-suppression branch
//   - pruneSubmissions: old round eviction
//   - persistSubmissions: null pubkey fallback

const sinon             = require('sinon');
const { expect }        = require('chai');
const proxyquire        = require('proxyquire');
const { createMockHub } = require('../helpers/mockHub');
const { pubkeyForTestSender } = require('../helpers/fixtures');



    let hub, pm, or, mockPriceFetcher, OracleRound;


        let warn;


        const fs   = require('fs');

        const path = require('path');


        // Brace-match the `const p2pConfig = P2P_VALIDATOR_ADDR ? { ... }` literal.
        function p2pConfigLiteral() {
            const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
            const at  = src.indexOf('const p2pConfig = P2P_VALIDATOR_ADDR ? {');
            expect(at, 'p2pConfig literal not found in src/api.js').to.not.equal(-1);
            const open = src.indexOf('{', at);
            let depth = 0;
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
            }
            throw new Error('unbalanced p2pConfig literal in src/api.js');
        }

function registerOracleroundExtraCoverage1Hooks() {

    beforeEach(function () {
        mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };

        OracleRound = proxyquire('../../src/oracle/round', {
            './price_fetcher': function () { return mockPriceFetcher; }
        });

        hub = createMockHub({ p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' } });
        pm  = hub._peerManager;
        or  = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
        // Clean up any timers
        if (or.roundTimer)        { clearInterval(or.roundTimer); or.roundTimer = null; }
        if (or.initialRoundTimer) { clearTimeout(or.initialRoundTimer); or.initialRoundTimer = null; }
        if (or.boundaryTimer)     { clearTimeout(or.boundaryTimer); or.boundaryTimer = null; }
        if (or.finalizationTimers) { for (let t of or.finalizationTimers.values()) clearTimeout(t); or.finalizationTimers.clear(); }
    });
}

function registerOnsubmissionsprunefailure2Hooks() {

        beforeEach(function () { warn = sinon.stub(console, 'warn'); });
}

function registerOnsubmissionsprunefailure2Tests1() {

        it('counts a rejected sweep and records the round it failed in', async function () {
            or.submissionsRetentionRounds = 100;
            or.currentRound = 1000;
            hub.db.doQuery = sinon.stub().rejects(new Error('pool is closed'));
            await or.pruneSubmissionsDb().catch(e => or.onSubmissionsPruneFailure(e, or.currentRound));
            expect(or.submissionsPruneFailures).to.equal(1);
            expect(or.lastSubmissionsPruneFailureRound).to.equal(1000);
            expect(warn.calledOnce).to.be.true;
            expect(warn.firstCall.args[0]).to.match(/prune FAILED at round 1000/);
        });

        it('warns once per dark spell, and again after an intervening recovery', function () {
            or.currentRound = 500;
            or.onSubmissionsPruneFailure(new Error('a'), 500);
            or.onSubmissionsPruneFailure(new Error('a'), 501);
            or.onSubmissionsPruneFailure(new Error('a'), 502);
            expect(or.submissionsPruneFailures).to.equal(3);
            expect(warn.callCount).to.equal(1);          // latched: no per-round log storm

            or._submissionsPruneDark = false;            // what a successful sweep does
            or.onSubmissionsPruneFailure(new Error('a'), 503);
            expect(warn.callCount).to.equal(2);
            expect(or.submissionsPruneFailures).to.equal(4);   // monotonic, never reset
        });

        it('clears the latch and says so after a sweep that actually ran', async function () {
            or.submissionsRetentionRounds = 100;
            or.currentRound = 1000;
            or._submissionsPruneDark = true;
            or.submissionsPruneFailures = 2;
            hub.db.doQuery = sinon.stub().resolves({ affectedRows: 3 });
            await or.pruneSubmissionsDb();
            expect(or._submissionsPruneDark).to.be.false;
            expect(warn.calledOnce).to.be.true;
            expect(warn.firstCall.args[0]).to.match(/prune recovered at round 1000/);
        });

        it('leaves the latch set when the sweep short-circuits without running a DELETE', async function () {
            or.submissionsRetentionRounds = 0;           // retention disabled
            or.currentRound = 1000;
            or._submissionsPruneDark = true;
            hub.db.doQuery = sinon.stub().resolves({});
            await or.pruneSubmissionsDb();
            expect(hub.db.doQuery.called).to.be.false;
            expect(or._submissionsPruneDark).to.be.true;  // a skipped sweep is not a recovery
            expect(warn.called).to.be.false;
        });
}

function registerOnsubmissionsprunefailure2Tests5() {

        it('reports the counters on getSubmissionsInfo without leaking the driver message', async function () {
            or.currentRound = 700;
            or.onSubmissionsPruneFailure(new Error("Access denied for user 'hub'@'10.0.0.5'"), 700);
            hub.db.doQuery = sinon.stub().resolves([]);
            let info = await or.getSubmissionsInfo();
            expect(info.submissionsPruneFailures).to.equal(1);
            expect(info.lastSubmissionsPruneFailureRound).to.equal(700);
            expect(JSON.stringify(info)).to.not.match(/Access denied/);
        });

}

function registerOracleSubmissionsRetentionRoundsWiring3Tests6() {

        it('the key is present in the api.js p2pConfig literal', function () {
            expect(p2pConfigLiteral()).to.match(/\n\s*ORACLE_SUBMISSIONS_RETENTION_ROUNDS\s*:/,
                'OracleRound reads this off hub.p2pConfig; absent from the literal it is permanently '
                + 'undefined and the retention window is un-tunable');
        });

        it('is passed through unparsed so an explicit 0 survives', function () {
            const line = /ORACLE_SUBMISSIONS_RETENTION_ROUNDS\s*:\s*([^\n,]+)/.exec(p2pConfigLiteral());
            expect(line, 'ORACLE_SUBMISSIONS_RETENTION_ROUNDS not wired').to.not.equal(null);
            expect(line[1].trim()).to.equal('hubConfig.ORACLE_SUBMISSIONS_RETENTION_ROUNDS',
                'wrap it in parseInt(...) || DEFAULT and the documented "0 disables pruning" setting '
                + 'collapses back to the default; OracleRound.js owns the parse and the default');
        });

        it('an operator-supplied window reaches the pruner', function () {
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_SUBMISSIONS_RETENTION_ROUNDS: '500' }
            }));
            expect(fresh.submissionsRetentionRounds).to.equal(500);
        });

        it('an explicit 0 disables pruning rather than falling back to the default', function () {
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_SUBMISSIONS_RETENTION_ROUNDS: '0' }
            }));
            expect(fresh.submissionsRetentionRounds).to.equal(0);
        });

        it('a garbage or negative value falls back to the bounded default', function () {
            for (const bad of ['nonsense', '-5', '']) {
                const fresh = new OracleRound(createMockHub({
                    p2pConfig: { ORACLE_SUBMISSIONS_RETENTION_ROUNDS: bad }
                }));
                expect(fresh.submissionsRetentionRounds, 'value ' + JSON.stringify(bad)).to.equal(12960);
            }
        });

}

function registerPersistsubmissionsPubkeyFallbacks4Tests11() {
        it('uses identity pubkey when validatorPubkey is null', function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            or.persistSubmissions(1, 'me', [{ coinPair: 'BTC/USD', price: '100', sources: 1 }], null);
            // Called once for the one price pair
            expect(hub.db.doQuery.called).to.be.true;
            // Identity.getPubkeyHex should have been called
            expect(hub._identity.getPubkeyHex.called).to.be.true;
        });

        it('uses zero-padded pubkey when both validatorPubkey and identity are null', function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            or.identity = null;
            or.persistSubmissions(1, 'me', [{ coinPair: 'BTC/USD', price: '100', sources: 1 }], null);
            let vals = hub.db.doQuery.firstCall.args[1];
            expect(vals[2]).to.equal('0'.repeat(64));
        });

}

function registerGetsubmissionsinfoDbError5Tests13() {
        it('returns info without skippedRounds when DB query fails', async function () {
            hub.db.doQuery = sinon.stub().rejects(new Error('db error'));
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('currentRound');
            expect(info.skippedRounds).to.deep.equal([]);
            expect(info.droppedPairs).to.deep.equal([]);
            // Item 5548: the failure is marked, so the empty arrays cannot be
            // mistaken for a clean round downstream.
            expect(info.skippedRoundsReadError).to.equal(true);
            expect(info.droppedPairsReadError).to.equal(true);
        });

        it('marks both read flags false when the diagnostic reads succeed', async function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            let info = await or.getSubmissionsInfo();
            expect(info.skippedRoundsReadError).to.equal(false);
            expect(info.droppedPairsReadError).to.equal(false);
        });

}

function registerGetsubmissionsinfoSkippedRoundsAndPer6Tests15() {
        it('separates whole-round skips (skippedRounds) from per-pair drops (droppedPairs)', async function () {
            hub.db.doQuery = sinon.stub().callsFake(async (sql) => {
                if (/NOT EXISTS/i.test(sql)) return [{ round_number: 41 }, { round_number: 40 }];
                if (/coin_pair/i.test(sql))  return [{ round_number: 42, coin_pair: 'LTC/USD' }];
                return [];
            });
            let info = await or.getSubmissionsInfo();
            expect(info.skippedRounds).to.deep.equal([41, 40]);
            expect(info.skippedCount).to.equal(2);
            expect(info.droppedPairs).to.deep.equal([{ round: 42, coinPair: 'LTC/USD' }]);
            expect(info.droppedPairCount).to.equal(1);
        });

}

function registerGetsubmissionsinfoRoundTimeouts7Tests16() {
        it('surfaces the consensus _roundTimeouts counter', async function () {
            or.setConsensus({ _roundTimeouts: 3 });
            let info = await or.getSubmissionsInfo();
            expect(info.round_timeouts).to.equal(3);
        });

        it('defaults to 0 when no consensus is wired or the counter is unset', async function () {
            let info = await or.getSubmissionsInfo();
            expect(info.round_timeouts).to.equal(0);
            or.setConsensus({});
            info = await or.getSubmissionsInfo();
            expect(info.round_timeouts).to.equal(0);
        });

}

describe('OracleRound (extra coverage)', function () {
    registerOracleroundExtraCoverage1Hooks();



    // ── retention-sweep failure is observable (review #5799) ─────────────────
    //
    // The sweep is fired and not awaited, so its rejection has nowhere to land but
    // this handler. A bare `.catch(() => {})` here leaves the one error path in the
    // round loop with neither a log line nor a counter - so a dead pool or a lock
    // timeout let oracle_submissions grow for the process lifetime and the first
    // signal an operator got was DB pressure with nothing pointing at retention.
    describe('onSubmissionsPruneFailure()', function () {
        registerOnsubmissionsprunefailure2Hooks();
        registerOnsubmissionsprunefailure2Tests1();
        registerOnsubmissionsprunefailure2Tests5();
    });



    // ── ORACLE_SUBMISSIONS_RETENTION_ROUNDS is actually reachable (item 2664) ─
    //
    // OracleRound reads this knob off hub.p2pConfig, which is a fixed object literal
    // in src/api.js. The key was absent from that literal, so it was always undefined:
    // parseInt(undefined) -> NaN -> the 12960 default won on every deployment and the
    // documented "0 disables pruning" setting was unreachable. The consumer-side
    // behaviour below passed even then, which is exactly why the source-side assertion
    // is here too: it is the half that was actually broken.
    describe('ORACLE_SUBMISSIONS_RETENTION_ROUNDS wiring', function () {
        registerOracleSubmissionsRetentionRoundsWiring3Tests6();
    });



    // ── persistSubmissions: pubkey fallbacks ────────────────────────────────
    describe('persistSubmissions(): pubkey fallbacks', function () {
        registerPersistsubmissionsPubkeyFallbacks4Tests11();
    });



    // ── getSubmissionsInfo: DB error fallback ────────────────────────────────
    describe('getSubmissionsInfo(): DB error', function () {
        registerGetsubmissionsinfoDbError5Tests13();
    });



    // ── getSubmissionsInfo: whole-round skips vs per-pair drops (item #180) ──
    describe('getSubmissionsInfo(): skipped rounds and per-pair drops', function () {
        registerGetsubmissionsinfoSkippedRoundsAndPer6Tests15();
    });



    // ── getSubmissionsInfo: PBFT round-timeout counter (reviews 1468/1469) ───
    describe('getSubmissionsInfo(): round_timeouts', function () {
        registerGetsubmissionsinfoRoundTimeouts7Tests16();
    });
});
