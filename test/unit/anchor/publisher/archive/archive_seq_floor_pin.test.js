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

// Pins the archive batch-seq floor mechanics (_observedConsumedBatchSeq init,
// noteConsumedBatchSeq, getNextBatchSeq) that the boot-time seed will feed.

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

function mkPub(){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const db = { ...DB_METHODS, doQuery: async () => [] };
    return new StateAnchorPublisher({
        db: db, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        rewardTracker: { anchorReward: '10.00000000', resolveSourceByPubkey: async () => 'src' },
        resolveBtcLatestBlock: async () => 100
    });
}

describe('StateAnchorPublisher: archive batch-seq floor pin', function () {

    it('starts a fresh publisher with no observed consumed seq', function () {
        const pub = mkPub();
        expect(pub._observedConsumedBatchSeq).to.equal(-1);
    });

    it('ignores null, undefined, empty-string and non-numeric observations', function () {
        const pub = mkPub();
        pub.noteConsumedBatchSeq(null, 'test');
        pub.noteConsumedBatchSeq(undefined, 'test');
        pub.noteConsumedBatchSeq('', 'test');
        pub.noteConsumedBatchSeq('abc', 'test');
        expect(pub._observedConsumedBatchSeq).to.equal(-1);
    });

    it('raises the floor on a note and never lowers it on a smaller later note', function () {
        const pub = mkPub();
        pub.noteConsumedBatchSeq(7, 'test');
        expect(pub._observedConsumedBatchSeq).to.equal(7);
        pub.noteConsumedBatchSeq(3, 'test');
        expect(pub._observedConsumedBatchSeq).to.equal(7);
    });

    describe('getNextBatchSeq with a row-derived seq of 5', function () {

        it('returns the row-derived seq with no floor observed', async function () {
            const pub = mkPub();
            pub.db.getNextAnchorBatchSeq = sinon.stub().resolves([{ next_seq: 5 }]);
            expect(await pub.getNextBatchSeq()).to.equal(5);
        });

        it('returns above the floor once a higher consumed seq was noted', async function () {
            const pub = mkPub();
            pub.db.getNextAnchorBatchSeq = sinon.stub().resolves([{ next_seq: 5 }]);
            pub.noteConsumedBatchSeq(7, 'test');
            expect(await pub.getNextBatchSeq()).to.equal(8);
        });

        it('ignores a floor implausibly far above the row-derived seq', async function () {
            const pub = mkPub();
            pub.db.getNextAnchorBatchSeq = sinon.stub().resolves([{ next_seq: 5 }]);
            pub.noteConsumedBatchSeq(1100, 'test');
            expect(await pub.getNextBatchSeq()).to.equal(5);
        });
    });
});
