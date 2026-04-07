'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const crypto     = require('crypto');
const Consensus       = require('../../../src/Consensus');
const OracleConsensus = require('../../../src/OracleConsensus');
const OracleRound     = require('../../../src/OracleRound');
const { createMockHub }                         = require('../../helpers/mockHub');
const { VALIDATORS_4, makeValidator, SAMPLE_PRICES } = require('../../helpers/fixtures');
const { buildEnvelope }                         = require('../../helpers/testPeerNetwork');

function makeDigest(config) {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

describe('Chaos: Validator Churn During Consensus (XC-5)', function () {
    this.timeout(15000);

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('adding a validator mid-round does not disrupt current consensus', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4]; // 4 validators, quorum=3
        // seq=3 → nextSeq=4 → leader=validators[(4+0)%4]=validators[0]
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'during-churn' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });

        // Mid-round: add 5th validator
        let v5 = makeValidator(5);
        con.validatorSet.push(v5);
        // Quorum is now recalculated as 3 for N=5 (f=1, 2f+1=3)

        // PREPAREs from original validators
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        // COMMITs
        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;

        con.stop();
    });

    it('removing a validator mid-round may reduce quorum', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4]; // N=4, quorum=3
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'remove-churn' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });

        // Mid-round: remove validator 4 (reduce to N=3)
        // N=3: f=0, quorum=1
        con.validatorSet.pop();

        // Now only need 1 PREPARE beyond self
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        // 1 COMMIT beyond self
        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;

        con.stop();
    });

    it('leader rotation reflects updated validator set', function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4];

        // Leader for seq=1, view=0: validators[(1+0) % 4] = validators[1]
        expect(con._getLeader(1).addr).to.equal(VALIDATORS_4[1].addr);

        // Add 5th validator
        let v5 = makeValidator(5);
        con.validatorSet.push(v5);

        // Leader for seq=1, view=0: validators[(1+0) % 5] = validators[1] (same)
        expect(con._getLeader(1).addr).to.equal(VALIDATORS_4[1].addr);

        // seq=4: validators[(4+0) % 5] = validators[4] = v5
        expect(con._getLeader(4).addr).to.equal(v5.addr);
    });

    it('quorum calculation adjusts with validator set changes', function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);

        // N=4: f=1, quorum=3
        con.validatorSet = [...VALIDATORS_4];
        expect(con._getQuorum()).to.equal(3);

        // N=5: f=1, quorum=3
        con.validatorSet.push(makeValidator(5));
        expect(con._getQuorum()).to.equal(3);

        // N=7: f=2, quorum=5
        con.validatorSet.push(makeValidator(6));
        con.validatorSet.push(makeValidator(7));
        expect(con._getQuorum()).to.equal(5);

        // N=1: quorum=0 (single-node)
        con.validatorSet = [VALIDATORS_4[0]];
        expect(con._getQuorum()).to.equal(0);
    });

    it('oracle leader changes when validator set changes between rounds', function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let oracle = new OracleRound(hub);
        let oracleCon = new OracleConsensus(hub, oracle);
        oracleCon.validatorSet = [...VALIDATORS_4];

        // Round 4: leader = validators[4 % 4] = validators[0]
        expect(oracleCon._getLeader(4).addr).to.equal(VALIDATORS_4[0].addr);

        // Add 5th validator
        let v5 = makeValidator(5);
        oracleCon.validatorSet.push(v5);

        // Round 4: leader = validators[4 % 5] = validators[4] = v5
        expect(oracleCon._getLeader(4).addr).to.equal(v5.addr);

        // Round 5: leader = validators[5 % 5] = validators[0]
        expect(oracleCon._getLeader(5).addr).to.equal(VALIDATORS_4[0].addr);
    });

    it('new validator can participate in subsequent round', async function () {
        let v5 = makeValidator(5);
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4, v5]; // N=5, quorum=3
        // seq=4 → nextSeq=5 → leader=validators[(5+0)%5]=validators[0]
        con.seq = 4;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'v5-participates' };
        let digest = makeDigest(config);

        let promise = con.propose(config);

        // v5 and validator-2 send PREPARE
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 5, configDigest: digest
        }, v5.addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 5, configDigest: digest
        }, VALIDATORS_4[1].addr));

        // COMMITs
        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 5, configDigest: digest
        }, v5.addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 5, configDigest: digest
        }, VALIDATORS_4[1].addr));

        let result = await promise;
        expect(result).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;

        con.stop();
    });

    it('rapid churn: multiple adds/removes do not crash consensus', function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4];

        // Rapidly add validators
        for (let i = 5; i <= 15; i++) {
            con.validatorSet.push(makeValidator(i));
        }
        expect(con._getQuorum()).to.be.gt(0);

        // Remove most validators
        con.validatorSet = [VALIDATORS_4[0], VALIDATORS_4[1]];
        // N=2: f = floor((2-1)/3) = 0, quorum = 2*0+1 = 1
        expect(con._getQuorum()).to.equal(1);

        // Single validator
        con.validatorSet = [VALIDATORS_4[0]];
        expect(con._getQuorum()).to.equal(0);

        // Back to normal
        con.validatorSet = [...VALIDATORS_4];
        expect(con._getQuorum()).to.equal(3);
    });
});
