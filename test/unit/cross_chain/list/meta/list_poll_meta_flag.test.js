'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const assert = require('assert');
const sinon = require('sinon');

const ListShareEngine = require('../../../../../src/cross_chain/list_share_engine.js');
const {
    listMembersHash,
    listMetaHash
} = require('../../../../../src/cross_chain/list/canonical.js');
const { deriveListSnapshotId } = require('../../../../../src/cross_chain/list/chain.js');

const ROOT_INDEX = 7;
const SNAPSHOT_BLOCK = '500';
const ORIGIN_BLOCK = 114;
const ADMIT_BLOCKS = { BTC: 510, DOGE: 511, LTC: 512 };
const VALIDATORS = [{ pubkey: 'validator', source: '', weight: '1', amount: '1' }];

function listRead(meta = {}) {
    const members = ['a'];
    return {
        type: 2,
        members,
        hash: listMembersHash(members),
        ...meta
    };
}

function makeEngine(read, metaActive) {
    const db = {
        getLatestListSeq: sinon.stub().resolves(0),
        findListSnapshotChain: sinon.stub().resolves([])
    };
    const hub = {
        db,
        network: 'regtest',
        p2pConfig: {},
        getPeerManager: () => null,
        getIdentity: () => null,
        resolveAdmitBlocks: sinon.stub().resolves(ADMIT_BLOCKS)
    };
    const engine = new ListShareEngine(hub);
    engine.indexerCall = sinon.stub().resolves(read);
    sinon.stub(engine, 'resolveCapabilityValidators').resolves(VALIDATORS);
    sinon.stub(engine.listConsensus, 'propose').resolves();

    if (metaActive !== undefined) {
        engine.activation.listMeta = sinon.stub().returns(metaActive);
    }
    return engine;
}

function proposal(engine) {
    assert.strictEqual(engine.listConsensus.propose.callCount, 1);
    return engine.listConsensus.propose.firstCall.args[1];
}

function legacyRow() {
    return {
        snapshot_id: deriveListSnapshotId(
            'regtest', 'DOGE', ROOT_INDEX, 1, SNAPSHOT_BLOCK
        ),
        snapshot_block: Number(SNAPSHOT_BLOCK),
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: ROOT_INDEX,
        list_type: 2,
        seq: 1,
        kind: 'full',
        added: JSON.stringify(['a']),
        removed: '[]',
        members_hash: listMembersHash(['a']),
        origin_block: ORIGIN_BLOCK,
        admit_block_btc: 510,
        admit_block_doge: 511,
        admit_block_ltc: 512
    };
}

async function snapshot(engine) {
    await engine.maybeSnapshotList(
        'DOGE', ROOT_INDEX, ORIGIN_BLOCK, SNAPSHOT_BLOCK
    );
}

describe('shared-list leader poll metadata activation', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps the first-share proposal unchanged without an active reader', async function () {
        const withoutReader = makeEngine(listRead());
        const inactiveReader = makeEngine(listRead(), false);

        await snapshot(withoutReader);
        await snapshot(inactiveReader);

        assert.deepStrictEqual(proposal(withoutReader).row, legacyRow());
        assert.deepStrictEqual(proposal(inactiveReader).row, legacyRow());
        assert.deepStrictEqual(inactiveReader.activation.listMeta.firstCall.args,
            [Number(SNAPSHOT_BLOCK), 'regtest', 'BTC']);
    });

    it('refuses a pre-metadata read when the metadata gate is active', async function () {
        const engine = makeEngine(listRead(), true);

        await snapshot(engine);

        assert.strictEqual(engine.listConsensus.propose.callCount, 0);
        assert.strictEqual(engine.hub.resolveAdmitBlocks.callCount, 0);
        assert.deepStrictEqual(engine.activation.listMeta.firstCall.args,
            [Number(SNAPSHOT_BLOCK), 'regtest', 'BTC']);
    });

    it('proposes a canonical metadata read when the metadata gate is active', async function () {
        const name = 'Named list';
        const description = 'A description';
        const metaHash = listMetaHash(name, description);
        const engine = makeEngine(listRead({
            name,
            description,
            meta_hash: metaHash
        }), true);

        await snapshot(engine);

        assert.deepStrictEqual(proposal(engine).row, {
            ...legacyRow(),
            name,
            description,
            meta_hash: metaHash
        });
        assert.deepStrictEqual(engine.activation.listMeta.firstCall.args,
            [Number(SNAPSHOT_BLOCK), 'regtest', 'BTC']);
    });
});
