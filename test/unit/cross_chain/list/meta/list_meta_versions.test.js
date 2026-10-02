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
const { planListVersion } = require('../../../../../src/cross_chain/list/version_plan.js');

const MEMBERS = ['a', 'b'];
const MEMBERS_HASH = listMembersHash(MEMBERS);
const SNAPSHOT_BLOCK = 500;
const ORIGIN_BLOCK = 100;

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

function held(metaHash) {
    return {
        lastSeq: 1,
        latest: {
            list_type: 2,
            members_hash: MEMBERS_HASH,
            meta_hash: metaHash,
            origin_block: 90
        },
        fold: () => MEMBERS
    };
}

function plan(read, heldState, originBlock = ORIGIN_BLOCK) {
    return planListVersion({
        read,
        originBlock,
        held: heldState,
        metaActive: true
    });
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

    it('installs the metadata gate reader on the production polling path', async function () {
        const hub = {
            db: {},
            network: 'regtest',
            p2pConfig: {},
            getPeerManager: () => null,
            getIdentity: () => null,
            resolveBtcLatestBlock: async () => SNAPSHOT_BLOCK
        };
        const engine = new ListShareEngine(hub);
        sinon.stub(ah, 'isAdmissionEra').returns(true);

        await engine.poll();

        assert.strictEqual(typeof engine.activation.listMeta, 'function');
        assert.strictEqual(
            engine.activation.listMeta(SNAPSHOT_BLOCK, 'regtest', 'BTC'),
            true
        );
    });

    it('plans a rename-only version with the full metadata', function () {
        const read = listRead('New name', 'New description');
        const result = plan(read, held(listMetaHash('Old name', 'Old description')));

        assert.deepStrictEqual(result.version, {
            list_type: 2,
            seq: 2,
            kind: 'delta',
            added: [],
            removed: [],
            members_hash: MEMBERS_HASH,
            origin_block: ORIGIN_BLOCK,
            name: 'New name',
            description: 'New description',
            meta_hash: read.meta_hash
        });
    });

    it('makes no version when membership and metadata are unchanged at the gate', function () {
        const read = listRead('Current name', null);

        assert.deepStrictEqual(plan(read, held(read.meta_hash)), { unchanged: true });
    });

    it('makes exactly one version for a list named before the gate', function () {
        const read = listRead('Existing name', null);
        const first = plan(read, held(null));
        const afterFirst = held(first.version.meta_hash);
        afterFirst.lastSeq = first.version.seq;
        afterFirst.latest.origin_block = first.version.origin_block;

        assert.strictEqual(first.version.seq, 2);
        assert.deepStrictEqual(first.version.added, []);
        assert.deepStrictEqual(first.version.removed, []);
        assert.deepStrictEqual(plan(read, afterFirst, 110), { unchanged: true });
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
