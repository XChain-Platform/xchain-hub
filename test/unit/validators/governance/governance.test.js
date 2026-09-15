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

const sinon        = require('sinon');
const { expect }   = require('chai');
const Governance   = require('../../../../src/validators/governance');
const ValidatorIdentity = require('../../../../src/validators/identity');
const { createMockHub }   = require('../../../helpers/mockHub');
const { VALIDATORS_3 }    = require('../../../helpers/fixtures');

let hub, pm, identity, gov;

function installSuiteHooks1() {
    beforeEach(function () {
            hub      = createMockHub();
            pm       = hub._peerManager;
            identity = hub._identity;
            // Set the identity pubkey to match a validator
            identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
            gov = new Governance(hub);
            gov.setValidatorSet(VALIDATORS_3);
        });
    afterEach(function () {
            if (gov._tallyTimer) clearInterval(gov._tallyTimer);
            sinon.restore();
        });
}

// validateChangeBounds()
// Normal, slashing, and edge parameters retain separate bounds and numeric parsing coverage.
describe('Governance', function () {
    installSuiteHooks1();
describe('validateChangeBounds()', function () {
describe('normal parameters', function () {
it('allows 50% increase', function () {
                expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '150')).to.not.throw();
            });
it('rejects 51% increase', function () {
                expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '151')).to.throw(/exceeds maximum/);
            });
it('allows 33% decrease', function () {
                expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '67')).to.not.throw();
            });
it('rejects 34% decrease', function () {
                expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '66')).to.throw(/exceeds maximum/);
            });
it('allows exact boundary increase (50%)', function () {
                expect(() => gov.validateChangeBounds('P', '200', '300')).to.not.throw();
            });
it('allows exact boundary decrease (33%)', function () {
                // 100 → 67 is -33%. 100 * 0.33 = 33, so 67 is exactly -33%
                expect(() => gov.validateChangeBounds('P', '100', '67')).to.not.throw();
            });
});
describe('slashing parameters', function () {
it('allows 25% increase for SLASH_DEVIATION_THRESHOLD', function () {
                expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.0625')).to.not.throw();
            });
it('rejects 26% increase for SLASH_DEVIATION_THRESHOLD', function () {
                expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.063')).to.throw(/exceeds maximum/);
            });
it('allows 20% decrease for SLASH_MISSED_ROUNDS_THRESHOLD', function () {
                expect(() => gov.validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '30', '24')).to.not.throw();
            });
it('rejects 21% decrease for SLASH_MISSED_ROUNDS_THRESHOLD', function () {
                expect(() => gov.validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '30', '23')).to.throw(/exceeds maximum/);
            });
// The ratio bound caps only a change's SIZE; the slash band also has an ABSOLUTE floor, ORACLE_DEVIATION_THRESHOLD,
// hard-enforced by SlashDetector's constructor: a decrease inside -20% but under that floor would pass and brick the next boot.
it('rejects a SLASH_DEVIATION_THRESHOLD decrease below the oracle band floor', function () {
                // 0.05 -> 0.04 is exactly -20%: inside the ratio bound, under the floor.
                expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.04'))
                    .to.throw(/below the federation-uniform/);
                expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.045'))
                    .to.throw(/below the federation-uniform/);
            });
it('allows a SLASH_DEVIATION_THRESHOLD at or above the oracle band floor', function () {
                expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.05')).to.not.throw();
                expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.0625')).to.not.throw();
            });
it('reports the ratio error when a decrease busts both the bound and the floor', function () {
                expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.03'))
                    .to.throw(/exceeds maximum/);
            });
it('applies no floor to SLASH_MISSED_ROUNDS_THRESHOLD (it carries no cross-constant band)', function () {
                expect(() => gov.validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '0.05', '0.04')).to.not.throw();
            });
});
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('validateChangeBounds()', function () {
describe('edge cases', function () {
it('skips validation for non-numeric values', function () {
                expect(() => gov.validateChangeBounds('P', 'abc', 'def')).to.not.throw();
            });
it('skips validation when current value is 0', function () {
                expect(() => gov.validateChangeBounds('P', '0', '100')).to.not.throw();
            });
it('treats null / undefined values as non-numeric and skips', function () {
                expect(() => gov.validateChangeBounds('P', null, '100')).to.not.throw();
                expect(() => gov.validateChangeBounds('P', '100', undefined)).to.not.throw();
            });
it('parses an explicit + sign', function () {
                expect(() => gov.validateChangeBounds('P', '+100', '+120')).to.not.throw();
            });
it('parses a leading-dot fraction (empty integer part)', function () {
                expect(() => gov.validateChangeBounds('P', '.5', '.6')).to.not.throw();
            });
it('enforces bounds when the current value is negative', function () {
                // C=-100: a move to -160 is a 60% magnitude increase → exceeds.
                expect(() => gov.validateChangeBounds('P', '-100', '-160')).to.throw(/exceeds maximum/);
                // A small move stays within bounds.
                expect(() => gov.validateChangeBounds('P', '-100', '-120')).to.not.throw();
            });
});
});
});

// propose()
// Proposal coverage includes activation, cooldown, identity, and field-length validation.
// ── Block-anchored activation (#3703 / #3685) ─────────────────────────
// CAPABILITY_*_MIN_STAKE governance is pinned off pre-launch (#4352), so the
// activation-computation path is exercised here via ATTESTATION_PROVIDER:* params,
// which are also block-anchored (#3685) and NOT pinned.
describe('Governance', function () {
    installSuiteHooks1();
describe('propose()', function () {
it('creates a proposal and broadcasts', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])   // active check
                .onSecondCall().resolves([])   // cooldown check
                .onThirdCall().resolves();     // INSERT

            let result = await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '900000', 'Increase round time');
            expect(result.proposalId).to.include('gov:ORACLE_ROUND_INTERVAL:');
            expect(result.status).to.equal('voting');
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_PROPOSE');
            // Non-capability parameters carry no activation block.
            expect(result.activationBlock).to.equal(null);
            expect(pm.broadcast.getCall(0).args[1].activationBlock).to.equal(null);
        });
it('computes a block-anchored activation for a block-anchored proposal', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]).onThirdCall().resolves();
            hub._latestBlockIndex = 500;
            gov.votingPeriod = 604800000; // 7 days → ceil(/600000) = 1008 blocks
            let result = await gov.propose('ATTESTATION_PROVIDER:llm', '10000', '12000');
            // 500 (latest) + 1008 (voting period in blocks) + 50 (safety buffer)
            expect(result.activationBlock).to.equal(1558);
            let payload = pm.broadcast.getCall(0).args[1];
            expect(payload.activationBlock).to.equal(1558);
        });
it('rejects an explicit activation block that is too soon', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]);
            hub._latestBlockIndex = 500;
            gov.votingPeriod = 604800000;
            try {
                await gov.propose('ATTESTATION_PROVIDER:llm', '10000', '12000', null, 600);
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('too soon');
            }
        });
it('throws when anchoring a block-anchored change with no observed block height', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]);
            hub._latestBlockIndex = null;
            try {
                await gov.propose('ATTESTATION_PROVIDER:llm', '10000', '12000');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('no observed block height');
            }
        });
});
});

// ── Pre-launch MIN_STAKE governance pin (#4352) ───────────────────────
describe('Governance', function () {
    installSuiteHooks1();
describe('propose()', function () {
it('refuses to create a CAPABILITY_*_MIN_STAKE proposal (pinned pre-launch)', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]);
            hub._latestBlockIndex = 500;
            try {
                await gov.propose('CAPABILITY_PRICE_MIN_STAKE', '10000', '11000');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('disabled pre-launch');
            }
            // No proposal row was inserted (the INSERT is the 3rd doQuery; only the 2 pre-checks ran).
            expect(pm.broadcast.called).to.equal(false);
        });
it('throws when no identity configured', async function () {
            hub.getIdentity.returns({ getPubkeyHex: () => null });
            let gov2 = new Governance(hub);
            gov2.setValidatorSet(VALIDATORS_3);

            try {
                await gov2.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('No validator identity');
            }
        });
it('throws when proposer is not a validator', async function () {
            identity.getPubkeyHex.returns('ff'.repeat(32)); // Not in validator set
            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });
it('throws when active proposal exists for same parameter', async function () {
            hub.db.doQuery.onFirstCall().resolves([{ id: 1 }]); // active proposal found

            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Active proposal already exists');
            }
        });
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('propose()', function () {
it('throws when cooldown has not expired', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])  // no active
                .onSecondCall().resolves([{ voting_end: new Date() }]); // recent rejection

            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Cooldown');
            }
        });
it('allows proposal when cooldown has expired', async function () {
            let oldDate = new Date(Date.now() - 15 * 86400000); // 15 days ago
            hub.db.doQuery
                .onFirstCall().resolves([])
                .onSecondCall().resolves([{ voting_end: oldDate }])
                .onThirdCall().resolves();

            let result = await gov.propose('P', '100', '120');
            expect(result.status).to.equal('voting');
        });
it('throws when change bounds are violated', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])
                .onSecondCall().resolves([]);

            try {
                await gov.propose('P', '100', '200'); // 100% increase
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('exceeds maximum');
            }
        });
it('rejects a parameter name longer than 255 characters', async function () {
            try {
                await gov.propose('P'.repeat(256), '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('255');
            }
        });
it('rejects a rationale longer than 2000 characters', async function () {
            try {
                await gov.propose('P', '1', '2', 'x'.repeat(2001));
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('2000');
            }
        });
});
});

// vote()
describe('Governance', function () {
    installSuiteHooks1();
describe('vote()', function () {
it('records a vote and broadcasts', async function () {
            hub.db.doQuery.onFirstCall().resolves([{
                proposal_id: 'gov:P:1', status: 'voting',
                voting_end: new Date(Date.now() + 86400000)
            }]);
            hub.db.doQuery.onSecondCall().resolves();

            let result = await gov.vote('gov:P:1', 'approve');
            expect(result.vote).to.equal('approve');
            expect(result.voter).to.equal(VALIDATORS_3[0].pubkey);
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_VOTE');
        });
it('throws on invalid vote choice', async function () {
            try {
                await gov.vote('gov:P:1', 'maybe');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('approve');
            }
        });
it('throws when proposal not found', async function () {
            hub.db.doQuery.resolves([]);
            try {
                await gov.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('not found');
            }
        });
it('throws when voting period has ended', async function () {
            hub.db.doQuery.resolves([{
                proposal_id: 'gov:P:1', status: 'voting',
                voting_end: new Date(Date.now() - 1000) // already ended
            }]);
            try {
                await gov.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('ended');
            }
        });
it('throws when no validator identity is configured', async function () {
            hub.getIdentity.returns({ getPubkeyHex: () => null });
            let gov2 = new Governance(hub);
            gov2.setValidatorSet(VALIDATORS_3);
            try {
                await gov2.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('No validator identity');
            }
        });
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('vote()', function () {
it('throws when the voter is not an active validator', async function () {
            identity.getPubkeyHex.returns('ff'.repeat(32)); // not in the set
            try {
                await gov.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });
});
});
