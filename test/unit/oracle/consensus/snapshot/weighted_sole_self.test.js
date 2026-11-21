'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const OracleConsensus = require('../../../../../src/oracle/consensus');
const { createMockHub } = require('../../../../helpers/mockHub');
const { buildSubmissions, SAMPLE_PRICES } = require('../../../../helpers/fixtures');

describe('weighted sole-self price rounds', function () {
    let hub, consensus, oracleRound, submissions;

    beforeEach(function () {
        hub = createMockHub();
        hub.network = 'regtest';
        oracleRound = { getSubmissions: sinon.stub() };
        consensus = new OracleConsensus(hub, oracleRound);
        consensus.minSubmissions = 1;
        submissions = buildSubmissions([{
            sender: hub._peerManager.validatorAddr,
            prices: [{ coinPair: 'BTC/USD', price: '100000' }]
        }]);
        oracleRound.getSubmissions.returns(submissions);
    });

    afterEach(function () { sinon.restore(); });

    function installSnapshot(firstWeight, lastWeight){
        const self = consensus.selfPubkey();
        const snapshot = { blockIndex: 900000, count: 2, validators: [
            { pubkey: self, source: 'source-a', weight: firstWeight },
            { pubkey: self.toUpperCase(), source: 'source-b', weight: lastWeight }
        ] };
        hub.capabilitySnapshot = {
            getWeightSnapshot: sinon.stub().resolves(snapshot),
            getQuorum: sinon.stub().returns(2)
        };
        sinon.stub(consensus, 'memberPubkeySet').returns(new Set([self]));
        sinon.stub(consensus, 'filterSubmissionsToSnapshot').returns(submissions);
    }

    it('skips immediately when one signature cannot clear the chain threshold', async function () {
        installSnapshot('60', '40');
        const skipped = sinon.stub(consensus, 'storeSkippedRound').resolves();
        const watchdog = sinon.spy(consensus, 'armRoundWatchdog');

        await consensus.finalizeRound(2, 900000, 1700000000);

        expect(skipped.calledOnce).to.equal(true);
        expect(skipped.firstCall.args[3]).to.include('one signature cannot clear');
        expect(watchdog.called).to.equal(false);
    });

    it('solo-finalizes when the credited source clears the chain threshold', async function () {
        installSnapshot('20', '80');
        sinon.stub(consensus, 'aggregateAll').returns(SAMPLE_PRICES.slice(0, 1));
        const stored = sinon.stub(consensus, 'storeSnapshot').resolves();
        const watchdog = sinon.spy(consensus, 'armRoundWatchdog');

        await consensus.finalizeRound(3, 900000, 1700000000);

        expect(stored.calledOnce).to.equal(true);
        expect(consensus.finalized.has(3)).to.equal(true);
        expect(watchdog.called).to.equal(false);
    });
});
