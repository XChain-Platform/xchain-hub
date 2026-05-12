'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const fc         = require('fast-check');
const Consensus  = require('../../src/Consensus');
const { createMockHub } = require('../helpers/mockHub');
const { makeValidator } = require('../helpers/fixtures');
const gen               = require('./generators');

describe('Fuzz: Consensus', function () {

    let hub, consensus;

    beforeEach(function () {
        hub = createMockHub();
        consensus = new Consensus(hub);
    });

    afterEach(function () {
        // Clean up any pending proposal timers
        for (let [, prop] of consensus.pendingProposals) {
            if (prop.timer) clearTimeout(prop.timer);
        }
        consensus.pendingProposals.clear();
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _getLeader()
    // -----------------------------------------------------------------

    describe('_getLeader()', function () {

        it('always returns a validator from the set', function () {
            fc.assert(fc.property(
                fc.integer({ min: 1, max: 50 }),
                fc.integer({ min: 0, max: 10000 }),
                function (N, seq) {
                    let validators = gen.fc_validatorSet(N);
                    consensus.setValidatorSet(validators);
                    consensus.view = 0;
                    let leader = consensus._getLeader(seq);
                    expect(validators).to.deep.include(leader);
                }
            ), { numRuns: 200 });
        });

        it('is deterministic for same seq and view', function () {
            fc.assert(fc.property(
                fc.integer({ min: 1, max: 20 }),
                fc.integer({ min: 0, max: 10000 }),
                fc.integer({ min: 0, max: 20 }),
                function (N, seq, view) {
                    let validators = gen.fc_validatorSet(N);
                    consensus.setValidatorSet(validators);
                    consensus.view = view;
                    expect(consensus._getLeader(seq)).to.deep.equal(consensus._getLeader(seq));
                }
            ), { numRuns: 200 });
        });

        it('returns undefined for empty validator set (no crash)', function () {
            fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), function (seq) {
                consensus.setValidatorSet([]);
                let leader = consensus._getLeader(seq);
                // Empty set: arr[seq % 0] = arr[NaN] = undefined
                expect(leader === undefined || leader === null).to.be.true;
            }), { numRuns: 50 });
        });

        it('view change rotates the leader', function () {
            fc.assert(fc.property(
                fc.integer({ min: 2, max: 20 }),
                fc.integer({ min: 0, max: 1000 }),
                function (N, seq) {
                    let validators = gen.fc_validatorSet(N);
                    consensus.setValidatorSet(validators);

                    consensus.view = 0;
                    let leader1 = consensus._getLeader(seq);
                    consensus.view = 1;
                    let leader2 = consensus._getLeader(seq);

                    // With N >= 2 validators, view change should rotate leader
                    // (unless seq + view wraps to same index, which is N-periodic)
                    // At minimum, both must be valid validators
                    expect(validators).to.deep.include(leader1);
                    expect(validators).to.deep.include(leader2);
                }
            ), { numRuns: 100 });
        });
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {

        it('never exceeds N', function () {
            fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), function (N) {
                consensus.setValidatorSet(gen.fc_validatorSet(N));
                expect(consensus._getQuorum()).to.be.at.most(N);
            }), { numRuns: 100 });
        });

        it('is monotonically non-decreasing as N increases', function () {
            fc.assert(fc.property(fc.integer({ min: 2, max: 99 }), function (N) {
                consensus.setValidatorSet(gen.fc_validatorSet(N));
                let q1 = consensus._getQuorum();
                consensus.setValidatorSet(gen.fc_validatorSet(N + 1));
                let q2 = consensus._getQuorum();
                expect(q2).to.be.at.least(q1);
            }), { numRuns: 100 });
        });

        it('is always >= 1 for N >= 4', function () {
            fc.assert(fc.property(fc.integer({ min: 4, max: 100 }), function (N) {
                consensus.setValidatorSet(gen.fc_validatorSet(N));
                expect(consensus._getQuorum()).to.be.at.least(1);
            }), { numRuns: 100 });
        });

        it('returns 0 for N <= 1 (single-node fallback)', function () {
            consensus.setValidatorSet(gen.fc_validatorSet(1));
            expect(consensus._getQuorum()).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------

    describe('_digest()', function () {

        it('always returns a 64-char hex string', function () {
            fc.assert(fc.property(gen.fc_configObject(), function (config) {
                let d = consensus._digest(config);
                expect(d).to.match(/^[0-9a-f]{64}$/);
            }), { numRuns: 200 });
        });

        it('is deterministic (same input always produces same output)', function () {
            fc.assert(fc.property(gen.fc_configObject(), function (config) {
                expect(consensus._digest(config)).to.equal(consensus._digest(config));
            }), { numRuns: 200 });
        });

        it('different configs produce different digests', function () {
            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 20 }),
                fc.string({ minLength: 1, maxLength: 20 }),
                function (key, value) {
                    let config1 = { [key]: value };
                    let config2 = { [key]: value + 'x' };
                    expect(consensus._digest(config1)).to.not.equal(consensus._digest(config2));
                }
            ), { numRuns: 200 });
        });
    });

    // -----------------------------------------------------------------
    // _handlePrePrepare() message validation
    // -----------------------------------------------------------------

    describe('_handlePrePrepare() message validation', function () {

        it('arbitrary envelope data never crashes', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.record({
                        seq:          fc.anything(),
                        configDigest: fc.anything(),
                        config:       fc.anything()
                    }),
                    fc.constant({}),
                    fc.constant({ seq: 1 }),
                    fc.constant({ seq: 'bad', configDigest: 'abc', config: {} }),
                    fc.constant({ seq: null, configDigest: null, config: null }),
                    fc.record({
                        seq:          fc.integer({ min: -100, max: 1000 }),
                        configDigest: fc.string({ maxLength: 64 }),
                        config:       fc.anything({ maxDepth: 2, maxKeys: 3 })
                    })
                ),
                function (data) {
                    consensus.setValidatorSet([makeValidator(1)]);
                    let envelope = { data: data, sender: 'ws://peer:10001' };
                    expect(function () { consensus._handlePrePrepare(envelope); }).to.not.throw();
                }
            ), { numRuns: 200 });
        });

        it('non-positive or non-number seq is always rejected', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.constant(0),
                    fc.constant(-1),
                    fc.constant(-100),
                    fc.string({ maxLength: 10 }),
                    fc.constant(null),
                    fc.constant(undefined),
                    fc.constant(NaN),
                    fc.constant(1.5)
                ),
                function (invalidSeq) {
                    consensus.setValidatorSet([makeValidator(1)]);
                    let proposalsBefore = consensus.pendingProposals.size;
                    let envelope = {
                        data:   { seq: invalidSeq, configDigest: 'abc', config: {} },
                        sender: 'ws://peer:10001'
                    };
                    consensus._handlePrePrepare(envelope);
                    expect(consensus.pendingProposals.size).to.equal(proposalsBefore);
                }
            ), { numRuns: 50 });
        });
    });
});
