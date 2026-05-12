'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const crypto     = require('crypto');
const Consensus  = require('../../../src/Consensus');
const { createMockHub }    = require('../../helpers/mockHub');
const { VALIDATORS_4 }     = require('../../helpers/fixtures');
const { buildEnvelope }    = require('../../helpers/testPeerNetwork');

function makeDigest(config) {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

describe('Chaos: PBFT Leader Crash (CON-1)', function () {
    this.timeout(15000);

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('follower detects leader timeout and initiates view change', async function () {
        // Validator-2 is a follower; leader (validator-1) will crash
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[1].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        con.timeout = 200;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { coin: 'BTC', action: 'test' };
        let digest = makeDigest(config);

        // Leader sends PRE_PREPARE then "crashes"
        hub._peerManager.emit('message', buildEnvelope('PBFT_PRE_PREPARE', {
            seq: 1, configDigest: digest, config: config
        }, VALIDATORS_4[0].addr));

        let proposal = con.pendingProposals.get(1);
        expect(proposal).to.exist;

        // Wait for follower timeout (2x leader timeout = 400ms)
        await new Promise(r => setTimeout(r, 500));

        // Proposal should have been cleaned up by timeout
        expect(con.pendingProposals.has(1)).to.be.false;

        con.stop();
    });

    it('view change produces new leader', async function () {
        // Validator-1 proposes and times out; view change rotates leader
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        // seq=3 → nextSeq=4 → leader=validators[(4+0)%4]=validators[0] (this node)
        con.seq = 3;
        con.timeout = 100;
        hub.db.doQuery.resolves([]);

        await con.start();

        let err;
        try {
            await con.propose({ key: 'will-timeout' });
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(con.view).to.equal(1);

        // With view=1, leader for seq 4 = validators[(4+1) % 4] = validators[1]
        let newLeader = con._getLeader(4);
        expect(newLeader.addr).to.equal(VALIDATORS_4[1].addr);

        con.stop();
    });

    it('view change quorum achieved → new leader broadcasts NEW_VIEW', async function () {
        // Validator-3 (index 2) becomes new leader after view change
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[2].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        hub.db.doQuery.resolves([]);

        await con.start();

        // Receive VIEW_CHANGE votes for view=1, seq=1
        hub._peerManager.emit('message', buildEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[0].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[1].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[3].addr));

        // Quorum = 3 for N=4; 3 votes → view change succeeds
        expect(con.view).to.equal(1);

        // Leader for seq=1, view=1: validators[(1+1) % 4] = validators[2] → this node
        expect(con._isLeader(1)).to.be.true;

        // NEW_VIEW should have been broadcast
        expect(hub._peerManager.broadcast.calledWith('PBFT_NEW_VIEW')).to.be.true;

        con.stop();
    });

    it('NEW_VIEW updates followers view number', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[3].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        hub.db.doQuery.resolves([]);

        await con.start();

        expect(con.view).to.equal(0);

        hub._peerManager.emit('message', buildEnvelope('PBFT_NEW_VIEW', {
            view: 1, seq: 1
        }, VALIDATORS_4[2].addr));

        expect(con.view).to.equal(1);

        con.stop();
    });

    it('config write completes under new leader after view change', async function () {
        // New leader (validator-3, index 2) proposes after view change
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[2].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        con.view = 1;
        // seq=0 → nextSeq=1 → leader=validators[(1+1)%4]=validators[2] (this node)
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        expect(con._isLeader(1)).to.be.true;

        let config = { coin: 'BTC', param: 'recovered' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });

        // Other validators send PREPARE
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[0].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[1].addr));

        // COMMITs
        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[0].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[1].addr));

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;
        expect(hub.applyConfig.getCall(0).args[0]).to.deep.equal(config);

        con.stop();
    });

    it('no double-apply when late COMMITs arrive after finalization', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        // seq=3 → nextSeq=4 → leader=validators[0]
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'no-double' };
        let digest = makeDigest(config);

        let promise = con.propose(config);

        // PREPAREs (quorum=3: self + 2)
        for (let i = 1; i <= 2; i++) {
            hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
                seq: 4, configDigest: digest
            }, VALIDATORS_4[i].addr));
        }

        // COMMITs (quorum=3: self + 2)
        for (let i = 1; i <= 2; i++) {
            hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
                seq: 4, configDigest: digest
            }, VALIDATORS_4[i].addr));
        }

        await promise;
        expect(hub.applyConfig.callCount).to.equal(1);

        // Late COMMIT from validator-4
        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[3].addr));

        await new Promise(r => setTimeout(r, 50));

        // Still only applied once
        expect(hub.applyConfig.callCount).to.equal(1);

        con.stop();
    });
});
