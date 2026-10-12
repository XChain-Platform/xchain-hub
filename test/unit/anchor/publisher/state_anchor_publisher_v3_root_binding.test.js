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

// The on-chain anchor check binds the two light-client roots on every root-bearing
// ANCHOR version: the v0 bundle sections AND the v3 fold sections. Only the v1/v2
// archive versions carry no roots, so a forged-root v3 must never verify.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../src/anchor/publisher');
const { CP_ROW, buildMesh, v0Order, mkBundleDone, registerMeshHooks } = require('../../../helpers/anchor_mesh.js');

const TXID = 'ab'.repeat(32);

function honestAnswer(over) {
    return Object.assign({
        exists: true, checkpoint_anchored: true, status: 'unverified', version: 3,
        confirmations: 60, txid: TXID,
        block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
        actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash,
        state_root: CP_ROW.state_root, block_merkle_root: CP_ROW.block_merkle_root
    }, over);
}

function barePublisher() {
    let pub = new StateAnchorPublisher({ db: {}, getIdentity: () => null, hubDbBroadcaster: null });
    pub.dogeConfirmations = 6;
    return pub;
}

describe('StateAnchorPublisher: light-client roots on v3 anchors', function () {
    registerMeshHooks();
    registerVerdictCases();
    registerBundleDoneCases();
    registerRewardDrainCases();
});

// The verdict on one getanchoraction answer, per ANCHOR version.
function registerVerdictCases() {
    it('rejects a v0 answer whose state_root diverges', function () {
        let res = honestAnswer({ version: 0, state_root: '1f'.repeat(32) });
        expect(barePublisher().anchorActionVerdict(res, CP_ROW, {}, TXID)).to.equal('rejected:mismatch');
    });

    it('rejects a v3 answer whose state_root diverges, though the core hashes match', function () {
        let res = honestAnswer({ state_root: '1f'.repeat(32) });
        expect(barePublisher().anchorActionVerdict(res, CP_ROW, { rejectVersions: [1, 2] }, TXID))
            .to.equal('rejected:mismatch');
    });

    it('rejects a v3 answer whose block_merkle_root diverges', function () {
        let res = honestAnswer({ block_merkle_root: '2f'.repeat(32) });
        expect(barePublisher().anchorActionVerdict(res, CP_ROW, { version: 3 }, TXID)).to.equal('rejected:mismatch');
    });

    it('verifies an honest v3 answer the indexer stamped unverified', function () {
        expect(barePublisher().anchorActionVerdict(honestAnswer(), CP_ROW, { version: 3 }, TXID)).to.equal('verified');
    });

    it('still verifies a rootless v1 archive head against a rooted checkpoint', function () {
        let res = honestAnswer({ version: 1, state_root: null, block_merkle_root: null });
        expect(barePublisher().anchorActionVerdict(res, CP_ROW, { version: 1 }, TXID)).to.equal('verified');
    });
}

// The BUNDLE_DONE receiver admits v3 (it rejects only {1,2}), so the roots decide.
function registerBundleDoneCases() {
    function electedBundleDone(bus, txid) {
        let order = v0Order(bus, CP_ROW);
        return { publisher: order[0], receiver: order[1], d: mkBundleDone(bus, order[0], txid) };
    }

    it('BUNDLE_DONE does not stamp a v3 anchor whose state_root is forged', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, TXID);
        receiver.pub.indexerCall = async (coin, method, params) =>
            honestAnswer({ txid: params.txid, state_root: '1f'.repeat(32) });
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'a root-forged v3 must not stamp').to.equal(null);
    });

    it('BUNDLE_DONE stamps an honest v3 anchor', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, TXID);
        receiver.pub.indexerCall = async (coin, method, params) => honestAnswer({ txid: params.txid });
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'an honest v3 stamps').to.equal(TXID);
    });
}

// The reward drain re-verifies a fold reward at anchorVersion 3 before writing its row.
function registerRewardDrainCases() {
    function drainPublisher(answer) {
        let pub = barePublisher();
        pub.indexers = { DOGE: { url: 'http://stub' } };
        pub.db = { getStateCheckpointByChain: async () => [Object.assign({}, CP_ROW)] };
        pub.indexerCall = async (coin, method) => (method === 'getanchoraction' ? answer : {
            exists: true, truncated: false,
            anchors: [{ version: 3, status: 'unverified', checkpoint_network: CP_ROW.network,
                        checkpoint_chain: CP_ROW.chain, publisher: 'cd'.repeat(32),
                        snapshot_block: CP_ROW.snapshot_block, action_index: 0, confirmations: 60 }]
        });
        pub.written = [];
        pub.recordRewardAttestation = async (...a) => { pub.written.push(a[7]); };
        pub._deferredRewardAttest.set('k', {
            chain: CP_ROW.chain, network: CP_ROW.network, blockIndex: CP_ROW.block_index,
            checkpointSeq: CP_ROW.checkpoint_seq, txid: TXID, anchorVersion: 3,
            rewardType: 'anchor_bundle', roundReference: CP_ROW.snapshot_block,
            snapshotBlock: CP_ROW.snapshot_block, publisher: 'cd'.repeat(32), attestSigs: [], at: Date.now()
        });
        return pub;
    }

    it('the reward drain drops a v3 reward whose anchor carries a forged state_root', async function () {
        let pub = drainPublisher(honestAnswer({ state_root: '1f'.repeat(32) }));
        await pub.runRewardAttestDrain();
        expect(pub.written, 'no reward row for a root-forged v3').to.deep.equal([]);
        expect(pub._deferredRewardAttest.size, 'a content mismatch is terminal').to.equal(0);
    });

    it('the reward drain writes a v3 reward whose anchor carries the honest roots', async function () {
        let pub = drainPublisher(honestAnswer());
        await pub.runRewardAttestDrain();
        expect(pub.written).to.deep.equal([TXID]);
    });
}
