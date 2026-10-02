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

const ListShareEngine = require('../../../../../src/cross_chain/list_share_engine.js');
const {
    listMembersHash,
    listMetaHash
} = require('../../../../../src/cross_chain/list/canonical.js');

const ROOT_INDEX = 7;
const SNAPSHOT_BLOCK = 500;
const ORIGIN_BLOCK = 114;
const MEMBERS = ['custodian'];
const DESCRIPTION = 'Trusted rail operators';

function readWithName(name) {
    return {
        type: 2,
        members: MEMBERS,
        hash: listMembersHash(MEMBERS),
        name,
        description: DESCRIPTION,
        meta_hash: listMetaHash(name, DESCRIPTION)
    };
}

function makeEngine(initialRead) {
    let read = initialRead;
    const db = {
        getLatestListSeq: sinon.stub().resolves(1),
        findListSnapshotChain: sinon.stub().resolves([{
            seq: 1,
            kind: 'full',
            list_type: 2,
            added: JSON.stringify(MEMBERS),
            removed: '[]',
            members_hash: initialRead.hash,
            name: initialRead.name,
            description: initialRead.description,
            meta_hash: initialRead.meta_hash,
            origin_block: 100
        }])
    };
    const hub = {
        db,
        network: 'regtest',
        p2pConfig: {},
        getPeerManager: () => null,
        getIdentity: () => null,
        resolveAdmitBlocks: sinon.stub().resolves({ BTC: 510, DOGE: 511, LTC: 512 })
    };
    const engine = new ListShareEngine(hub);
    engine.activation.listMeta = sinon.stub().returns(true);
    engine.indexerCall = sinon.stub().callsFake(async () => read);
    sinon.stub(engine, 'resolveCapabilityValidators').resolves([]);
    sinon.stub(engine.listConsensus, 'propose').resolves();

    return {
        engine,
        setRead(nextRead) { read = nextRead; }
    };
}

describe('shared-list leader poll held metadata', function () {
    afterEach(function () { sinon.restore(); });

    it('skips unchanged metadata and proposes one rename with its new hash', async function () {
        const original = readWithName('Rail custodians');
        const renamed = readWithName('Network custodians');
        const { engine, setRead } = makeEngine(original);

        await engine.maybeSnapshotList('DOGE', ROOT_INDEX, ORIGIN_BLOCK, SNAPSHOT_BLOCK);
        assert.strictEqual(engine.listConsensus.propose.callCount, 0);

        setRead(renamed);
        await engine.maybeSnapshotList('DOGE', ROOT_INDEX, ORIGIN_BLOCK, SNAPSHOT_BLOCK);

        assert.strictEqual(engine.listConsensus.propose.callCount, 1);
        const row = engine.listConsensus.propose.firstCall.args[1].row;
        assert.strictEqual(row.seq, 2);
        assert.strictEqual(row.kind, 'delta');
        assert.strictEqual(row.added, '[]');
        assert.strictEqual(row.removed, '[]');
        assert.strictEqual(row.name, renamed.name);
        assert.strictEqual(row.description, renamed.description);
        assert.strictEqual(row.meta_hash, renamed.meta_hash);
    });
});
