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

const { expect }           = require('chai');
const sinon                = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const arMod                = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const { DB_METHODS }       = require('../../../../helpers/mockHub.js');

const TXID_1 = 'ab'.repeat(32);
const TXID_2 = 'cd'.repeat(32);
const PUBLISHER = 'ef'.repeat(32);
const CP_ROW = {
    chain: 'BTC', network: 'regtest', block_index: 494, checkpoint_seq: 7,
    snapshot_block: 100, anchor_txid: null
};

function makePub() {
    const rows = [];
    const verifiedTxids = [];
    const checkpoint = Object.assign({}, CP_ROW);
    const db = { ...DB_METHODS,
        async doQuery(sql, params) {
            if (sql.indexOf('SELECT * FROM state_checkpoints') === 0)
                return [Object.assign({}, checkpoint)];
            if (sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0) {
                const identity = params.slice(0, 6).join('|');
                const created = !rows.some(row => row.identity === identity);
                if (created)
                    rows.push({ identity, doge_anchor_txid: params[8] });
                return { affectedRows: created ? 1 : 0 };
            }
            return [];
        }
    };
    const pub = new StateAnchorPublisher({ db, getIdentity: () => null, hubDbBroadcaster: null });
    pub.verifyAnchorOnChain = async (_row, expected) => {
        verifiedTxids.push(expected.txid);
        return 'verified';
    };
    pub.drainBindingVerdict = async () => 'verified';
    return { pub, checkpoint, rows, verifiedTxids };
}

function queuePublish(pub, checkpoint, txid, sigByte) {
    checkpoint.anchor_txid = txid;
    pub.deferRewardAttestation({
        chain: checkpoint.chain, network: checkpoint.network,
        blockIndex: checkpoint.block_index, checkpointSeq: checkpoint.checkpoint_seq,
        txid, anchorVersion: 0,
        rewardType: 'anchor_bundle', roundReference: checkpoint.snapshot_block,
        snapshotBlock: checkpoint.snapshot_block, publisher: PUBLISHER,
        attestSigs: [{ pubkey: '12'.repeat(32), sig: sigByte.repeat(64) }]
    });
}

describe('StateAnchorPublisher same-publisher re-publish reward dedup', function () {
    beforeEach(() => sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true));
    afterEach(() => sinon.restore());

    it('writes one anchor_reward_attestations row for attestations queued on both txids', async function () {
        const { pub, checkpoint, rows, verifiedTxids } = makePub();

        queuePublish(pub, checkpoint, TXID_1, '34');
        checkpoint.anchor_txid = null;
        queuePublish(pub, checkpoint, TXID_2, '56');

        expect(pub._deferredRewardAttest.size, 'both txid-specific attestations are queued').to.equal(2);
        await pub.drainDeferredRewardAttest();

        expect(verifiedTxids, 'both the original publish and re-publish are proved').to.deep.equal([TXID_1, TXID_2]);
        expect(rows, 'uq_reward_tuple excludes the txid').to.have.lengthOf(1);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });
});
