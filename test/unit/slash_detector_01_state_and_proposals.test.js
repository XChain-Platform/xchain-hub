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
const SlashDetector  = require('../../src/validators/slash_detector');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3 } = require('../helpers/fixtures');

let hub, pm, sd;

function installSuiteHooks1() {
    beforeEach(function () {
            hub = createMockHub({
                p2pConfig: {
                    SLASH_DEVIATION_THRESHOLD:    '0.05',
                    SLASH_MISSED_ROUNDS_THRESHOLD: '30'
                }
            });
            pm = hub._peerManager;
            pm.validatorPubkeys = new Map([
                [VALIDATORS_3[0].addr, VALIDATORS_3[0].pubkey],
                [VALIDATORS_3[1].addr, VALIDATORS_3[1].pubkey],
                [VALIDATORS_3[2].addr, VALIDATORS_3[2].pubkey]
            ]);
            sd = new SlashDetector(hub);
        });
    afterEach(function () {
            sinon.restore();
        });
}

function seedMisses(pubkey, misses) {
            sd.participation.set(pubkey, {
                history: new Array(misses).fill(true),
                missed:  misses
            });
        }

async function runRounds(n, participants, startRound) {
            for (let i = 0; i < n; i++) {
                await sd.checkParticipation((startRound || 1) + i, participants, VALIDATORS_3);
            }
        }

// -----------------------------------------------------------------
// Repeated deviation (3+ in 24h)
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('repeated deviation', function () {
it('3 deviations in 24h triggers repeated_deviation proposal', async function () {
            // Manually track 2 previous deviations
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 },
                { round: 2, timestamp: Date.now() - 500 }
            ]);

            // Third deviation via trackDeviation
            sd.trackDeviation(VALIDATORS_3[0].pubkey, 3);

            // Should have recorded a repeated_deviation proposal
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][1]).to.equal('repeated_deviation');
        });
it('2 deviations in 24h does NOT trigger repeated_deviation', function () {
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 }
            ]);

            sd.trackDeviation(VALIDATORS_3[0].pubkey, 2);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('old deviations (>24h) are pruned before check', function () {
            let over24h = Date.now() - (25 * 60 * 60 * 1000);
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: over24h },
                { round: 2, timestamp: over24h }
            ]);

            sd.trackDeviation(VALIDATORS_3[0].pubkey, 3);
            // After pruning, only 1 deviation (the new one) → no proposal
            expect(sd.recentDeviations.get(VALIDATORS_3[0].pubkey).length).to.equal(1);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('does NOT re-fire while the 24h window stays saturated (F12 latch)', function () {
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 },
                { round: 2, timestamp: Date.now() - 500 }
            ]);

            sd.trackDeviation(VALIDATORS_3[0].pubkey, 3); // crossing → fires
            expect(hub.db.doQuery.callCount).to.equal(1);

            sd.trackDeviation(VALIDATORS_3[0].pubkey, 4); // still ≥3 → latched, no re-fire
            sd.trackDeviation(VALIDATORS_3[0].pubkey, 5);
            expect(hub.db.doQuery.callCount).to.equal(1);
        });
});
});

describe('SlashDetector', function () {
    installSuiteHooks1();
describe('repeated deviation', function () {
it('re-arms after pruning drops the window below 3 (F12 latch)', function () {
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 },
                { round: 2, timestamp: Date.now() - 500 }
            ]);
            sd.trackDeviation(VALIDATORS_3[0].pubkey, 3); // fires, latch set
            expect(hub.db.doQuery.callCount).to.equal(1);

            // Window ages out; replace with stale entries, next track prunes to 1
            let over24h = Date.now() - (25 * 60 * 60 * 1000);
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 3, timestamp: over24h },
                { round: 4, timestamp: over24h }
            ]);
            sd.trackDeviation(VALIDATORS_3[0].pubkey, 10); // count 1 → latch re-arms
            expect(hub.db.doQuery.callCount).to.equal(1);

            sd.recentDeviations.get(VALIDATORS_3[0].pubkey).push(
                { round: 11, timestamp: Date.now() }
            );
            sd.trackDeviation(VALIDATORS_3[0].pubkey, 12); // count 3 again → fires again
            expect(hub.db.doQuery.callCount).to.equal(2);
        });
});
});

describe('SlashDetector', function () {
    installSuiteHooks1();
describe('non-participation (windowed rate)', function () {
it('a sustained 1-in-30 participation pattern fires within one window', async function () {
            // 29 misses + 1 participation, repeated: fires by round 31.
            for (let cycle = 0; cycle < 2; cycle++) {
                for (let r = 0; r < 29; r++) {
                    await sd.checkParticipation(cycle * 30 + r + 1, [], VALIDATORS_3);
                }
                await sd.checkParticipation(cycle * 30 + 30, [VALIDATORS_3[0].pubkey], VALIDATORS_3);
            }
            expect(hub.db.doQuery.called).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[1][1]).to.equal('non_participation');
        });
it('a fully participating validator never triggers', async function () {
            await runRounds(120, [VALIDATORS_3[0].pubkey, VALIDATORS_3[1].pubkey, VALIDATORS_3[2].pubkey]);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('old misses age out of the window', async function () {
            // 29 misses, then full participation: the misses slide out and the
            // count decrements back toward 0 instead of firing.
            seedMisses(VALIDATORS_3[0].pubkey, 29);
            await runRounds(60, VALIDATORS_3.map(v => v.pubkey), 30);
            expect(sd.participation.get(VALIDATORS_3[0].pubkey).missed).to.equal(0);
            expect(sd.participation.get(VALIDATORS_3[0].pubkey).history.length).to.equal(60);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('re-arms the latch only when the windowed miss count recovers below the threshold', async function () {
            seedMisses(VALIDATORS_3[0].pubkey, 29);
            await sd.checkParticipation(30, [], VALIDATORS_3); // fires + latches
            expect(hub.db.doQuery.callCount).to.equal(1);
            hub.db.doQuery.resetHistory();

            // One participation while the window stays saturated: still latched.
            await sd.checkParticipation(31, [VALIDATORS_3[0].pubkey], VALIDATORS_3);
            expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey)).to.be.true;
            await sd.checkParticipation(32, [], VALIDATORS_3);
            expect(hub.db.doQuery.called).to.be.false;

            // Sustained participation until misses drop below the threshold:
            // window fills with participations and the old misses age out.
            await runRounds(60, [VALIDATORS_3[0].pubkey], 33);
            expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey)).to.be.false;

            // A fresh 30-miss run fires again.
            await runRounds(30, [], 93);
            expect(hub.db.doQuery.called).to.be.true;
        });
});
});

describe('SlashDetector', function () {
    installSuiteHooks1();
describe('non-participation (windowed rate)', function () {
it('does not re-fire while latched and the window stays saturated', async function () {
            seedMisses(VALIDATORS_3[0].pubkey, 29);
            await sd.checkParticipation(30, [], VALIDATORS_3);
            hub.db.doQuery.resetHistory();

            await sd.checkParticipation(31, [], VALIDATORS_3);
            expect(sd.participation.get(VALIDATORS_3[0].pubkey).missed).to.equal(31);
            // Latch is set, so no second proposal for the same offense.
            expect(hub.db.doQuery.called).to.be.false;
        });
it('re-fires past the threshold while un-latched (retry after a lost record)', async function () {
            // Window already past the threshold but never recorded (e.g. a prior
            // DB write failed, so the offense is un-latched). The next miss must
            // still record it rather than lose the offense forever.
            seedMisses(VALIDATORS_3[0].pubkey, 30);
            sd.nonParticipationFired.set(VALIDATORS_3[0].pubkey, false);
            hub.db.doQuery.resetHistory();

            await sd.checkParticipation(31, [], VALIDATORS_3);
            expect(hub.db.doQuery.called).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[1][1]).to.equal('non_participation');
            expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey)).to.be.true;
        });
it('a failed record leaves the offense un-latched so it retries next round', async function () {
            seedMisses(VALIDATORS_3[0].pubkey, 29);
            hub.db.doQuery.rejects(new Error('db down'));

            await sd.checkParticipation(30, [], VALIDATORS_3);
            // Write failed, so the latch is NOT set.
            expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey)).to.not.equal(true);

            // Next round the write succeeds and the offense is finally recorded.
            hub.db.doQuery.resetHistory();
            hub.db.doQuery.resolves([]);
            await sd.checkParticipation(31, [], VALIDATORS_3);
            expect(hub.db.doQuery.called).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[1][1]).to.equal('non_participation');
            expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey)).to.be.true;
        });
it('bounds the history to the window size', async function () {
            await runRounds(75, []);
            expect(sd.participation.get(VALIDATORS_3[0].pubkey).history.length).to.equal(60);
        });
it('handles empty allValidators gracefully', async function () {
            await sd.checkParticipation(1, [], []);
            expect(hub.db.doQuery.called).to.be.false;
        });
});
});

// -----------------------------------------------------------------
// Per-validator tracking map GC
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('validator-state GC (SLASH-MAP-NO-GC-1)', function () {
it('prunes tracking maps for pubkeys no longer in the known validator set', async function () {
            let stale = 'dd'.repeat(32); // not in VALIDATORS_3 nor the peer registry
            sd.participation.set(stale, { history: [true], missed: 1 });
            sd.recentDeviations.set(stale, [{ round: 1, timestamp: Date.now() }]);
            sd.repeatedDeviationFired.set(stale, true);
            sd.nonParticipationFired.set(stale, true);

            await sd.checkParticipation(1, [VALIDATORS_3[0].pubkey], VALIDATORS_3);

            expect(sd.participation.has(stale)).to.equal(false);
            expect(sd.recentDeviations.has(stale)).to.equal(false);
            expect(sd.repeatedDeviationFired.has(stale)).to.equal(false);
            expect(sd.nonParticipationFired.has(stale)).to.equal(false);
            // A current validator's freshly-recorded state is retained.
            expect(sd.participation.has(VALIDATORS_3[0].pubkey)).to.equal(true);
        });
it('retains a validator still in the live peer registry even if absent from the round set', async function () {
            // A recent deviator known to the registry but omitted from this round's
            // allValidators must not be pruned (its 24h deviation window survives).
            let regOnly = VALIDATORS_3[1].pubkey;
            sd.recentDeviations.set(regOnly, [{ round: 1, timestamp: Date.now() }]);

            await sd.checkParticipation(1, [], [VALIDATORS_3[0], VALIDATORS_3[2]]);

            expect(sd.recentDeviations.has(regOnly)).to.equal(true);
        });
});
});

// -----------------------------------------------------------------
// resolveValidatorPubkey()
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('resolveValidatorPubkey()', function () {
it('resolves a known addr to its pubkey', function () {
            expect(sd.resolveValidatorPubkey(VALIDATORS_3[0].addr)).to.equal(VALIDATORS_3[0].pubkey);
        });
it('returns null for unknown addr', function () {
            expect(sd.resolveValidatorPubkey('ws://unknown:10001')).to.be.null;
        });
it('returns null when there is no peer manager', function () {
            hub.getPeerManager.returns(null);
            expect(sd.resolveValidatorPubkey('x')).to.be.null;
        });
});
// -----------------------------------------------------------------
// DB query methods
// -----------------------------------------------------------------
describe('getPendingProposals()', function () {
it('queries slash_proposals with pending status', async function () {
            hub.db.doQuery.resolves([{ id: 1 }]);
            let result = await sd.getPendingProposals();
            expect(hub.db.doQuery.calledOnce).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[0]).to.include("status = 'pending'");
        });
});
describe('getProposalsForValidator()', function () {
it('queries by validator pubkey', async function () {
            await sd.getProposalsForValidator('abc123');
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal(['abc123']);
        });
});
});

// -----------------------------------------------------------------
// checkRound() orchestration
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('checkRound()', function () {
it('runs both the deviation and participation checks', async function () {
            let dev  = sinon.stub(sd, 'checkDeviations').resolves();
            let part = sinon.stub(sd, 'checkParticipation').resolves();
            await sd.checkRound(5, new Map(), [], [], VALIDATORS_3);
            expect(dev.calledOnce).to.be.true;
            expect(part.calledOnce).to.be.true;
        });
});
// -----------------------------------------------------------------
// Deviation memory bound
// -----------------------------------------------------------------
describe('deviation memory bound', function () {
it('caps tracked deviations at the per-validator maximum', function () {
            let now = Date.now();
            let arr = [];
            for (let i = 0; i < 1000; i++) arr.push({ round: i, timestamp: now - 1 });
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, arr);
            // One more pushes to 1001 → sliced back to the 1000 most recent.
            sd.trackDeviation(VALIDATORS_3[0].pubkey, 1001);
            expect(sd.recentDeviations.get(VALIDATORS_3[0].pubkey).length).to.equal(1000);
        });
});
// -----------------------------------------------------------------
// recordSlashProposal() pubkey validation
// -----------------------------------------------------------------
describe('recordSlashProposal()', function () {
it('skips a slash proposal when the pubkey is malformed', async function () {
            await sd.recordSlashProposal('not-a-valid-pubkey', 'price_deviation', 1, '{}');
            expect(hub.db.doQuery.called).to.be.false;
        });
});
});

// -----------------------------------------------------------------
// recordAttestationDivergence()
// -----------------------------------------------------------------
describe('SlashDetector', function () {
    installSuiteHooks1();
describe('recordAttestationDivergence()', function () {
it('returns without recording when validatorPubkey or requestId is missing', async function () {
            await sd.recordAttestationDivergence(null, 'req');
            await sd.recordAttestationDivergence('pk', null);
            expect(hub.db.doQuery.called).to.be.false;
        });
it('skips an invalidly-formatted pubkey', async function () {
            await sd.recordAttestationDivergence('xyz', 'deadbeef', 'http_get', 'h1', 'h2');
            expect(hub.db.doQuery.called).to.be.false;
        });
it('records an attestation_divergence proposal with evidence + pseudo-round', async function () {
            let pk = VALIDATORS_3[0].pubkey;
            await sd.recordAttestationDivergence(pk.toUpperCase(), 'deadbeefcafe', 'http_get', 'hashA', 'hashB');

            expect(hub.db.doQuery.calledOnce).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('slash_proposals');
            expect(args[1][0]).to.equal(pk.toLowerCase());            // pubkey lowercased
            expect(args[1][1]).to.equal('attestation_divergence');
            expect(args[1][2]).to.equal(parseInt('deadbeef', 16));    // pseudo-round from first 8 hex
            let ev = JSON.parse(args[1][3]);
            expect(ev.requestId).to.equal('deadbeefcafe');
            expect(ev.providerId).to.equal('http_get');
            expect(ev.proposedBodyHash).to.equal('hashA');
            expect(ev.winnerBodyHash).to.equal('hashB');
        });
it('defaults optional evidence fields and a non-hex requestId pseudo-round', async function () {
            let pk = VALIDATORS_3[0].pubkey;
            await sd.recordAttestationDivergence(pk, 'zzzzzzzz'); // providerId + hashes omitted
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][2]).to.equal(0); // parseInt('zzzzzzzz', 16) → NaN → 0
            let ev = JSON.parse(args[1][3]);
            expect(ev.providerId).to.equal('');
            expect(ev.proposedBodyHash).to.equal('');
            expect(ev.winnerBodyHash).to.equal('');
        });
});
});
