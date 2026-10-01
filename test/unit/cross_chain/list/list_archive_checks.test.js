'use strict';

const assert = require('assert');

const { archivedListRowRefusal } = require('../../../../src/cross_chain/list/archive_checks.js');
const { listMembersHash } = require('../../../../src/cross_chain/list/canonical.js');

const full = {
    seq: 1,
    kind: 'full',
    added: JSON.stringify(['a', 'b']),
    removed: JSON.stringify([]),
    members_hash: listMembersHash(['a', 'b'])
};

function withChanges(row, changes) {
    return Object.assign({}, row, changes);
}

describe('archived list row self checks accepted rows', function () {
    it('accepts a full row with encoded or already parsed arrays', function () {
        assert.strictEqual(archivedListRowRefusal(full), null);
        assert.strictEqual(archivedListRowRefusal(withChanges(full, {
            added: ['a', 'b'],
            removed: []
        })), null);
    });

    it('accepts a delta row without checking its members hash', function () {
        const delta = withChanges(full, {
            seq: '2',
            kind: 'delta',
            added: JSON.stringify(['c']),
            removed: JSON.stringify(['a']),
            members_hash: 'not-checked-for-a-delta'
        });

        assert.strictEqual(archivedListRowRefusal(delta), null);
    });
});

describe('archived list row self checks refused rows', function () {
    it('refuses non-canonical sequence values', function () {
        for (const seq of [0, -1, 1.5, '0', '02', '2.0', '', Number.MAX_SAFE_INTEGER + 1,
            String(Number.MAX_SAFE_INTEGER + 1)]) {
            assert.strictEqual(
                archivedListRowRefusal(withChanges(full, { seq })),
                'seq is not a canonical positive integer'
            );
        }
    });

    it('refuses a kind that disagrees with the sequence', function () {
        assert.strictEqual(
            archivedListRowRefusal(withChanges(full, { kind: 'delta' })),
            'kind disagrees with seq'
        );
        assert.strictEqual(
            archivedListRowRefusal(withChanges(full, { seq: 2 })),
            'kind disagrees with seq'
        );
    });

    it('refuses invalid or non-canonical added arrays', function () {
        for (const added of ['nope', '{}', JSON.stringify(['b', 'a']), ['a', 'a'], [1]]) {
            assert.strictEqual(
                archivedListRowRefusal(withChanges(full, { added })),
                'added is not a canonical JSON array'
            );
        }
    });

    it('refuses invalid or non-canonical removed arrays', function () {
        for (const removed of ['nope', '{}', JSON.stringify(['b', 'a']), ['a', 'a'], [1]]) {
            assert.strictEqual(
                archivedListRowRefusal(withChanges(full, { removed })),
                'removed is not a canonical JSON array'
            );
        }
    });

    it('refuses a full row whose members hash does not match added', function () {
        assert.strictEqual(
            archivedListRowRefusal(withChanges(full, { members_hash: '0'.repeat(64) })),
            'full row members hash mismatch'
        );
    });

    it('returns the first failing reason', function () {
        assert.strictEqual(
            archivedListRowRefusal(withChanges(full, {
                seq: '02',
                kind: 'delta',
                added: 'nope',
                removed: 'nope',
                members_hash: 'wrong'
            })),
            'seq is not a canonical positive integer'
        );
        assert.strictEqual(
            archivedListRowRefusal(withChanges(full, {
                kind: 'delta',
                added: 'nope',
                removed: 'nope',
                members_hash: 'wrong'
            })),
            'kind disagrees with seq'
        );
    });
});
