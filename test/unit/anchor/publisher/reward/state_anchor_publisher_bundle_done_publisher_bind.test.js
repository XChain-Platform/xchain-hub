'use strict';

// GENERATED

const { expect } = require('chai');
const ar = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const registry = require('../../../../../src/consensus/gate_registry.js');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher.js');

const GATE = 'anchor/publisher/bundle_done.BUNDLE_DONE_PUBLISHER_BIND_ACTIVATION';
const PUBLISHER = 'ab'.repeat(32);
const TXID = 'cd'.repeat(32);
const ROWS = [{ chain: 'BTC', block_index: 10, checkpoint_seq: 1, snapshot_block: 50 }];

function makePublisher(verdict){
    const pub = Object.create(StateAnchorPublisher.prototype);
    pub.stamps = [];
    pub.rewards = [];
    pub.bindings = [];
    pub.db = {
        updateStateCheckpoint: async (...args) => pub.stamps.push(args)
    };
    pub.recordReward = (...args) => pub.rewards.push(args);
    pub.drainBindingVerdict = async (entry) => {
        pub.bindings.push(entry);
        return verdict;
    };
    return pub;
}

async function apply(pub, network){
    await pub.applyBundleDone({ network, txid: TXID, snapshot_block: 50, sections: [] }, PUBLISHER, ROWS);
}

function registerGateRowCase(){
    it('is armed from regtest genesis and unarmed on mainnet and testnet', function () {
        expect(registry.get(GATE)).to.deep.equal({
            mainnet: registry.UNARMED,
            testnet: registry.UNARMED,
            regtest: 0
        });
    });
}

function registerBindingVerdictCases(){
    for(const verdict of ['rejected', 'unknown']){
        it('does not mirror the reward on regtest when the publisher binding is ' + verdict, async function () {
            const pub = makePublisher(verdict);

            await apply(pub, 'regtest');

            expect(pub.stamps).to.have.length(1);
            expect(pub.rewards).to.deep.equal([]);
            expect(pub.bindings).to.have.length(1);
        });
    }

    it('mirrors the reward on regtest only when the txid binds to the publisher', async function () {
        const pub = makePublisher('verified');

        await apply(pub, 'regtest');

        expect(pub.rewards).to.deep.equal([
            ['anchor_bundle', 50, PUBLISHER, 50, 'regtest']
        ]);
        expect(pub.bindings).to.deep.equal([{
            rewardType: 'anchor_bundle',
            network: 'regtest',
            publisher: PUBLISHER,
            roundReference: 50,
            snapshotBlock: 50,
            txid: TXID
        }]);
    });
}

function registerLegacyMirrorCases(){
    for(const network of ['mainnet', 'testnet']){
        it('preserves the legacy mirror before activation on ' + network, async function () {
            const pub = makePublisher('rejected');

            await apply(pub, network);

            expect(pub.rewards).to.have.length(1);
            expect(pub.bindings).to.deep.equal([]);
        });
    }
}

function registerRetiredMirrorCase(){
    it('does not query the binding after the anchor reward gate retires the mirror', async function () {
        ar.isAnchorRewardActive = () => true;
        const pub = makePublisher('verified');

        await apply(pub, 'regtest');

        expect(pub.rewards).to.deep.equal([]);
        expect(pub.bindings).to.deep.equal([]);
    });
}

describe('BUNDLE_DONE publisher binding gate', function () {
    let savedAnchorRewardActive;

    beforeEach(function () {
        savedAnchorRewardActive = ar.isAnchorRewardActive;
        ar.isAnchorRewardActive = () => false;
    });

    afterEach(function () {
        ar.isAnchorRewardActive = savedAnchorRewardActive;
    });

    registerGateRowCase();
    registerBindingVerdictCases();
    registerLegacyMirrorCases();
    registerRetiredMirrorCase();
});
