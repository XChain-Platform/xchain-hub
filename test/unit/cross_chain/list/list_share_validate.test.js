'use strict';

const assert = require('assert');
const sinon = require('sinon');

const ah = require('../../../../src/lib/admission_height.js');
const validate = require('../../../../src/cross_chain/list/validate.js');
const {
    deriveListSnapshotId,
    listMembersHash
} = require('../../../../src/cross_chain/list/canonical.js');

const INDEX = 7;
const SNAPSHOT_BLOCK = 500;
const ORIGIN_BLOCK = 100;
const FIRST_MEMBERS = ['a', 'b'];
const SECOND_MEMBERS = ['b', 'c'];

function proposedRow(changes = {}){
    const row = Object.assign({
        snapshot_block: SNAPSHOT_BLOCK,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: INDEX,
        list_type: 2,
        seq: 1,
        kind: 'full',
        added: JSON.stringify(FIRST_MEMBERS),
        removed: '[]',
        members_hash: listMembersHash(FIRST_MEMBERS),
        origin_block: ORIGIN_BLOCK
    }, changes);
    row.snapshot_id = changes.snapshot_id || deriveListSnapshotId(
        row.network,
        row.home_chain,
        row.home_list_index,
        row.seq,
        row.snapshot_block
    );
    return row;
}

function heldFull(){
    return proposedRow({
        snapshot_block: 490,
        origin_block: 90
    });
}

function context(options = {}){
    const held = options.held || [];
    const readMembers = options.readMembers || FIRST_MEMBERS;
    const indexerFailure = options.indexerFailure;
    return {
        network: options.network || 'regtest',
        activation: {
            producer: (_block, network, coin) => network === 'regtest' && coin === 'BTC'
        },
        confirmations: { BTC: 6, DOGE: 6, LTC: 6 },
        resolveSnapshotBlock: async () => SNAPSHOT_BLOCK,
        db: {
            async getListSnapshotAtSeq(_network, _chain, _index, seq){
                return held.find(row => Number(row.seq) === Number(seq)) || null;
            },
            async getLatestListSeq(){
                return held.reduce((latest, row) => Math.max(latest, Number(row.seq)), 0);
            },
            async findListSnapshotChain(_network, _chain, _index, uptoSeq){
                return held.filter(row => Number(row.seq) <= Number(uptoSeq));
            }
        },
        async indexerCall(_chain, method, params){
            if(method === indexerFailure) throw new Error('indexer unavailable');
            if(method === 'getsharedlists')
                return options.sharedLists === undefined ?
                    [{ root_index: INDEX, share_block: 80 }] : options.sharedLists;
            if(method === 'getlatestblock')
                return { block_index: options.homeTip === undefined ? 106 : options.homeTip };
            if(method === 'getlistat'){
                assert.deepStrictEqual(params, { list_index: INDEX, block: ORIGIN_BLOCK });
                return options.read || { type: 2, members: readMembers };
            }
            throw new Error('unexpected method ' + method);
        }
    };
}

async function validates(row, options){
    return validate.validateProposedMatch.call(context(options), row);
}

describe('shared-list follower validation', function () {
    beforeEach(function () {
        sinon.stub(ah, 'isAdmissionEra').returns(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('co-signs a correct full version on regtest', async function () {
        assert.strictEqual(await validates(proposedRow()), true);
    });

    it('co-signs a correct delta on regtest', async function () {
        const first = heldFull();
        const delta = proposedRow({
            seq: 2,
            kind: 'delta',
            added: JSON.stringify(['c']),
            removed: JSON.stringify(['a']),
            members_hash: listMembersHash(SECOND_MEMBERS)
        });
        assert.strictEqual(await validates(delta, {
            held: [first],
            readMembers: SECOND_MEMBERS
        }), true);
    });

    it('co-signs an identical held row retried by final sync', async function () {
        const row = proposedRow();
        assert.strictEqual(await validates(row, { held: [row] }), true);
    });

    it('abstains on an own-indexer read failure', async function () {
        assert.strictEqual(await validates(proposedRow(), {
            indexerFailure: 'getlistat'
        }), false);
    });

    it('abstains when it does not hold the preceding sequence', async function () {
        const delta = proposedRow({
            seq: 2,
            kind: 'delta',
            added: JSON.stringify(['c']),
            removed: JSON.stringify(['a']),
            members_hash: listMembersHash(SECOND_MEMBERS)
        });
        assert.strictEqual(await validates(delta, { readMembers: SECOND_MEMBERS }), false);
    });

    it('refuses a second content at a held sequence', async function () {
        const row = proposedRow();
        const other = Object.assign({}, row, { members_hash: 'f'.repeat(64) });
        assert.strictEqual(await validates(row, { held: [other] }), false);
    });

    it('refuses a list absent from its own shared-list answer', async function () {
        assert.strictEqual(await validates(proposedRow(), { sharedLists: [] }), false);
    });

    it('refuses a shallow origin block', async function () {
        assert.strictEqual(await validates(proposedRow(), { homeTip: 105 }), false);
    });

    it('refuses a wrong delta', async function () {
        const delta = proposedRow({
            seq: 2,
            kind: 'delta',
            added: JSON.stringify(['d']),
            removed: JSON.stringify(['a']),
            members_hash: listMembersHash(SECOND_MEMBERS)
        });
        assert.strictEqual(await validates(delta, {
            held: [heldFull()],
            readMembers: SECOND_MEMBERS
        }), false);
    });

    it('refuses a membership hash mismatch', async function () {
        assert.strictEqual(await validates(proposedRow({
            members_hash: 'f'.repeat(64)
        })), false);
    });

    it('refuses full kind at sequence two', async function () {
        assert.strictEqual(await validates(proposedRow({ seq: 2 })), false);
    });

    it('refuses a non-canonical sequence spelling', async function () {
        assert.strictEqual(await validates(proposedRow({ seq: '041', kind: 'delta' })), false);
    });

    it('refuses testnet while the producer gate is unarmed', async function () {
        const row = proposedRow({ network: 'testnet' });
        assert.strictEqual(await validate.validateProposedMatch.call(context({
            network: 'testnet'
        }), row), false);
    });

    it('refuses an unbounded or wrongly derived snapshot', async function () {
        const unavailable = context();
        unavailable.resolveSnapshotBlock = async () => null;
        assert.strictEqual(await validate.validateProposedMatch.call(
            unavailable, proposedRow({ snapshot_block: 0 })
        ), false);
        assert.strictEqual(await validates(proposedRow({ snapshot_id: '0'.repeat(64) })), false);
    });
});
