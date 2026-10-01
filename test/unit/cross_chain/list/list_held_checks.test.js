'use strict';

const assert = require('assert');

const { heldRowVerdict } = require('../../../../src/cross_chain/list/held_checks.js');

function row(changes = {}) {
    return Object.assign({
        seq: 2,
        snapshot_id: 'snapshot',
        members_hash: 'members',
        origin_block: 20
    }, changes);
}

function verdict(changes = {}) {
    return heldRowVerdict(Object.assign({
        row: row(),
        heldAtSeq: null,
        latestHeldSeq: 1,
        prevOriginBlock: 10
    }, changes));
}

describe('shared-list held-row verdict existing sequence', function () {
    it('passes an identical held row', function () {
        assert.strictEqual(verdict({
            heldAtSeq: { snapshot_id: 'snapshot', members_hash: 'members' }
        }), 'pass');
    });

    it('refuses another snapshot or membership at a held sequence', function () {
        assert.strictEqual(verdict({
            heldAtSeq: { snapshot_id: 'other', members_hash: 'members' }
        }), 'refuse');
        assert.strictEqual(verdict({
            heldAtSeq: { snapshot_id: 'snapshot', members_hash: 'other' }
        }), 'refuse');
    });

    it('refuses a missing held row at or below the latest sequence', function () {
        assert.strictEqual(verdict({ row: row({ seq: 1 }) }), 'refuse');
    });
});

describe('shared-list held-row verdict next sequence', function () {
    it('passes sequence one when nothing is held', function () {
        assert.strictEqual(verdict({
            row: row({ seq: 1 }),
            latestHeldSeq: 0,
            prevOriginBlock: null
        }), 'pass');
    });

    it('abstains when the preceding origin block is unknown', function () {
        assert.strictEqual(verdict({ prevOriginBlock: null }), 'abstain');
    });

    it('refuses non-increasing origin blocks and passes an increase', function () {
        assert.strictEqual(verdict({ row: row({ origin_block: 10 }) }), 'refuse');
        assert.strictEqual(verdict({ row: row({ origin_block: 9 }) }), 'refuse');
        assert.strictEqual(verdict({ row: row({ origin_block: 'unknown' }) }), 'refuse');
        assert.strictEqual(verdict({ row: row({ origin_block: 11 }) }), 'pass');
    });
});

describe('shared-list held-row verdict gaps and invalid sequences', function () {
    it('abstains when the preceding sequence is not held', function () {
        assert.strictEqual(verdict({
            row: row({ seq: 3 }),
            latestHeldSeq: 1
        }), 'abstain');
    });

    it('refuses sequences that are not positive integer numbers', function () {
        assert.strictEqual(verdict({ row: row({ seq: 0 }) }), 'refuse');
        assert.strictEqual(verdict({ row: row({ seq: '2.5' }) }), 'refuse');
    });
});
