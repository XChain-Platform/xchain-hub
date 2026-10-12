'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The reward drain writes a row only when the mined txid binds to the entry's
// (network, snapshot_block, publisher), judged by the byte twin of the indexer's rule.

const { expect }           = require('chai');
const fs                   = require('fs');
const path                 = require('path');
const StateAnchorPublisher = require('../../../../src/anchor/publisher');

const PUB   = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const TXID  = 'ab'.repeat(32);

function anchorRow(over) {
    return Object.assign({ version: 0, status: 'valid', checkpoint_network: 'regtest', publisher: PUB,
        snapshot_block: 100, action_index: 0, confirmations: 10 }, over);
}

function makePub(anchors) {
    let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
    pub.dogeConfirmations = 6;
    pub.db = { getStateCheckpointByChain: async () => [{ chain: 'BTC' }] };
    pub.verifyAnchorOnChain = async () => 'verified';
    pub.indexerCall = async () => ({ exists: true, anchors: anchors, truncated: false });
    pub.written = [];
    pub.recordRewardAttestation = async (...a) => { pub.written.push(a[7]); };
    return pub;
}

function queue(pub, over) {
    let e = Object.assign({ chain: 'BTC', network: 'regtest', blockIndex: 494, checkpointSeq: 7, txid: TXID,
        anchorVersion: 0, rewardType: 'anchor_bundle', roundReference: 100, snapshotBlock: 100,
        publisher: PUB, attestSigs: [], at: Date.now() }, over);
    pub._deferredRewardAttest.set('k', e);
    return e;
}

describe('reward drain: txid binding', function () {
    it('the vendored binding is a byte twin of the indexer copy', function () {
        let mine = path.join(__dirname, '../../../../src/anchor/anchor_proof_binding.js');
        let theirs = path.join(__dirname, '../../../../../xchain-indexer/src/consensus/doge_peer_clients/anchor_proof_client/binding.js');
        if (!fs.existsSync(theirs)) this.skip();
        expect(fs.readFileSync(mine).equals(fs.readFileSync(theirs))).to.equal(true);
    });

    it('writes the row when the txid binds to the tuple', async function () {
        let pub = makePub([anchorRow()]);
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([TXID]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('drops the entry and writes nothing when the txid belongs to another publisher', async function () {
        let pub = makePub([anchorRow({ publisher: OTHER })]);
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('drops the entry when the txid belongs to another snapshot block', async function () {
        let pub = makePub([anchorRow({ snapshot_block: 99 })]);
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('drops the entry when the txid belongs to another network', async function () {
        let pub = makePub([anchorRow({ checkpoint_network: 'mainnet' })]);
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

});

describe('reward drain: undecided and malformed entries', function () {
    it('retains the entry, writing nothing, while the anchor is too shallow', async function () {
        let pub = makePub([anchorRow({ confirmations: 2 })]);
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(1);
    });

    it('retains the entry when the indexer knows no anchor on the txid', async function () {
        let pub = makePub([]);
        pub.indexerCall = async () => ({ exists: false });
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(1);
    });

    it('retains the entry when no DOGE indexer URL is configured', async function () {
        let pub = makePub([]);
        pub.indexerCall = async () => { throw new Error('no indexer url for DOGE'); };
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(1);
    });

    it('retains the entry when the indexer response omits anchor rows', async function () {
        let pub = makePub([]);
        pub.indexerCall = async () => ({ exists: true });
        queue(pub);
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(1);
    });

    it('counts an anchor_bundle entry whose round_reference differs from its snapshot_block, and never writes it', async function () {
        let pub = makePub([anchorRow()]);
        queue(pub, { roundReference: 7 });
        await pub.runRewardAttestDrain();
        expect(pub._rewardBundleRoundMismatch).to.equal(1);
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });
});
