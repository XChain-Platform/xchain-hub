'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ar = require('../../../../../src/consensus/gates/anchor_reward_gate.js');

function makePublisher(){
    return new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
}

function reward(over){
    return Object.assign({
        chain: 'BTC',
        network: 'regtest',
        reward_type: 'anchor_bundle',
        round_reference: 42,
        snapshot_block: 42,
        publisher: 'aa'.repeat(32),
        doge_anchor_txid: 'bb'.repeat(32),
        anchor_version: 0,
        block_index: 42,
        checkpoint_seq: 7,
        attest_sigs: [{ pubkey: 'cc'.repeat(32), sig: 'dd'.repeat(64) }],
        sig_pubkey: 'ee'.repeat(32)
    }, over || {});
}

describe('folded reward federation', function () {
    beforeEach(() => sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(true));
    afterEach(() => sinon.restore());

    it('accepts a v3 bundle as a version 3 reward tuple', function () {
        const tuple = makePublisher().federatedRewardTuple(reward({ anchor_version: 3 }));
        expect(tuple).to.include({ rewardType: 'anchor_bundle', version: 3 });
    });

    it('rejects a v3 archive tuple', function () {
        const tuple = makePublisher().federatedRewardTuple(reward({
            reward_type: 'anchor_archive',
            anchor_version: 3
        }));
        expect(tuple).to.equal(null);
    });

    it('preserves v0 bundle and v1 archive tuples', function () {
        const pub = makePublisher();
        const bundle = pub.federatedRewardTuple(reward());
        const archive = pub.federatedRewardTuple(reward({
            reward_type: 'anchor_archive',
            anchor_version: 1
        }));

        expect(bundle).to.deep.equal({
            network: 'regtest', snapshotBlock: 42, rewardType: 'anchor_bundle',
            chain: 'BTC', publisher: 'aa'.repeat(32), txid: 'bb'.repeat(32),
            sender: 'ee'.repeat(32), roundRef: 42, version: 0, blockIndex: 42, cpSeq: 7
        });
        expect(archive).to.deep.equal({
            network: 'regtest', snapshotBlock: 42, rewardType: 'anchor_archive',
            chain: 'BTC', publisher: 'aa'.repeat(32), txid: 'bb'.repeat(32),
            sender: 'ee'.repeat(32), roundRef: 42, version: 1, blockIndex: 42, cpSeq: 7
        });
    });

    it('rejects version 2', function () {
        expect(makePublisher().federatedRewardTuple(reward({ anchor_version: 2 }))).to.equal(null);
    });
});
