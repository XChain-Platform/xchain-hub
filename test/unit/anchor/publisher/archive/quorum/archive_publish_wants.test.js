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

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const vectors = require('../../../../../fixtures/anchor_archive_vectors.json');

const ACTIVE_BLOCK = 480;
const PRE_GATE_BLOCK = 961000;
const REWARD_BLOCK = 470;
const SET = [{ pubkey: 'aa'.repeat(32), amount: '1', source: '' }];

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

function buildPub(){
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS }, network: 'regtest',
        getIdentity: () => new ValidatorIdentity('11'.repeat(32)),
        getPeerManager: () => ({ broadcast() {} }), p2pConfig: {}
    });
    pub.resolveCapabilitySet = async () => SET;
    return pub;
}

function rewardAt(block){
    const reward = copy(vectors.B.inputs.rewards[0]);
    reward.row.block_index = block;
    return reward;
}

describe('archive publish capability wants', function () {
    it('makes buildArchive and follower seeding demand archive_publish only for the active wrapper', async function () {
        const pub = buildPub();
        const result = await pub.buildArchive(
            'regtest', 7, [], ACTIVE_BLOCK, [], [rewardAt(REWARD_BLOCK)], {}
        );
        const archive = JSON.parse(result.json);
        expect(archive.capability_snapshots.map(row => [row.snapshot_block, row.capability])).to.deep.equal([
            [REWARD_BLOCK, 'oracle_publish'],
            [ACTIVE_BLOCK, 'archive_publish']
        ]);

        const groups = new Map();
        expect(pub.seedRequiredSnapshotGroups(groups, archive, ACTIVE_BLOCK)).to.equal(true);
        expect([...groups.keys()]).to.deep.equal([
            REWARD_BLOCK + '|oracle_publish',
            ACTIVE_BLOCK + '|archive_publish'
        ]);
    });

    it('keeps the pre-gate archive bytes on the oracle_publish wrapper group', async function () {
        const pub = buildPub();
        const result = await pub.buildArchive('mainnet', 7, [], PRE_GATE_BLOCK, [], [], {});
        const pubkey = 'aa'.repeat(32);
        const expected = '{"v":1,"network":"mainnet","batch_seq":7,"matches":[],"calls":[],' +
            '"rewards":[],"capability_snapshots":[{"snapshot_block":961000,' +
            '"capability":"oracle_publish","signing_pubkey":"' + pubkey +
            '","amount":"1","source":""}]}';

        expect(result.json).to.equal(expected);
    });
});
