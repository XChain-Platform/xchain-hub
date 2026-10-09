'use strict';

const { expect } = require('chai');
const registry = require('../../../src/consensus/gate_registry.js');
const { isFederatedHubActive, liveFederationSignals } = require('../../../src/consensus/federation');
const membership = require('../../../src/cross_chain/attest/membership.js');
const finalization = require('../../../src/oracle/round/finalization.js');

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

describe('consensus/federation FEDERATED_HUB_ACTIVATION gate', () => {
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

    describe('cross-chain resolveQuorum', () => {
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
    });

    describe('oracle scheduleFinalization', () => {
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
    });
});
