'use strict';

const assert = require('assert');

const { listMembersHash } = require('../../../../../src/cross_chain/list/canonical.js');
const { heldRowVerdict } = require('../../../../../src/cross_chain/list/held_checks.js');
const { ownReadVerdict } = require('../../../../../src/cross_chain/list/read_checks.js');

const members = ['a', 'b'];
const metaHash = 'a'.repeat(64);

function readVerdict({ rowChanges = {}, readChanges = {}, metaActive = false } = {}) {
    return ownReadVerdict({
        row: Object.assign({
            home_list_index: 7,
            origin_block: 100,
            list_type: 2,
            members_hash: listMembersHash(members)
        }, rowChanges),
        sharedLists: [{ root_index: 7, share_block: 100 }],
        homeTip: 106,
        confirmations: 6,
        read: Object.assign({ type: 2, members }, readChanges),
        metaActive
    });
}

function heldVerdict(rowHash, heldHash) {
    const row = {
        seq: 2,
        snapshot_id: 'snapshot',
        members_hash: 'members',
        origin_block: 20
    };
    const heldAtSeq = { snapshot_id: 'snapshot', members_hash: 'members' };
    if (rowHash !== undefined) row.meta_hash = rowHash;
    if (heldHash !== undefined) heldAtSeq.meta_hash = heldHash;
    return heldRowVerdict({ row, heldAtSeq, latestHeldSeq: 2, prevOriginBlock: 10 });
}

describe('shared-list follower below-gate metadata checks', function () {
    it('refuses below-gate metadata that would halt the indexer consumer', function () {
        assert.strictEqual(readVerdict({
            rowChanges: { name: null, description: null, meta_hash: '' },
            readChanges: { name: null, description: null, meta_hash: '' }
        }), 'refuse');
        assert.strictEqual(readVerdict({ rowChanges: { name: 'List name' } }), 'refuse');
        assert.strictEqual(readVerdict({
            rowChanges: { description: 'List description' }
        }), 'refuse');
    });

    it('keeps the legacy read verdict when the row has no metadata hash', function () {
        assert.strictEqual(readVerdict({
            readChanges: { name: 'anything', description: 'anything else' }
        }), 'pass');
        assert.strictEqual(readVerdict({
            rowChanges: { name: null, description: null, meta_hash: null }
        }), 'pass');
    });
});

describe('shared-list follower active metadata checks', function () {
    it('passes matching read metadata with absent and null fields equal', function () {
        assert.strictEqual(readVerdict({
            rowChanges: { name: 'List name', description: 'List description', meta_hash: metaHash },
            readChanges: { name: 'List name', description: 'List description', meta_hash: metaHash },
            metaActive: true
        }), 'pass');
        assert.strictEqual(readVerdict({
            rowChanges: { name: null, meta_hash: metaHash },
            readChanges: { description: null, meta_hash: metaHash },
            metaActive: true
        }), 'pass');
    });

    it('refuses a forged read name', function () {
        assert.strictEqual(readVerdict({
            rowChanges: { name: 'List name', description: 'List description', meta_hash: metaHash },
            readChanges: { name: 'Forged', description: 'List description', meta_hash: metaHash },
            metaActive: true
        }), 'refuse');
    });

    it('refuses a forged read description', function () {
        assert.strictEqual(readVerdict({
            rowChanges: { name: 'List name', description: 'List description', meta_hash: metaHash },
            readChanges: { name: 'List name', description: 'Forged', meta_hash: metaHash },
            metaActive: true
        }), 'refuse');
    });

    it('refuses a differing read metadata hash', function () {
        assert.strictEqual(readVerdict({
            rowChanges: { name: 'List name', description: 'List description', meta_hash: metaHash },
            readChanges: {
                name: 'List name',
                description: 'List description',
                meta_hash: 'b'.repeat(64)
            },
            metaActive: true
        }), 'refuse');
    });
});

describe('shared-list follower held metadata checks', function () {
    it('treats null, absent and empty held metadata hashes as equal', function () {
        assert.strictEqual(heldVerdict(null, undefined), 'pass');
        assert.strictEqual(heldVerdict('', null), 'pass');
    });

    it('refuses different metadata hashes at a held sequence', function () {
        assert.strictEqual(heldVerdict(metaHash, 'b'.repeat(64)), 'refuse');
    });
});
