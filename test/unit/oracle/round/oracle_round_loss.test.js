'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// ROUND-LOSS GUARD: a price round that ends with no row at all must leave a
// structured `round_lost` record, whichever of the three silent exits took it:
// a restart between submission and finalization, a forward clock step that
// burns a round number, or a seat past the gates that never resolves. Each
// case drives one exit and asserts the record the pre-fix code never wrote.

const sinon             = require('sinon');
const { expect }        = require('chai');
const proxyquire        = require('proxyquire');
const OracleConsensus   = require('../../../../src/oracle/consensus');
const diagnostics       = require('../../../../src/consensus/diagnostics');
const observability     = require('../../../../src/observability');
const { createMockHub } = require('../../../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../../../helpers/fixtures');

const PRICES = [{ coinPair: 'BTC/USD', price: '100000' }];
const ROUND  = 3;
const HEIGHT = 100;
const TIME   = 1700000000;

function registryFor(validators) {
    let m = new Map();
    for (let v of validators) m.set(v.addr, v.pubkey);
    return m;
}

function snapshotOf(validators, blockIndex) {
    return {
        capability: 'price',
        blockIndex: blockIndex,
        count:      validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100' }))
    };
}

{

    let sink, clock;

    function lost(cause) {
        return sink.lines.filter(l => l.includes('PBFT_DROP') && l.includes('reason=round_lost') &&
                                      (!cause || l.includes('cause=' + cause)));
    }

    function counterValue(phase) {
        const line = observability.getRegistry().render().split('\n')
            .find(l => l.startsWith(`xchain_pbft_drops_total{reason="round_lost",phase="${phase}"}`));
        return line ? Number(line.trim().split(' ').pop()) : 0;
    }

    function roundLostIsAClosedSetTest2() {
        expect(diagnostics.DROP_REASONS.has('round_lost')).to.equal(true);
        diagnostics.noteRoundLost({ phase: 'finalize', round: 7, cause: 'unit' });
        expect(lost('unit')).to.have.length(1);
        expect(lost('unit')[0]).to.include('round=7');
        expect(sink.lines.filter(l => l.includes('unknown_reason'))).to.have.length(0);
        expect(counterValue('finalize')).to.equal(1);
    }

    let registeroracleroundTheSchedulerAndTheFinalization3;

    {

        let hub, or, consensus, storeSkipped;

        async function aForwardClockStepThatBurnsTest5() {
            // The last tick ran round 9; the clock now reads round 13, so 10..12
            // never had a tick. Before the fix executeRoundInner moved straight on.
            or.lastExecutedRound = 9;
            clock.setSystemTime(TIME * 1000 + 3 * 60000);
            sinon.stub(or, 'executeRoundInner').callsFake(async function () {
                // Only the number-gap prelude is under test; replay it verbatim.
                let newRound = Math.floor((Date.now() - this.epochStart) / this.roundInterval);
                if (newRound === this.lastExecutedRound) return;
                if (this.lastExecutedRound >= 0 && newRound > this.lastExecutedRound + 1)
                    this.noteRoundNumbersSkipped(this.lastExecutedRound + 1, newRound - 1);
                this.lastExecutedRound = newRound;
            });
            await or._executeRound();

            const rec = lost('round_numbers_skipped');
            expect(rec, 'one record for the run').to.have.length(1);
            expect(rec[0]).to.include('phase=schedule');
            expect(rec[0]).to.include('from=10');
            expect(rec[0]).to.include('to=12');
            expect(rec[0]).to.include('count=3');
            expect(counterValue('schedule')).to.equal(1);
            // One skipped row per burned number, anchored at the round's nominal start
            // so every hub that stepped over the same number writes the same row.
            expect(storeSkipped.callCount).to.equal(3);
            expect(storeSkipped.firstCall.args[0]).to.equal(10);
            expect(storeSkipped.firstCall.args[2]).to.equal(Math.floor((or.epochStart + 10 * or.roundInterval) / 1000));
            expect(storeSkipped.thirdCall.args[0]).to.equal(12);
        }

        function aWideGapIsRecordedOnceTest6() {
            or.noteRoundNumbersSkipped(100, 300);
            const rec = lost('round_numbers_skipped');
            expect(rec).to.have.length(1);
            expect(rec[0]).to.include('count=201');
            expect(storeSkipped.callCount).to.equal(12);
        }

        async function aFreshStartDoesNotReadTest7() {
            or.lastExecutedRound = -1;
            sinon.stub(or, 'executeRoundInner').callsFake(async function () {
                let newRound = Math.floor((Date.now() - this.epochStart) / this.roundInterval);
                if (this.lastExecutedRound >= 0 && newRound > this.lastExecutedRound + 1)
                    this.noteRoundNumbersSkipped(this.lastExecutedRound + 1, newRound - 1);
                this.lastExecutedRound = newRound;
            });
            await or._executeRound();
            expect(lost()).to.have.length(0);
        }

        async function aFinalizeroundRejectionPastTheGatesTest8() {
            consensus.finalizeRound.rejects(new Error('db went away'));
            or.scheduleFinalization(ROUND);
            await clock.tickAsync(Number(or.submissionWindow) + 1);
            await Promise.resolve();

            const rec = lost('finalize_rejected');
            expect(rec).to.have.length(1);
            expect(rec[0]).to.include('round=' + ROUND);
            expect(rec[0]).to.include('db went away');
            expect(counterValue('finalize')).to.equal(1);
        }

        async function aSkippedRowWriteThatRejectsTest9() {
            or.chainTipFallbackActive        = true;
            or.lastSuccessfulChainTipFetchAt = Date.now() - or.roundInterval - 1;
            storeSkipped.rejects(new Error('insert failed'));
            or.scheduleFinalization(ROUND);
            await clock.tickAsync(Number(or.submissionWindow) + 1);
            await Promise.resolve();

            expect(lost('skip_store_rejected')).to.have.length(1);
            expect(consensus.finalizeRound.called).to.equal(false);
        }

        async function aSynchronousThrowInsideTheFinalizationTest10() {
            consensus.finalizeRound = () => { throw new Error('boom'); };
            or.scheduleFinalization(ROUND);
            await clock.tickAsync(Number(or.submissionWindow) + 1);

            const rec = lost('finalize_threw');
            expect(rec).to.have.length(1);
            expect(rec[0]).to.include('boom');
        }

        async function stopWithARoundSubmittedButTest11() {
            or.currentBtcBlockHeight = HEIGHT;
            or.currentBtcBlockTime   = TIME;
            or.scheduleFinalization(ROUND);
            or.scheduleFinalization(ROUND + 1);
            expect(or.finalizationTimers.size).to.equal(2);

            await or.stop();

            const rec = lost('stopped_before_finalization');
            expect(rec).to.have.length(2);
            expect(rec.map(l => /round=(\d+)/.exec(l)[1]).sort()).to.deep.equal([String(ROUND), String(ROUND + 1)]);
            expect(rec[0]).to.include('phase=shutdown');
            expect(storeSkipped.callCount).to.equal(2);
            expect(storeSkipped.firstCall.args.slice(0, 3)).to.deep.equal([ROUND, HEIGHT, TIME]);
            expect(storeSkipped.firstCall.args[3]).to.match(/stopped/);
            expect(or.finalizationTimers.size).to.equal(0);
            expect(counterValue('shutdown')).to.equal(2);
        }

        async function stopWithNothingInFlightRecordsTest12() {
            await or.stop();
            expect(lost()).to.have.length(0);
            expect(storeSkipped.called).to.equal(false);
        }

        async function aRoundThatFinalizesNormallyLeavesTest13() {
            or.scheduleFinalization(ROUND);
            await clock.tickAsync(Number(or.submissionWindow) + 1);
            await Promise.resolve();
            expect(consensus.finalizeRound.calledOnce).to.equal(true);
            expect(lost()).to.have.length(0);
        }

        function oracleroundTheSchedulerAndTheFinalizationSuite4() {
            beforeEach(function () {
                const OracleRound = proxyquire('../../../../src/oracle/round', {
                    './price_fetcher': function () {
                        return { fetchPrices: sinon.stub().resolves([{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }]) };
                    }
                });
                hub = createMockHub({
                    p2pConfig: {
                        ORACLE_ROUND_INTERVAL:    '60000',
                        ORACLE_SUBMISSION_WINDOW: '30000',
                        ORACLE_EPOCH_START:       String(TIME * 1000 - 10 * 60000)
                    }
                });
                or = new OracleRound(hub);
                storeSkipped = sinon.stub().resolves();
                consensus = {
                    finalizeRound:      sinon.stub().resolves(),
                    storeSkippedRound: storeSkipped,
                    on: sinon.stub(), removeListener: sinon.stub()
                };
                or.oracleConsensus = consensus;
            });
            it('a forward clock step that burns round numbers records the run and writes their skipped rows', aForwardClockStepThatBurnsTest5);
            it('a wide gap is recorded once by range and its rows are capped', aWideGapIsRecordedOnceTest6);
            it('a fresh start does not read the distance from -1 as a loss', aFreshStartDoesNotReadTest7);
            it('a finalizeRound rejection past the gates leaves a record, not just a prose error line', aFinalizeroundRejectionPastTheGatesTest8);
            it('a skipped-row write that rejects on the fallback path leaves a record', aSkippedRowWriteThatRejectsTest9);
            it('a synchronous throw inside the finalization timer leaves a record', aSynchronousThrowInsideTheFinalizationTest10);
            it('stop() with a round submitted but not finalized records it and writes its skipped row', stopWithARoundSubmittedButTest11);
            it('stop() with nothing in flight records nothing', stopWithNothingInFlightRecordsTest12);
            it('a round that finalizes normally leaves no record', aRoundThatFinalizesNormallyLeavesTest13);
        }

        registeroracleroundTheSchedulerAndTheFinalization3 = function registerSuite() {
            describe('OracleRound: the scheduler and the finalization timer', oracleroundTheSchedulerAndTheFinalizationSuite4);
        };

    }

    let registeroracleconsensusTheSeatsPastTheGates14;

    {

        let hub, pm, oc, oracleRound;

        function seat(me) {
            hub = createMockHub();
            pm  = hub._peerManager;
            pm.validatorAddr    = me.addr;
            pm.validatorPubkeys = registryFor(VALIDATORS_3);
            hub._identity.getPubkeyHex.returns(me.pubkey);
            hub.capabilitySnapshot = {
                getSnapshot:       sinon.stub().resolves(snapshotOf(VALIDATORS_3, HEIGHT)),
                getWeightSnapshot: sinon.stub().resolves(null),
                getQuorum:         sinon.stub().returns(2)
            };
            oracleRound = {
                getSubmissions: sinon.stub().returns(buildSubmissions(
                    VALIDATORS_3.map(v => ({ sender: v.addr, prices: PRICES })))),
                priceFetcher:   null
            };
            oc = new OracleConsensus(hub, oracleRound);
            oc.setValidatorSet(VALIDATORS_3);
        }

        async function abandonRound() {
            await clock.tickAsync(oc.roundAbandonMs() + 1000);
            await Promise.resolve();
        }

        async function aFollowerWaitingOnTheLeaderTest16() {
            seat(VALIDATORS_3[2]);   // v1 leads, v2 is the elected fallback, v3 only waits
            await oc.finalizeRound(ROUND, HEIGHT, TIME);
            expect(lost(), 'still live: nothing recorded yet').to.have.length(0);

            await abandonRound();

            const rec = lost('abandoned_in_flight');
            expect(rec).to.have.length(1);
            expect(rec[0]).to.include('round=' + ROUND);
            expect(rec[0]).to.include('seat=follower_awaiting_leader');
            expect(rec[0]).to.include('leader=' + VALIDATORS_3[0].addr);
            expect(rec[0]).to.include('reference_block=' + HEIGHT);
            expect(counterValue('finalize')).to.equal(1);
        }

        async function theElectedFallbackWhoseOwnProposeTest17() {
            seat(VALIDATORS_3[1]);
            await oc.finalizeRound(ROUND, HEIGHT, TIME);
            await abandonRound();

            const rec = lost('abandoned_in_flight');
            expect(rec).to.have.length(1);
            expect(rec[0]).to.include('seat=fallback_proposer');
        }

        async function aHubWaitingOnSomeoneElseTest18() {
            // Drop the leader's submission so the no-leader branch elects the lowest
            // addr, and seat this hub as one that is not it.
            seat(VALIDATORS_3[2]);
            const noLeader = buildSubmissions(VALIDATORS_3.slice(1).map(v => ({ sender: v.addr, prices: PRICES })));
            oracleRound.getSubmissions.returns(noLeader);
            const fallback = [...noLeader.keys()].sort()[0];
            expect(fallback).to.not.equal(VALIDATORS_3[2].addr);

            await oc.finalizeRound(ROUND, HEIGHT, TIME);
            await abandonRound();

            const rec = lost('abandoned_in_flight');
            expect(rec).to.have.length(1);
            expect(rec[0]).to.include('seat=awaiting_other_fallback');
            expect(rec[0]).to.include('fallback=' + fallback);
        }

        async function stopWithARoundOpenRecordsTest19() {
            seat(VALIDATORS_3[2]);
            const skipped = sinon.spy(oc, 'storeSkippedRound');
            await oc.finalizeRound(ROUND, HEIGHT, TIME);
            expect(oc.roundWatchdogs.has(ROUND)).to.equal(true);

            await oc.stop();

            const rec = lost('stopped_with_round_in_flight');
            expect(rec).to.have.length(1);
            expect(rec[0]).to.include('phase=shutdown');
            expect(rec[0]).to.include('seat=follower_awaiting_leader');
            expect(skipped.calledOnce).to.equal(true);
            expect(skipped.firstCall.args.slice(0, 3)).to.deep.equal([ROUND, HEIGHT, TIME]);
            expect(oc.roundWatchdogs.size).to.equal(0);
            expect(counterValue('shutdown')).to.equal(1);
        }

        async function aRoundThatFinalizedBeforeStopTest20() {
            seat(VALIDATORS_3[2]);
            await oc.finalizeRound(ROUND, HEIGHT, TIME);
            oc.markFinalized(ROUND);
            await oc.stop();
            expect(lost()).to.have.length(0);
        }

        function oracleconsensusTheSeatsPastTheGatesSuite15() {
            it('a follower waiting on the leader (the bare return at the leader-submitted seat) names its seat when the round dies', aFollowerWaitingOnTheLeaderTest16);
            it('the elected fallback whose own PROPOSE never commits is recorded as the proposer', theElectedFallbackWhoseOwnProposeTest17);
            it('a hub waiting on someone else\'s fallback (the bare return at the no-leader seat) names that fallback', aHubWaitingOnSomeoneElseTest18);
            it('stop() with a round open records it with its seat and writes its skipped row', stopWithARoundOpenRecordsTest19);
            it('a round that finalized before stop() is not recorded', aRoundThatFinalizedBeforeStopTest20);
        }

        registeroracleconsensusTheSeatsPastTheGates14 = function registerSuite() {
            describe('OracleConsensus: the seats past the gates', oracleconsensusTheSeatsPastTheGatesSuite15);
        };

    }

    function roundLossEverySilentRoundExitSuite1() {
        beforeEach(function () {
            observability._resetObservability();
            diagnostics.resetDiagnostics();
            sink = { lines: [] };
            const push = (m) => sink.lines.push(m);
            observability.installObservability(null, {
                service: 'xchain-hub', env: {}, console: { log: push, warn: push, error: push }
            });
            clock = sinon.useFakeTimers({ now: TIME * 1000, shouldAdvanceTime: false });
        });
        afterEach(function () {
            clock.restore();
            sinon.restore();
            observability._resetObservability();
            diagnostics.resetDiagnostics();
        });
        it('round_lost is a closed-set reason, so the record is never downgraded to unknown_reason', roundLostIsAClosedSetTest2);
        registeroracleroundTheSchedulerAndTheFinalization3();
        registeroracleconsensusTheSeatsPastTheGates14();
    }

    describe('round loss: every silent round exit leaves a round_lost record', roundLossEverySilentRoundExitSuite1);

}
