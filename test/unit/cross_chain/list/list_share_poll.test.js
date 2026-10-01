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

const ListShareEngine = require('../../../../src/cross_chain/list_share_engine.js');
const { listMembersHash } = require('../../../../src/cross_chain/list/canonical.js');
const { deriveListSnapshotId } = require('../../../../src/cross_chain/list/chain.js');

const ROOT_INDEX = 7;
const SNAPSHOT_BLOCK = 500;
const ORIGIN_BLOCK = 114;
const ADMIT_BLOCKS = { BTC: 510, DOGE: 511, LTC: 512 };
const VALIDATORS = [{ pubkey: 'validator', source: '', weight: '1', amount: '1' }];

function listRead(members, type = 2) {
    return { type, members, hash: listMembersHash(members) };
}

function fullRow(members, overrides = {}) {
    return {
        seq: 1,
        kind: 'full',
        list_type: 2,
        added: JSON.stringify(members),
        removed: '[]',
        members_hash: listMembersHash(members),
        origin_block: 100,
        ...overrides
    };
}

function makeEngine(options = {}) {
    const sharedLists = options.sharedLists || [{ root_index: ROOT_INDEX, share_block: 100 }];
    const read = Object.prototype.hasOwnProperty.call(options, 'read')
        ? options.read : listRead(['a']);
    const heldRows = options.heldRows || [];
    const lastSeq = Object.prototype.hasOwnProperty.call(options, 'lastSeq')
        ? options.lastSeq : heldRows.length;
    const db = {
        getLatestListSeq: sinon.stub().callsFake(async (_network, _chain, rootIndex) => {
            if (options.latestErrorRoot === rootIndex) throw new Error('latest failed');
            return lastSeq;
        }),
        findListSnapshotChain: sinon.stub().resolves(heldRows)
    };
    const resolveAdmitBlocks = sinon.stub().resolves(
        Object.prototype.hasOwnProperty.call(options, 'admitBlocks')
            ? options.admitBlocks : ADMIT_BLOCKS
    );
    const hub = {
        db,
        network: 'regtest',
        p2pConfig: {},
        getPeerManager: () => null,
        getIdentity: () => null,
        resolveAdmitBlocks,
        async resolveBtcLatestBlock(){ return SNAPSHOT_BLOCK; }
    };
    const engine = new ListShareEngine(hub);
    engine.indexers = {
        BTC: { url: '' },
        LTC: { url: '' },
        DOGE: { url: 'http://doge.invalid' }
    };
    engine.confirmations.DOGE = 6;
    engine.indexerCall = sinon.stub().callsFake(async (_chain, method, params) => {
        if (method === 'getlatestblock') return { block_index: 120 };
        if (method === 'getsharedlists') {
            assert.deepStrictEqual(params, { network: 'regtest' });
            return sharedLists;
        }
        if (method === 'getlistat') {
            if (options.readThrows) throw new Error('read failed');
            return typeof read === 'function' ? read(params) : read;
        }
        throw new Error('unexpected method ' + method);
    });
    sinon.stub(engine, 'resolveCapabilityValidators').resolves(VALIDATORS);
    sinon.stub(engine.listConsensus, 'propose').resolves();
    return { engine, db, resolveAdmitBlocks };
}

function proposed(engine) {
    assert.strictEqual(engine.listConsensus.propose.callCount, 1);
    return engine.listConsensus.propose.firstCall.args;
}

describe('shared-list leader poll full and unchanged versions', function () {
    afterEach(function () { sinon.restore(); });

    it('proposes the first share as seq 1 full with every member', async function () {
        const members = ['a', 'b'];
        const { engine, resolveAdmitBlocks } = makeEngine({ read: listRead(members, 1) });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        const [snapshotId, payload] = proposed(engine);
        assert.strictEqual(snapshotId,
            deriveListSnapshotId('regtest', 'DOGE', ROOT_INDEX, 1, SNAPSHOT_BLOCK));
        assert.deepStrictEqual(payload.snapshot, { validators: VALIDATORS, count: 1 });
        assert.deepStrictEqual(payload.row, {
            snapshot_id: snapshotId,
            snapshot_block: SNAPSHOT_BLOCK,
            network: 'regtest',
            home_chain: 'DOGE',
            home_list_index: ROOT_INDEX,
            list_type: 1,
            seq: 1,
            kind: 'full',
            added: JSON.stringify(members),
            removed: '[]',
            members_hash: listMembersHash(members),
            origin_block: ORIGIN_BLOCK,
            admit_block_btc: 510,
            admit_block_doge: 511,
            admit_block_ltc: 512
        });
        assert.deepStrictEqual(resolveAdmitBlocks.firstCall.args,
            ['list_snapshots', ['BTC', 'DOGE', 'LTC']]);
    });

    it('proposes nothing when the confirmed membership is unchanged', async function () {
        const members = ['a', 'b'];
        const { engine } = makeEngine({
            read: listRead(members),
            heldRows: [fullRow(members)]
        });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        assert.strictEqual(engine.listConsensus.propose.callCount, 0);
    });
});

describe('shared-list leader poll delta versions', function () {
    afterEach(function () { sinon.restore(); });

    it('proposes seq 2 delta with canonical additions, removals, and admission columns', async function () {
        const previous = ['a', 'c'];
        const current = ['b', 'c', 'd'];
        const { engine } = makeEngine({
            read: listRead(current),
            heldRows: [fullRow(previous)]
        });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        const [, payload] = proposed(engine);
        assert.strictEqual(payload.row.seq, 2);
        assert.strictEqual(payload.row.kind, 'delta');
        assert.strictEqual(payload.row.added, JSON.stringify(['b', 'd']));
        assert.strictEqual(payload.row.removed, JSON.stringify(['a']));
        assert.strictEqual(payload.row.members_hash, listMembersHash(current));
        assert.strictEqual(payload.row.origin_block, ORIGIN_BLOCK);
        assert.deepStrictEqual([
            payload.row.admit_block_btc,
            payload.row.admit_block_doge,
            payload.row.admit_block_ltc
        ], [510, 511, 512]);
    });

    it('releases the inflight id when proposing throws', async function () {
        const { engine } = makeEngine();
        engine.listConsensus.propose.rejects(new Error('proposal failed'));
        const snapshotId = deriveListSnapshotId(
            'regtest', 'DOGE', ROOT_INDEX, 1, SNAPSHOT_BLOCK
        );

        await assert.rejects(
            engine.maybeSnapshotList('DOGE', ROOT_INDEX, ORIGIN_BLOCK, SNAPSHOT_BLOCK),
            /proposal failed/
        );

        assert.strictEqual(engine._inflight.has(snapshotId), false);
    });
});

describe('shared-list leader poll fold caching', function () {
    afterEach(function () { sinon.restore(); });

    it('reuses the helper cache for the same held sequence and hash', async function () {
        const held = fullRow(['a']);
        const { engine } = makeEngine({
            read: listRead(['b']),
            heldRows: [held]
        });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);
        held.added = JSON.stringify(['wrong']);
        await engine.pollSharedLists(SNAPSHOT_BLOCK + 1);

        assert.strictEqual(engine.listConsensus.propose.callCount, 2);
        assert.strictEqual(Object.hasOwn(engine, '_listFoldCache'), false);
    });

    it('does not share held-fold cache entries between engines', async function () {
        const members = ['a'];
        const first = makeEngine({
            read: listRead(['b']),
            heldRows: [fullRow(members)]
        }).engine;
        const second = makeEngine({
            read: listRead(['b']),
            heldRows: [fullRow(members, { added: JSON.stringify(['wrong']) })]
        }).engine;

        await first.pollSharedLists(SNAPSHOT_BLOCK);
        await second.pollSharedLists(SNAPSHOT_BLOCK);

        assert.strictEqual(first.listConsensus.propose.callCount, 1);
        assert.strictEqual(second.listConsensus.propose.callCount, 0);
        assert.strictEqual(Object.hasOwn(first, '_listFoldCache'), false);
        assert.strictEqual(Object.hasOwn(second, '_listFoldCache'), false);
    });
});

describe('shared-list leader poll read refusals', function () {
    afterEach(function () { sinon.restore(); });

    it('declines 10,001 members', async function () {
        const members = Array.from(
            { length: 10001 },
            (_unused, index) => 'm' + String(index).padStart(5, '0')
        );
        const { engine } = makeEngine({ read: listRead(members) });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        assert.strictEqual(engine.listConsensus.propose.callCount, 0);
    });

    it('proposes nothing for a mismatched hash or unsorted answer', async function () {
        const cases = [
            { type: 2, members: ['a'], hash: 'f'.repeat(64) },
            { type: 2, members: ['b', 'a'], hash: listMembersHash(['b', 'a']) }
        ];

        for (const read of cases) {
            const { engine } = makeEngine({ read });
            await engine.pollSharedLists(SNAPSHOT_BLOCK);
            assert.strictEqual(engine.listConsensus.propose.callCount, 0);
            sinon.restore();
        }
    });

    it('proposes nothing when the list read fails or returns an error answer', async function () {
        const throwing = makeEngine({ readThrows: true }).engine;
        await throwing.pollSharedLists(SNAPSHOT_BLOCK);
        assert.strictEqual(throwing.listConsensus.propose.callCount, 0);
        sinon.restore();

        const answered = makeEngine({ read: { error: 'list not found' } }).engine;
        await answered.pollSharedLists(SNAPSHOT_BLOCK);
        assert.strictEqual(answered.listConsensus.propose.callCount, 0);
    });
});

describe('shared-list leader poll round refusals', function () {
    afterEach(function () { sinon.restore(); });

    it('proposes nothing without a fresh admission tip', async function () {
        const { engine } = makeEngine({ admitBlocks: null });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        assert.strictEqual(engine.listConsensus.propose.callCount, 0);
    });

    it('skips a list shared above the confirmed origin block', async function () {
        const { engine } = makeEngine({
            sharedLists: [{ root_index: ROOT_INDEX, share_block: ORIGIN_BLOCK + 1 }]
        });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        assert.strictEqual(engine.listConsensus.propose.callCount, 0);
        assert.strictEqual(engine.indexerCall.calledWithMatch('DOGE', 'getlistat'), false);
    });

    it('proposes nothing when the held fold disagrees with its latest hash', async function () {
        const held = fullRow(['a'], {
            added: JSON.stringify(['wrong']),
            members_hash: listMembersHash(['a'])
        });
        const { engine } = makeEngine({
            read: listRead(['b']),
            heldRows: [held]
        });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        assert.strictEqual(engine.listConsensus.propose.callCount, 0);
    });

    it('continues with later due lists after one list throws', async function () {
        const { engine } = makeEngine({
            sharedLists: [
                { root_index: 1, share_block: 100 },
                { root_index: 2, share_block: 100 }
            ],
            latestErrorRoot: 1
        });

        await engine.pollSharedLists(SNAPSHOT_BLOCK);

        const [, payload] = proposed(engine);
        assert.strictEqual(payload.row.home_list_index, 2);
    });
});
