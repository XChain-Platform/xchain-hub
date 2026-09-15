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

const crypto           = require('crypto');
const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../../../src/oracle/consensus');
const swq              = require('../../../../src/stake_weighted_quorum.js');
const { createMockHub }       = require('../../../helpers/mockHub');
const { waitUntil }           = require('../../../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        buildSubmissions, buildUniformSubmissions, SAMPLE_PRICES } = require('../../../helpers/fixtures');

const { bftQuorumOrSingle } = require('../../../../src/lib/bft_quorum.js');



    let hub, pm, oc, oracleRound;


    // The price capability snapshot a healthy indexer would return for this hub's own
    // validator set. Read at call time, not at wiring time, so a case that installs its
    // set inside the test body still gets a snapshot that matches it.
    function liveSnapshot(capability, blockIndex) {
        let vals = (oc && Array.isArray(oc.validatorSet)) ? oc.validatorSet : [];
        return {
            capability: capability,
            blockIndex: Number(blockIndex),
            count:      vals.length,
            validators: vals.map(v => ({ pubkey: v.pubkey, amount: '50000' }))
        };
    }

function registerOracleconsensus1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        // A real federated hub always resolves a BTC tip of its own, and the follower
        // now bounds the leader-supplied btcBlockHeight against it before that height
        // can pick the snapshot, the leader or the quorum mode. Same height the honest
        // PROPOSEs in this file carry, so an in-lockstep round is modelled.
        hub.resolveBtcLatestBlock = sinon.stub().resolves(900000);
        pm  = hub._peerManager;
        oracleRound = {
            getSubmissions: sinon.stub().returns(new Map())
        };
        oc = new OracleConsensus(hub, oracleRound);
        // A federated hub refuses a round with no deterministic capability snapshot (it would
        // otherwise size quorum from its own live set), so the harness models one. It resolves
        // LATE, against whatever validator set the case under test installed, which is the
        // healthy federation: the snapshot IS the qualifying set, and it yields the quorum
        // the live-set fallback would yield. Cases about the snapshot itself override this
        // with their own stub.
        hub.capabilitySnapshot = {
            getSnapshot:       async (capability, blockIndex) => liveSnapshot(capability, blockIndex),
            getWeightSnapshot: async (capability, blockIndex) => liveSnapshot(capability, blockIndex),
            getQuorum:         (snapshot) => bftQuorumOrSingle(
                snapshot && Array.isArray(snapshot.validators) ? snapshot.validators.length : 0, 0)
        };
        // These cases exercise finalize/propose logic with small fixed submission sets and model a
        // configured single/small deployment, so use the regtest override (ORACLE_MIN_SUBMISSIONS=1).
        // The 2-hub default diversity floor is covered in OracleConsensus.propose-validation.test.js.
        oc.minSubmissions = 1;
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerFallbackProposerElection2Hooks() {

        afterEach(function () {
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });
}

function registerFallbackProposerElection2Tests1() {

        it('proposeRound attaches the sorted submission keys to PROPOSE', function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[3].addr;

            // Submitters arrive out of order in the map; submissionKeys must be sorted.
            let entries = [
                { sender: VALIDATORS_4[3].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            let subs = buildSubmissions(entries);

            oc.proposeRound(7, subs, true, 100, 1700000000, null, 3);

            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.submissionKeys).to.deep.equal(
                [VALIDATORS_4[1].addr, VALIDATORS_4[3].addr].sort()
            );
        });

        it('finalizeRound (leader path) includes submissionKeys in PROPOSE', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr; // leader for round 0

            let entries = [
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);

            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.submissionKeys).to.deep.equal(
                [VALIDATORS_4[0].addr, VALIDATORS_4[1].addr].sort()
            );
        });
}

function registerFallbackProposerElection2Tests3() {

        it('accepts a fallback PROPOSE when the sender is the lowest submitter in the local map', async function () {
            // We are validator-2 ("Hub A"), a receiver. Round 4 leader is v1
            // (4 % 4 = 0), which did not submit → the fallback path applies.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            // Local view {v3, v4}: lowest is v3, so a PROPOSE from v3 is a
            // legitimate fallback by our own observation.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[2].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: {
                    round:          4,
                    prices,
                    digest,
                    btcBlockHeight: 900000,   // honest PROPOSE always carries the round's BTC height (#1225)
                    submissionKeys: [VALIDATORS_4[2].addr, VALIDATORS_4[3].addr]
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.true;
            expect(pm.broadcast.called).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PREPARE');
        });
}

function registerFallbackProposerElection2Tests4() {

        it('SECURITY: rejects a crafted PROPOSE whose submissionKeys claim the sender is the lone (lowest) submitter', async function () {
            // Attack path: a Byzantine validator (v4) sends a PROPOSE claiming
            // submissionKeys=[v4], a single-element set whose lowest entry is
            // itself, to fraudulently elect itself fallback. Our local map
            // actually holds {v2, v4}, whose lowest is v2, so v4 is NOT a
            // legitimate fallback. Trusting the claimed list (the prior bug)
            // would accept the attacker's arbitrary prices; election from the
            // local map rejects it.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // we are v2

            // Round 4 leader is v1 (absent), so the fallback branch is reachable.
            let prices = [{ coinPair: 'BTC/USD', price: '666666.00000000' }]; // attacker's fabricated price
            let digest = oc._digest(4, prices);

            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[3].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                sig_pubkey: VALIDATORS_4[3].pubkey,
                data: {
                    round:          4,
                    prices,
                    digest,
                    submissionKeys: [VALIDATORS_4[3].addr]   // self-serving claim: must be ignored
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
}

function registerFallbackProposerElection2Tests5() {

        it('rejects a PROPOSE when the sender is not the lowest submitter in the local map', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            // Local view {v3, v4}: lowest is v3, so v4 is not a legitimate fallback.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[2].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                sig_pubkey: VALIDATORS_4[3].pubkey,
                data: {
                    round:          4,
                    prices,
                    digest,
                    submissionKeys: [VALIDATORS_4[2].addr, VALIDATORS_4[3].addr]
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('elects from the local map regardless of whether submissionKeys is present', async function () {
            // submissionKeys is omitted entirely; the local map {v2, v4} still
            // governs. Lowest is v2, so v4's PROPOSE is rejected.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                sig_pubkey: VALIDATORS_4[3].pubkey,
                data: { round: 4, prices, digest }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // -----------------------------------------------------------------
    // Fallback proposer election
    //
    // The deterministic leader sometimes has no submission for a round
    // (e.g. its price fetch failed). In that case the lowest-addr submitter
    // takes over as fallback proposer. A receiver decides whether an incoming
    // PROPOSE is a legitimate fallback by electing the lowest-addr submitter
    // from ITS OWN locally-observed submission map, never from the
    // submissionKeys list piggybacked on the PROPOSE, which is
    // attacker-controlled. A Byzantine proposer could otherwise claim a subset
    // whose lowest entry is its own address and elect itself fallback even when
    // the real leader submitted, injecting arbitrary prices into the round.
    //
    // The proposer still attaches its sorted submissionKeys as a diagnostic
    // hint, but receivers ignore it for the legitimacy check. The accepted cost
    // is a liveness edge case: if async gossip leaves a receiver's local view
    // lagging, it may reject a legitimate fallback and stall the round until the
    // finalization timeout re-elects.
    // -----------------------------------------------------------------
    describe('fallback proposer election', function () {
        registerFallbackProposerElection2Hooks();
        registerFallbackProposerElection2Tests1();
        registerFallbackProposerElection2Tests3();
        registerFallbackProposerElection2Tests4();
        registerFallbackProposerElection2Tests5();
    });
});
