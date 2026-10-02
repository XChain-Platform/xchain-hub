'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const ah = require('../../../../../src/lib/admission_height.js');
const ListShareEngine = require('../../../../../src/cross_chain/list_share_engine.js');
const validate = require('../../../../../src/cross_chain/list/validate.js');
const {
    deriveListSnapshotId,
    listMembersHash,
    listMetaHash
} = require('../../../../../src/cross_chain/list/canonical.js');

const MEMBERS = ['a', 'b'];
const MEMBERS_HASH = listMembersHash(MEMBERS);
const SNAPSHOT_BLOCK = 500;
const ORIGIN_BLOCK = 100;
const ADMIT_BLOCKS = { BTC: 510, DOGE: 511, LTC: 512 };
const VALIDATORS = [{ pubkey: 'validator', source: '', weight: '1', amount: '1' }];

function listRead(name, description) {
    return {
        type: 2,
        members: MEMBERS,
        hash: MEMBERS_HASH,
        name,
        description,
        meta_hash: listMetaHash(name, description)
    };
}

function heldRow(metaHash, meta = {}) {
    return {
        seq: 1,
        kind: 'full',
        list_type: 2,
        added: JSON.stringify(MEMBERS),
        removed: '[]',
        members_hash: MEMBERS_HASH,
        origin_block: 90,
        meta_hash: metaHash,
        ...meta
    };
}

function producerEngine(read, initialRows = []) {
    const state = { heldRows: initialRows };
    const db = {
        getLatestListSeq: sinon.stub().callsFake(async () => state.heldRows.length),
        findListSnapshotChain: sinon.stub().callsFake(async () => state.heldRows)
    };
    const hub = {
        db,
        network: 'regtest',
        p2pConfig: {},
        getPeerManager: () => null,
        getIdentity: () => null,
        resolveBtcLatestBlock: async () => SNAPSHOT_BLOCK,
        resolveAdmitBlocks: sinon.stub().resolves(ADMIT_BLOCKS)
    };
    const engine = new ListShareEngine(hub);
    engine.indexers = {
        BTC: { url: '' },
        DOGE: { url: 'http://doge.invalid' },
        LTC: { url: '' }
    };
    engine.confirmations.DOGE = 6;
    engine.indexerCall = sinon.stub().callsFake(async (chain, method, params) => {
        assert.strictEqual(chain, 'DOGE');
        if (method === 'getlatestblock') return { block_index: ORIGIN_BLOCK + 6 };
        if (method === 'getsharedlists') {
            assert.deepStrictEqual(params, { network: 'regtest' });
            return [{ root_index: 7, share_block: 80 }];
        }
        if (method === 'getlistat') {
            assert.deepStrictEqual(params, { list_index: 7, block: ORIGIN_BLOCK });
            return read;
        }
        throw new Error('unexpected method ' + method);
    });
    sinon.stub(engine, 'resolveCapabilityValidators').resolves(VALIDATORS);
    sinon.stub(engine.listConsensus, 'propose').resolves();
    return { engine, state };
}

function proposed(engine) {
    assert.strictEqual(engine.listConsensus.propose.callCount, 1);
    return engine.listConsensus.propose.firstCall.args[1].row;
}

function proposedRow(meta = {}) {
    const row = {
        snapshot_block: SNAPSHOT_BLOCK,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: 7,
        list_type: 2,
        seq: 1,
        kind: 'full',
        added: JSON.stringify(MEMBERS),
        removed: '[]',
        members_hash: MEMBERS_HASH,
        origin_block: ORIGIN_BLOCK,
        ...meta
    };
    row.snapshot_id = deriveListSnapshotId(
        row.network,
        row.home_chain,
        row.home_list_index,
        row.seq,
        row.snapshot_block
    );
    return row;
}

function followerContext(read) {
    return {
        network: 'regtest',
        activation: {
            producer: () => true,
            listMeta: sinon.stub().returns(true)
        },
        confirmations: { DOGE: 6 },
        resolveSnapshotBlock: async () => SNAPSHOT_BLOCK,
        db: {
            getListSnapshotAtSeq: async () => null,
            getLatestListSeq: async () => 0,
            findListSnapshotChain: async () => []
        },
        async indexerCall(chain, method) {
            assert.strictEqual(chain, 'DOGE');
            if (method === 'getsharedlists') {
                return [{ root_index: 7, share_block: 80 }];
            }
            if (method === 'getlatestblock') return { block_index: 106 };
            if (method === 'getlistat') return read;
            throw new Error('unexpected method ' + method);
        }
    };
}

describe('shared-list metadata versions', function () {
    afterEach(function () { sinon.restore(); });

    it('proposes a rename-only version with getlistat metadata at the gate', async function () {
        sinon.stub(ah, 'isAdmissionEra').returns(true);
        const read = listRead('New name', 'New description');
        const { engine } = producerEngine(read, [heldRow(
            listMetaHash('Old name', 'Old description'),
            { name: 'Old name', description: 'Old description' }
        )]);

        await engine.poll();

        assert.strictEqual(typeof engine.activation.listMeta, 'function');
        assert.strictEqual(engine.activation.listMeta(SNAPSHOT_BLOCK, 'regtest', 'BTC'), true);
        assert.deepStrictEqual(proposed(engine), {
            snapshot_id: deriveListSnapshotId('regtest', 'DOGE', 7, 2, SNAPSHOT_BLOCK),
            snapshot_block: SNAPSHOT_BLOCK,
            network: 'regtest',
            home_chain: 'DOGE',
            home_list_index: 7,
            list_type: 2,
            seq: 2,
            kind: 'delta',
            added: '[]',
            removed: '[]',
            members_hash: MEMBERS_HASH,
            origin_block: ORIGIN_BLOCK,
            name: 'New name',
            description: 'New description',
            meta_hash: read.meta_hash,
            admit_block_btc: 510,
            admit_block_doge: 511,
            admit_block_ltc: 512
        });
    });

    it('proposes nothing when membership and metadata are unchanged at the gate', async function () {
        sinon.stub(ah, 'isAdmissionEra').returns(true);
        const read = listRead('Current name', null);
        const { engine } = producerEngine(read, [heldRow(
            read.meta_hash,
            { name: read.name, description: read.description }
        )]);

        await engine.poll();

        assert.strictEqual(engine.listConsensus.propose.callCount, 0);
        assert.strictEqual(engine.hub.resolveAdmitBlocks.callCount, 0);
    });
});

describe('shared-list metadata compatibility', function () {
    afterEach(function () { sinon.restore(); });

    it('makes exactly one version for a list named before the gate', async function () {
        sinon.stub(ah, 'isAdmissionEra').returns(true);
        const read = listRead('Existing name', null);
        const { engine, state } = producerEngine(read, [heldRow(null)]);

        await engine.poll();

        const first = proposed(engine);
        state.heldRows = state.heldRows.concat(first);
        await engine.poll();

        assert.strictEqual(first.seq, 2);
        assert.strictEqual(first.added, '[]');
        assert.strictEqual(first.removed, '[]');
        assert.strictEqual(first.meta_hash, read.meta_hash);
        assert.strictEqual(engine.listConsensus.propose.callCount, 1);
    });

    it('refuses a forged follower name even when the signed hash is empty', async function () {
        sinon.stub(ah, 'isAdmissionEra').returns(true);
        const row = proposedRow({ name: null, description: null, meta_hash: '' });
        const matching = followerContext({
            type: 2,
            members: MEMBERS,
            name: null,
            description: null,
            meta_hash: ''
        });
        const forged = followerContext({
            type: 2,
            members: MEMBERS,
            name: 'Forged',
            description: null,
            meta_hash: ''
        });

        assert.strictEqual(await validate.validateProposedMatch.call(matching, row), true);
        assert.strictEqual(await validate.validateProposedMatch.call(forged, row), false);
        assert.deepStrictEqual(forged.activation.listMeta.firstCall.args, [
            SNAPSHOT_BLOCK,
            'regtest',
            'BTC'
        ]);
    });
});
