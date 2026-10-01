'use strict';

const assert = require('assert');

const { listMembersHash } = require('../../../../src/cross_chain/list/canonical.js');
const { listRowShapeOk, listTransportOk } = require('../../../../src/cross_chain/list/row_checks.js');

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

describe('shared-list row checks accepted rows', function () {
    it('accepts a valid full row and its transport', function () {
        assert.strictEqual(listRowShapeOk(full, 'regtest'), true);
        assert.strictEqual(listTransportOk(full, ['a'], null), true);
    });

    it('accepts a valid delta row and its transport', function () {
        const delta = withChanges({
            seq: 2,
            kind: 'delta',
            added: JSON.stringify(['c']),
            removed: JSON.stringify(['a'])
        });

        assert.strictEqual(listRowShapeOk(delta, 'regtest'), true);
        assert.strictEqual(listTransportOk(delta, ['b', 'c'], ['a', 'b']), true);
    });
});

describe('shared-list row checks rejected rows', function () {
    it('rejects invalid row shapes', function () {
        assert.strictEqual(listRowShapeOk(withChanges({ seq: '041', kind: 'delta' }), 'regtest'), false);
        assert.strictEqual(listRowShapeOk(withChanges({ seq: 2 }), 'regtest'), false);
        assert.strictEqual(listRowShapeOk(full, 'testnet'), false);
        assert.strictEqual(listRowShapeOk(withChanges({ home_chain: 'ETH' }), 'regtest'), false);
        assert.strictEqual(listRowShapeOk(withChanges({ list_type: 3 }), 'regtest'), false);
        assert.strictEqual(listRowShapeOk(withChanges({
            members_hash: full.members_hash.toUpperCase()
        }), 'regtest'), false);
    });

    it('rejects invalid transports without throwing on broken JSON', function () {
        const delta = withChanges({
            seq: 2,
            kind: 'delta',
            added: JSON.stringify(['c']),
            removed: JSON.stringify(['a'])
        });

        assert.strictEqual(listTransportOk(delta, ['b', 'c', 'e'], ['a', 'b']), false);
        assert.strictEqual(listTransportOk(withChanges({
            added: JSON.stringify(['b', 'a'])
        }), ['a', 'b'], null), false);
        assert.doesNotThrow(() => listTransportOk(withChanges({ added: '[' }), ['a'], null));
        assert.strictEqual(listTransportOk(withChanges({ added: '[' }), ['a'], null), false);
    });
});
