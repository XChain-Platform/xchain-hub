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

// getanchoraction reports checkpoint_anchored from every anchor row on the checkpoint
// key, not from the announced txid. A checkpoint key carries a v0 bundle and a v1 archive
// head, so a txid-filtered miss on an anchored key is the normal state of an honest
// announcement whose own tx is still unmined. That miss must queue the announcement, and
// only a returned row naming another txid is a forge.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');

const TXID  = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const CP    = { chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7, snapshot_block: 100 };

function makePub() {
    let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
    pub.indexers = { DOGE: { url: 'http://indexer.invalid' } };
    return pub;
}

function verdictFor(pub, res) {
    pub.indexerCall = async () => res;
    return pub.verifyAnchorOnChain(CP, { txid: TXID, rejectVersions: [1, 2] });
}

describe('txid-filtered getanchoraction miss on an anchored checkpoint', function () {
    it('reads as undecided, not a forge', async function () {
        let v = await verdictFor(makePub(), { exists: false, checkpoint_anchored: true, confirmations: 0 });
        expect(v).to.equal('absent:other-anchor');
        expect(v.startsWith('rejected')).to.equal(false);
    });

    it('still reads absent when nothing anchors the checkpoint', async function () {
        expect(await verdictFor(makePub(), { exists: false, checkpoint_anchored: false, confirmations: 0 }))
            .to.equal('absent');
    });

    it('still rejects a returned row that names another txid', async function () {
        let v = await verdictFor(makePub(), {
            exists: true, checkpoint_anchored: true, status: 'valid', version: 0, txid: OTHER, confirmations: 99
        });
        expect(v).to.equal('rejected:txid');
    });

    it('queues a BUNDLE_DONE instead of dropping it', function () {
        let pub = makePub();
        let queued = [];
        pub.deferBundleDone = (d, sender, reason) => queued.push(reason);
        let stop = pub.bundleDoneUnproven({ txid: TXID }, 'pk', 'regtest', 100, ['absent:other-anchor']);
        expect(stop).to.equal(true);
        expect(queued).to.deep.equal(['absent:other-anchor']);
    });
});
