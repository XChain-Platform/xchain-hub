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

// The reward drain screens anchor_archive rows past the archive fold term exactly as the
// indexer does before it mints, so the hub never writes an attestation the indexer refuses.

const { expect }           = require('chai');
const path                 = require('path');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const registry             = require('../../../../../src/consensus/gate_registry.js');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');

const HUB_KEY     = 'anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION';
const INDEXER_KEY = 'anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION';
const INDEXER_REGISTRY = path.join(__dirname, '../../../../../../xchain-indexer/src/consensus/gate_registry.js');
const INDEXER_CLIENT   = path.join(__dirname,
    '../../../../../../xchain-indexer/src/consensus/doge_peer_clients/anchor_proof_client.js');
const CANON_PATH  = path.join(__dirname, '../../../../../../xchain-documentation/protocol/constants.js');

const PUB   = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const TXID  = 'ab'.repeat(32);

// BTC testnet: fold 155001, term 156230. DOGE testnet: fold 67962387, term 67989993.
const SNAPSHOT_BELOW_TERM = 156000;
const SNAPSHOT_PAST_TERM  = 156300;
const DOGE_BELOW_TERM     = 67980000;
const DOGE_PAST_TERM      = 67990000;

function archiveRow(over) {
    return Object.assign({ version: 1, status: 'valid', checkpoint_network: 'testnet', publisher: PUB,
        snapshot_block: SNAPSHOT_BELOW_TERM, match_batch_seq: 42, action_index: 0, confirmations: 10,
        block_index_doge: DOGE_BELOW_TERM }, over);
}

function entry(over) {
    return Object.assign({ chain: 'BTC', network: 'testnet', blockIndex: 494, checkpointSeq: 7, txid: TXID,
        anchorVersion: 1, rewardType: 'anchor_archive', roundReference: 42, snapshotBlock: SNAPSHOT_BELOW_TERM,
        publisher: PUB, attestSigs: [], at: Date.now() }, over);
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

async function drain(anchors, over) {
    let pub = makePub(anchors);
    pub._deferredRewardAttest.set('k', entry(over));
    await pub.runRewardAttestDrain();
    return pub;
}

// A past-term archive entry is refused before any DOGE call, so an empty, missing or failed
// answer cannot hold it; below the term an empty first page still defers.
async function expectPastTermRefusedBeforeDoge() {
    for (const answer of [{ exists: false, anchors: [] }, { exists: true, anchors: [] }, null, 'throw']) {
        let held = makePub([]);
        held.indexerCalls = 0;
        held.indexerCall = async () => {
            held.indexerCalls++;
            if (answer === 'throw') throw new Error('DOGE indexer unreachable');
            return answer;
        };
        held._deferredRewardAttest.set('k', entry({ snapshotBlock: SNAPSHOT_PAST_TERM }));
        await held.runRewardAttestDrain();
        expect(held.written, JSON.stringify(answer)).to.deep.equal([]);
        expect(held._deferredRewardAttest.size, JSON.stringify(answer)).to.equal(0);
        expect(held.indexerCalls, JSON.stringify(answer)).to.equal(0);
    }
    let below = makePub([]);
    below.indexerCall = async () => ({ exists: false, anchors: [] });
    below._deferredRewardAttest.set('k', entry());
    await below.runRewardAttestDrain();
    expect(below._deferredRewardAttest.size, 'below the term an empty first page still defers').to.equal(1);
}

describe('reward drain: archive fold-term screen', function () {
    it('holds the term gate row equal to the indexer row and the canonical constants', function () {
        if (!skipOrFail(this, siblingCheckout(__dirname, INDEXER_REGISTRY), 'the archive term row parity guard')) return;
        if (!skipOrFail(this, siblingCheckout(__dirname, CANON_PATH), 'the archive term canonical check')) return;
        const indexer = require(INDEXER_REGISTRY);
        const canon = require(CANON_PATH);
        expect(registry.get(HUB_KEY)).to.deep.equal(indexer.get(INDEXER_KEY));
        expect(registry.get(HUB_KEY)).to.deep.equal(canon.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION);
    });

    it('reaches the same verdict as the indexer proof client on the DOGE plane', async function () {
        if (!skipOrFail(this, siblingCheckout(__dirname, INDEXER_CLIENT), 'the archive term verdict parity guard')) return;
        const AnchorProofClient = require(INDEXER_CLIENT);
        const client = new AnchorProofClient({ NETWORK: 'testnet' }, { url: '' });
        const cases = [
            [archiveRow()],
            [archiveRow({ block_index_doge: DOGE_PAST_TERM })],
            [archiveRow({ block_index_doge: DOGE_PAST_TERM }), archiveRow({ match_batch_seq: 43 })],
            [archiveRow({ block_index_doge: DOGE_PAST_TERM, publisher: OTHER })],
            [archiveRow({ block_index_doge: DOGE_PAST_TERM, version: 6 })],
            [archiveRow({ block_index_doge: DOGE_PAST_TERM, confirmations: 1 })],
            [archiveRow({ block_index_doge: null })]
        ];
        for (const anchors of cases) {
            const e = entry();
            const expectOf = { rewardType: e.rewardType, network: e.network, publisher: e.publisher,
                roundReference: e.roundReference, snapshotBlock: e.snapshotBlock, minConfirmations: 6 };
            const hub = await makePub(anchors).drainBindingVerdict(e);
            expect(hub, JSON.stringify(anchors)).to.equal(client.judge(anchors, expectOf));
        }
    });

    it('writes no attestation for an archive reward whose only anchor landed past the term', async function () {
        let pub = await drain([archiveRow({ block_index_doge: DOGE_PAST_TERM })]);
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('still writes an archive reward whose anchor landed below the term', async function () {
        let pub = await drain([archiveRow()]);
        expect(pub.written).to.deep.equal([TXID]);
    });

    it('writes no attestation for an archive reward whose BTC snapshot block is past the term', async function () {
        let pub = await drain([archiveRow({ snapshot_block: SNAPSHOT_PAST_TERM })],
                              { snapshotBlock: SNAPSHOT_PAST_TERM });
        expect(pub.written).to.deep.equal([]);
        expect(pub._deferredRewardAttest.size).to.equal(0);
        await expectPastTermRefusedBeforeDoge();
    });

    it('leaves a bundle reward unscreened past the term', async function () {
        let row = archiveRow({ version: 0, match_batch_seq: null, block_index_doge: DOGE_PAST_TERM,
                               snapshot_block: SNAPSHOT_PAST_TERM, checkpoint_chain: 'BTC' });
        let pub = await drain([row], { rewardType: 'anchor_bundle', roundReference: SNAPSHOT_PAST_TERM,
                                       snapshotBlock: SNAPSHOT_PAST_TERM, anchorVersion: 0 });
        expect(pub.written).to.deep.equal([TXID]);
    });
});
