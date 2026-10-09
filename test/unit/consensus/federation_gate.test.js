'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const registry = require('../../../src/consensus/gate_registry.js');
const { isFederatedHubActive, liveFederationSignals } = require('../../../src/consensus/federation');
const Consensus = require('../../../src/consensus/pbft');
const membership = require('../../../src/cross_chain/attest/membership.js');
const finalizeRoundMethods = require('../../../src/oracle/consensus/finalize_round.js');
const finalization = require('../../../src/oracle/round/finalization.js');
const { createMockHub } = require('../../helpers/mockHub.js');

const KEY = 'consensus/federation.FEDERATED_HUB_ACTIVATION';

function engine({ quorum = 0, peers = [], validatorSet = [], network = 'regtest' } = {}) {
    return {
        hub: { network, capabilitySnapshot: null },
        validatorSet,
        minValidators: 1,
        peerManager: { getPeerStatus: () => peers },
        getQuorum: () => quorum,
    };
}

function registerGateTests() {
    it('is armed on regtest only', () => {
        expect(registry.get(KEY)).to.deep.equal({
            mainnet: registry.UNARMED, testnet: registry.UNARMED, regtest: 0,
        });
    });

    it('reads active from the anchor height, not from wall clock', () => {
        expect(isFederatedHubActive('regtest', 0)).to.equal(true);
        expect(isFederatedHubActive('regtest', null)).to.equal(false);
        expect(isFederatedHubActive('mainnet', 1e9)).to.equal(false);
        expect(isFederatedHubActive(undefined, 5)).to.equal(false);
    });

    it('collects open peers only', () => {
        const signals = liveFederationSignals(engine({ peers: [{ state: 'open' }, { state: 'closed' }] }));
        expect(signals.peers).to.have.length(1);
    });
}

function registerCrossChainTests() {
    const call = (e, height) => membership.resolveQuorum.call(e, 'A', 'B', height);

    it('refuses when only an open peer proves the hub federated and the gate is active', async () => {
        const e = engine({ peers: [{ state: 'open' }] });
        e.getChainPairSet = () => [];
        e.getQuorum = () => 0;
        let err;
        try { await call(e, 10); } catch (x) { err = x; }
        expect(err && err.message).to.match(/refusing to resolve quorum/);
    });

    it('keeps the live fallback when the gate is inactive', async () => {
        const e = engine({ peers: [{ state: 'open' }], network: 'mainnet' });
        expect(await call(e, 10)).to.equal(0);
    });

    it('keeps the live fallback for a standalone hub with the gate active', async () => {
        expect(await call(engine(), 10)).to.equal(0);
    });
}

function registerOracleTests() {
    const run = (consensus, network) => new Promise((resolve) => {
        const stored = [];
        const ctx = {
            hub: { network }, currentBtcBlockHeight: 7, currentBtcBlockTime: 100,
            chainTipFallbackActive: true, finalizationTimers: new Map(), submissionWindow: 0,
            oracleConsensus: Object.assign(consensus, {
                storeSkippedRound: (...a) => { stored.push(a); return Promise.resolve(); },
                finalizeRound: () => { stored.push('finalize'); return Promise.resolve(); },
            }),
        };
        finalization.scheduleFinalization.call(ctx, 1);
        setTimeout(() => resolve(stored), 20);
    });

    it('skips a round-number anchor on an open-peer hub once the gate is active', async () => {
        const stored = await run(engine({ peers: [{ state: 'open' }] }), 'regtest');
        expect(stored).to.have.length(1);
        expect(stored[0][3]).to.equal('round-number anchor on a federated hub');
    });

    it('keeps the legacy path when the gate is inactive', async () => {
        const stored = await run(engine({ peers: [{ state: 'open' }], network: 'mainnet' }), 'mainnet');
        expect(stored).to.deep.equal(['finalize']);
    });

    it('makes finalizeRound skip a null snapshot when only an open peer proves federation', async () => {
        const stored = [];
        const ctx = Object.assign(engine({ peers: [{ state: 'open' }] }), {
            finalized: new Set(), minSubmissions: 1, _singleSourceRounds: 0,
            oracleRound: { getSubmissions: () => new Map([['self', { prices: [] }]]) },
            computeMinRoundSources: finalizeRoundMethods.computeMinRoundSources,
            hasDeterministicSnapshot: () => false,
            isEmptyFederationSnapshot: () => false,
            storeSkippedRound: (...args) => { stored.push(args); return Promise.resolve(); },
        });

        await finalizeRoundMethods.finalizeRound.call(ctx, 2, 10, 100);

        expect(stored).to.have.length(1);
        expect(stored[0][3]).to.equal('no deterministic capability snapshot');
    });
}

function registerPbftTests() {
    let hub;
    let consensus;

    beforeEach(() => {
        hub = createMockHub({ network: 'regtest' });
        hub.resolveBtcLatestBlock.resolves(10);
        hub.capabilitySnapshot = {
            getActiveValidatorSnapshot: sinon.stub().resolves(null),
            getActiveWeightSnapshot: sinon.stub().resolves(null),
            getQuorum: sinon.stub().returns(0),
        };
        hub._peerManager.getPeerStatus.returns([{ state: 'open' }]);
        consensus = new Consensus(hub);
        consensus.setValidatorSet([{ addr: 'ws://leader:10001', pubkey: 'aa' }]);
    });

    afterEach(() => sinon.restore());

    it('makes propose refuse a null snapshot when only an open peer proves federation', async () => {
        let error;
        try { await consensus.propose({ setting: true }); } catch (err) { error = err; }

        expect(error && error.message).to.match(/without a deterministic validator snapshot/);
        expect(hub.applyConfig.called).to.equal(false);
        expect(hub._peerManager.broadcast.called).to.equal(false);
    });

    it('makes the follower refuse the same null snapshot without broadcasting PREPARE', async () => {
        sinon.stub(consensus, 'isKnownSender').returns(true);
        const config = { setting: true };
        await consensus.handlePrePrepare({
            sender: 'ws://leader:10001', sig_pubkey: 'aa',
            data: {
                seq: 1, view: 0, config, configDigest: consensus.digest(config),
                btcBlockHeight: 10,
            },
        });

        expect(consensus.pendingProposals.has(1)).to.equal(false);
        expect(hub._peerManager.broadcast.called).to.equal(false);
    });
}

describe('consensus/federation FEDERATED_HUB_ACTIVATION gate', () => {
    registerGateTests();
    describe('cross-chain resolveQuorum', registerCrossChainTests);
    describe('oracle scheduleFinalization', registerOracleTests);
    describe('PBFT round guards', registerPbftTests);
});
