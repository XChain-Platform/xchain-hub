'use strict';

const assert = require('assert');

const { listMembersHash } = require('../../../../src/cross_chain/list/canonical.js');
const { listRowShapeOk } = require('../../../../src/cross_chain/list/row_checks.js');

const full = {
    snapshot_block: 500,
    home_list_index: 7,
    list_type: 2,
    seq: 1,
    origin_block: 400,
    network: 'regtest',
    home_chain: 'DOGE',
    kind: 'full',
    members_hash: listMembersHash(['a']),
    added: JSON.stringify(['a']),
    removed: JSON.stringify([])
};

function withChanges(changes) {
    return Object.assign({}, full, changes);
}

describe('shared-list row meta hash shape', function () {
    it('accepts an absent, null, empty or lowercase hash', function () {
        assert.strictEqual(listRowShapeOk(full, 'regtest'), true);
        assert.strictEqual(listRowShapeOk(withChanges({ meta_hash: null }), 'regtest'), true);
        assert.strictEqual(listRowShapeOk(withChanges({ meta_hash: '' }), 'regtest'), true);
        assert.strictEqual(listRowShapeOk(withChanges({ meta_hash: 'a'.repeat(64) }), 'regtest'), true);
    });

    it('rejects an uppercase, short or non-string hash', function () {
        assert.strictEqual(listRowShapeOk(withChanges({ meta_hash: 'A'.repeat(64) }), 'regtest'), false);
        assert.strictEqual(listRowShapeOk(withChanges({ meta_hash: 'a'.repeat(63) }), 'regtest'), false);
        assert.strictEqual(listRowShapeOk(withChanges({ meta_hash: 7 }), 'regtest'), false);
    });
});
