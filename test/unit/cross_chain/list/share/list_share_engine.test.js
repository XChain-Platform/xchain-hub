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
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');

const ListShareEngine = require('../../../../../src/cross_chain/list_share_engine.js');
const registry = require('../../../../../src/consensus/gate_registry.js');
const ah = require('../../../../../src/lib/admission_height.js');

const docsDirs = [
    process.env.XCHAIN_DOCS_DIR,
    path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'xchain-documentation'),
    path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', '..', '..', 'xchain-documentation')
].filter(Boolean);
const vectorPath = docsDirs
    .map(dir => path.resolve(dir, 'protocol', 'test-vectors', 'list_share.json'))
    .find(candidate => fs.existsSync(candidate));
assert.ok(vectorPath, 'list_share.json was not found in ' + docsDirs.join(' or '));
const vectors = require(vectorPath);

function makeHub(network, snapshotBlock){
    return {
        db: {},
        network,
        p2pConfig: {},
        getPeerManager: () => null,
        getIdentity: () => null,
        async resolveBtcLatestBlock(){ return snapshotBlock; }
    };
}

function vectorRow(entry){
    return {
        snapshot_id: entry.snapshot_id,
        snapshot_block: entry.snapshot_block,
        home_chain: entry.home_chain,
        home_list_index: entry.home_list_index,
        list_type: entry.list_type,
        seq: entry.seq,
        kind: entry.kind,
        origin_block: entry.origin_block,
        members_hash: entry.members_hash,
        network: entry.network,
        admit_blocks: entry.admission
    };
}

function finalizedRow(snapshotId){
    return { snapshot_id: snapshotId, snapshot_block: 0, network: 'regtest' };
}

describe('shared-list engine producer gate', function () {
    afterEach(function () { sinon.restore(); });

    it('reads no shared-list indexer state and proposes nothing when testnet is unarmed', async function () {
        const engine = new ListShareEngine(makeHub('testnet', 50));
        let polls = 0;
        engine.pollSharedLists = async () => { polls++; };
        engine.indexers = new Proxy({}, { get(){ throw new Error('indexer read below gate'); } });

        await engine.poll();

        assert.strictEqual(polls, 0);
        assert.strictEqual(engine.listConsensus.pending.size, 0);
    });

    it('polls shared lists once with the BTC snapshot block when regtest is armed', async function () {
        const engine = new ListShareEngine(makeHub('regtest', 0));
        const blocks = [];
        engine.pollSharedLists = async block => { blocks.push(block); };
        sinon.stub(ah, 'isAdmissionEra').returns(true);

        await engine.poll();

        assert.deepStrictEqual(blocks, [0]);
    });

    it('does not poll or propose outside the admission era', async function () {
        const engine = new ListShareEngine(makeHub('regtest', 0));
        let polls = 0;
        engine.pollSharedLists = async () => { polls++; };
        sinon.stub(ah, 'isAdmissionEra').returns(false);

        await engine.poll();
        await engine.poll();

        assert.strictEqual(polls, 0);
        assert.strictEqual(engine.listConsensus.pending.size, 0);
        assert.strictEqual(engine._idleLogged.admission, true);
    });
});

describe('shared-list engine consensus contract', function () {
    it('uses the shared-list vector canonical exactly', function () {
        const engine = new ListShareEngine(makeHub('regtest', 0));
        const entry = vectors.canonicals[1];
        // The vector's testnet block 160000 sits above the v0.21.3 LIST_META height, so the
        // engine appends the (empty) metadata hash field to the legacy vector bytes.
        assert.strictEqual(engine.canonicalMatch(vectorRow(entry), entry.view), entry.expected + '|');
    });

    it('binds the dedicated PBFT channel and every-chain admission scope', function () {
        const engine = new ListShareEngine(makeHub('regtest', 0));
        assert.deepStrictEqual(engine.listConsensus.types, {
            PROPOSE: 'XLISTSHARE_SNAPSHOT_PROPOSE',
            PREPARE: 'XLISTSHARE_SNAPSHOT_PREPARE',
            COMMIT: 'XLISTSHARE_SNAPSHOT_COMMIT',
            VIEW_CHANGE: 'XLISTSHARE_SNAPSHOT_VIEW_CHANGE',
            NEW_VIEW: 'XLISTSHARE_SNAPSHOT_NEW_VIEW',
            FINAL_SYNC: 'XLISTSHARE_SNAPSHOT_FINAL_SYNC'
        });
        assert.deepStrictEqual(engine.admissionScope({}), {
            table: 'list_snapshots',
            readSet: ['BTC', 'DOGE', 'LTC']
        });
    });
});

describe('shared-list engine finalized writes', function () {
    it('defers and inserts nothing when capability persistence writes zero rows', async function () {
        const engine = new ListShareEngine(makeHub('regtest', 0));
        const inserted = [];
        const forgotten = [];
        engine.persistCapabilitySnapshot = async () => 0;
        engine.db.insertListSnapshot = async row => { inserted.push(row); return true; };
        engine.listConsensus.forgetFinalized = id => { forgotten.push(id); };
        engine._inflight.add('zero');

        await engine.writeFinalizedList({ row: finalizedRow('zero') });

        assert.deepStrictEqual(inserted, []);
        assert.deepStrictEqual(forgotten, ['zero']);
        assert.strictEqual(engine._inflight.has('zero'), false);
    });

    it('inserts once and broadcasts the committed row after a good finalize', async function () {
        const engine = new ListShareEngine(makeHub('regtest', 0));
        const inserted = [];
        const broadcasts = [];
        engine.persistCapabilitySnapshot = async () => 1;
        engine.resolveBtcChainId = async () => 'btc-chain';
        engine.db.insertListSnapshot = async row => { inserted.push(row); return true; };
        engine.db.getListSnapshotBySnapshotId = async id => [{ snapshot_id: id, stored: true }];
        engine.broadcaster = {
            subscribers: new Set(['mirror']),
            broadcastRow(message){ broadcasts.push(message); }
        };

        await engine.writeFinalizedList({
            row: finalizedRow('good'), signatures: ['sig'], view: 2
        });

        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(inserted[0].btc_chain_id, 'btc-chain');
        assert.strictEqual(inserted[0].validator_signatures, '["sig"]');
        assert.strictEqual(inserted[0].finalizing_view, 2);
        assert.deepStrictEqual(broadcasts, [{
            table: 'list_snapshots', row: { snapshot_id: 'good', stored: true }
        }]);
    });
});

describe('shared-list engine activation registry', function () {
    it('throws naming the producer key when its registry row is absent', function () {
        const key = ListShareEngine.PRODUCER_GATE_KEY;
        const original = registry.get;
        registry.get = function (candidate) {
            if(candidate === key) throw new registry.RegistryMissError(candidate);
            return original.call(registry, candidate);
        };
        try {
            assert.throws(() => new ListShareEngine(makeHub('regtest', 0)), error =>
                error instanceof registry.RegistryMissError && error.message.includes(key));
        } finally {
            registry.get = original;
        }
    });
});
