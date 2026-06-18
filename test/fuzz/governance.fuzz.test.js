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
const fc         = require('fast-check');
const Governance = require('../../src/Governance');
const { createMockHub } = require('../helpers/mockHub');
const gen               = require('./generators');

describe('Fuzz: Governance', function () {

    let hub, gov;

    beforeEach(function () {
        hub = createMockHub();
        gov = new Governance(hub);
    });

    afterEach(function () {
        if (gov._tallyTimer) {
            clearInterval(gov._tallyTimer);
            gov._tallyTimer = null;
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _validateChangeBounds(): normal parameters
    // -----------------------------------------------------------------

    describe('_validateChangeBounds(): normal parameters', function () {

        it('proposed within +50% of current always passes', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 100000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n > 0),
                fc.double({ min: 0, max: 0.49, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0),
                function (current, pctIncrease) {
                    let proposed = current * (1 + pctIncrease);
                    expect(function () {
                        gov._validateChangeBounds('SOME_PARAM', String(current), String(proposed));
                    }).to.not.throw();
                }
            ), { numRuns: 200 });
        });

        it('proposed exceeding +51% of current always throws', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 10000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 1),
                fc.double({ min: 0.51, max: 2.0, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0.51),
                function (current, pctIncrease) {
                    let proposed = current * (1 + pctIncrease);
                    expect(function () {
                        gov._validateChangeBounds('SOME_PARAM', String(current), String(proposed));
                    }).to.throw(/exceeds maximum/);
                }
            ), { numRuns: 200 });
        });

        it('proposed within -32% of current always passes', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 100000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n > 0),
                fc.double({ min: 0, max: 0.32, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0),
                function (current, pctDecrease) {
                    let proposed = current * (1 - pctDecrease);
                    expect(function () {
                        gov._validateChangeBounds('SOME_PARAM', String(current), String(proposed));
                    }).to.not.throw();
                }
            ), { numRuns: 200 });
        });

        it('proposed exceeding -34% of current always throws', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 10000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 1),
                fc.double({ min: 0.34, max: 0.99, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0.34),
                function (current, pctDecrease) {
                    let proposed = current * (1 - pctDecrease);
                    expect(function () {
                        gov._validateChangeBounds('SOME_PARAM', String(current), String(proposed));
                    }).to.throw(/exceeds maximum/);
                }
            ), { numRuns: 200 });
        });
    });

    // -----------------------------------------------------------------
    // _validateChangeBounds(): slashing parameters
    // -----------------------------------------------------------------

    describe('_validateChangeBounds(): slashing parameters', function () {

        it('slash param within +24% always passes', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 100000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n > 0),
                fc.double({ min: 0, max: 0.24, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0),
                function (current, pctIncrease) {
                    let proposed = current * (1 + pctIncrease);
                    expect(function () {
                        gov._validateChangeBounds('SLASH_DEVIATION_THRESHOLD', String(current), String(proposed));
                    }).to.not.throw();
                }
            ), { numRuns: 200 });
        });

        it('slash param exceeding +26% always throws', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 10000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 1),
                fc.double({ min: 0.26, max: 2.0, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0.26),
                function (current, pctIncrease) {
                    let proposed = current * (1 + pctIncrease);
                    expect(function () {
                        gov._validateChangeBounds('SLASH_DEVIATION_THRESHOLD', String(current), String(proposed));
                    }).to.throw(/exceeds maximum/);
                }
            ), { numRuns: 200 });
        });

        it('slash param within -19% always passes', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 100000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n > 0),
                fc.double({ min: 0, max: 0.19, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0),
                function (current, pctDecrease) {
                    let proposed = current * (1 - pctDecrease);
                    expect(function () {
                        gov._validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', String(current), String(proposed));
                    }).to.not.throw();
                }
            ), { numRuns: 200 });
        });

        it('slash param exceeding -21% always throws', function () {
            fc.assert(fc.property(
                fc.double({ min: 1, max: 10000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 1),
                fc.double({ min: 0.21, max: 0.99, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 0.21),
                function (current, pctDecrease) {
                    let proposed = current * (1 - pctDecrease);
                    expect(function () {
                        gov._validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', String(current), String(proposed));
                    }).to.throw(/exceeds maximum/);
                }
            ), { numRuns: 200 });
        });
    });

    // -----------------------------------------------------------------
    // _validateChangeBounds(): skip conditions
    // -----------------------------------------------------------------

    describe('_validateChangeBounds(): skip conditions', function () {

        it('non-numeric string values always skip validation (no throw)', function () {
            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 20 })
                    .filter(function (s) { return isNaN(parseFloat(s)); }),
                fc.string({ minLength: 1, maxLength: 20 })
                    .filter(function (s) { return isNaN(parseFloat(s)); }),
                function (current, proposed) {
                    expect(function () {
                        gov._validateChangeBounds('SOME_PARAM', current, proposed);
                    }).to.not.throw();
                }
            ), { numRuns: 100 });
        });

        it('zero currentValue always skips validation (no throw)', function () {
            fc.assert(fc.property(
                fc.string({ maxLength: 20 }),
                function (proposed) {
                    expect(function () {
                        gov._validateChangeBounds('SOME_PARAM', '0', proposed);
                    }).to.not.throw();
                }
            ), { numRuns: 100 });
        });
    });

    // -----------------------------------------------------------------
    // _tallyProposal() quorum arithmetic
    // -----------------------------------------------------------------

    describe('_tallyProposal() quorum arithmetic', function () {

        it('unanimous approval always passes for any N >= 1', function () {
            return fc.assert(fc.asyncProperty(
                fc.integer({ min: 1, max: 20 }),
                async function (N) {
                    gov.setValidatorSet(gen.fc_validatorSet(N));
                    let votes = Array.from({ length: N }, function (_, i) {
                        return { voter_pubkey: 'pk' + i, vote: 'approve' };
                    });
                    // First call: get votes. Second call: update status
                    hub.db.doQuery.onFirstCall().resolves(votes);
                    hub.db.doQuery.onSecondCall().resolves([]);
                    hub._peerManager.broadcast.returns({ id: 'msg-1' });

                    let proposal = {
                        proposal_id:    'p1',
                        parameter:      'TEST_PARAM',
                        current_value:  '1',
                        proposed_value: '1.1'
                    };
                    await gov._tallyProposal(proposal);

                    let updateCall = hub.db.doQuery.secondCall;
                    expect(updateCall.args[1][0]).to.equal('passed');
                    hub.db.doQuery.reset();
                }
            ), { numRuns: 20 });
        });

        it('zero votes always fails for any N >= 1', function () {
            return fc.assert(fc.asyncProperty(
                fc.integer({ min: 1, max: 20 }),
                async function (N) {
                    gov.setValidatorSet(gen.fc_validatorSet(N));
                    hub.db.doQuery.onFirstCall().resolves([]);
                    hub.db.doQuery.onSecondCall().resolves([]);
                    hub._peerManager.broadcast.returns({ id: 'msg-1' });

                    let proposal = {
                        proposal_id:    'p2',
                        parameter:      'TEST_PARAM',
                        current_value:  '1',
                        proposed_value: '1.1'
                    };
                    await gov._tallyProposal(proposal);

                    let updateCall = hub.db.doQuery.secondCall;
                    expect(updateCall.args[1][0]).to.equal('failed');
                    hub.db.doQuery.reset();
                }
            ), { numRuns: 20 });
        });

        it('all-reject votes always fail for any N >= 1', function () {
            return fc.assert(fc.asyncProperty(
                fc.integer({ min: 1, max: 20 }),
                async function (N) {
                    gov.setValidatorSet(gen.fc_validatorSet(N));
                    let votes = Array.from({ length: N }, function (_, i) {
                        return { voter_pubkey: 'pk' + i, vote: 'reject' };
                    });
                    hub.db.doQuery.onFirstCall().resolves(votes);
                    hub.db.doQuery.onSecondCall().resolves([]);
                    hub._peerManager.broadcast.returns({ id: 'msg-1' });

                    let proposal = {
                        proposal_id:    'p3',
                        parameter:      'TEST_PARAM',
                        current_value:  '1',
                        proposed_value: '1.1'
                    };
                    await gov._tallyProposal(proposal);

                    let updateCall = hub.db.doQuery.secondCall;
                    expect(updateCall.args[1][0]).to.equal('failed');
                    hub.db.doQuery.reset();
                }
            ), { numRuns: 20 });
        });
    });
});
