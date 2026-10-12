'use strict';

const assert = require('assert');

const { listMembersHash } = require('../../../../../src/cross_chain/list/canonical.js');
const { ownReadVerdict } = require('../../../../../src/cross_chain/list/read_checks.js');

const members = ['a', 'b'];
const row = {
    home_list_index: 7,
    origin_block: 100,
    list_type: 2,
    members_hash: listMembersHash(members)
};

function verdict(changes = {}) {
    return ownReadVerdict(Object.assign({
        row,
        sharedLists: [{ root_index: 7, share_block: 100 }],
        homeTip: 106,
        confirmations: 6,
        read: { type: 2, members }
    }, changes));
}

describe('shared-list own-read verdict unavailable reads', function () {
    it('abstains without a shared-list answer', function () {
        assert.strictEqual(verdict({ sharedLists: null }), 'abstain');
    });

    it('abstains without valid home-chain heights', function () {
        assert.strictEqual(verdict({ homeTip: null }), 'abstain');
        assert.strictEqual(verdict({ homeTip: -1 }), 'abstain');
        assert.strictEqual(verdict({ homeTip: 1.5 }), 'abstain');
        assert.strictEqual(verdict({ homeTip: Number.MAX_SAFE_INTEGER + 1 }), 'abstain');
        assert.strictEqual(verdict({ confirmations: null }), 'abstain');
        assert.strictEqual(verdict({ confirmations: -1 }), 'abstain');
        assert.strictEqual(verdict({ confirmations: 1.5 }), 'abstain');
        assert.strictEqual(verdict({ confirmations: Number.MAX_SAFE_INTEGER + 1 }), 'abstain');
    });

    it('abstains on an absent or failed member read', function () {
        assert.strictEqual(verdict({ read: null }), 'abstain');
        assert.strictEqual(verdict({ read: { error: 'unavailable' } }), 'abstain');
        assert.strictEqual(verdict({ read: { error: null, type: 2, members } }), 'abstain');
        assert.strictEqual(verdict({ read: { type: 2 } }), 'abstain');
    });
});

describe('shared-list own-read verdict home-chain checks', function () {
    it('passes a share exactly at the origin block', function () {
        assert.strictEqual(verdict(), 'pass');
    });

    it('refuses a share after the origin block or for another list', function () {
        assert.strictEqual(verdict({
            sharedLists: [{ root_index: 7, share_block: 101 }]
        }), 'refuse');
        assert.strictEqual(verdict({
            sharedLists: [{ root_index: 8, share_block: 1 }]
        }), 'refuse');
    });

    it('passes at the exact confirmation depth and refuses below it', function () {
        assert.strictEqual(verdict({ homeTip: 106 }), 'pass');
        assert.strictEqual(verdict({ homeTip: 105 }), 'refuse');
    });
});

describe('shared-list own-read verdict membership checks', function () {
    it('refuses a list type different from the proposed row', function () {
        assert.strictEqual(verdict({ read: { type: 1, members } }), 'refuse');
    });

    it('checks the held list type when one is available', function () {
        assert.strictEqual(verdict({ heldListType: 1 }), 'refuse');
        assert.strictEqual(verdict({ heldListType: 2 }), 'pass');
    });

    it('refuses non-canonical membership', function () {
        assert.strictEqual(verdict({
            read: { type: 2, members: ['b', 'a'] }
        }), 'refuse');
    });

    it('refuses membership whose hash differs from the proposed row', function () {
        assert.strictEqual(verdict({
            read: { type: 2, members: ['a'] }
        }), 'refuse');
    });

    it('refuses more than 10,000 members', function () {
        const tooMany = Array.from(
            { length: 10001 },
            (_, index) => `m${String(index).padStart(5, '0')}`
        );
        assert.strictEqual(verdict({
            row: Object.assign({}, row, { members_hash: listMembersHash(tooMany) }),
            read: { type: 2, members: tooMany }
        }), 'refuse');
    });
});
