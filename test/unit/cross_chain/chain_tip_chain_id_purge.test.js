'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { buildFeedRpc } = require('../../../src/api/rpc/feed');
const crossChainDb = require('../../../src/db/cross_chain');
const capabilityDb = require('../../../src/db/capability_snapshots');

const OLD_ID = '01'.repeat(32);
const NEW_ID = '02'.repeat(32);

function makeDb(storedId = OLD_ID) {
    let order = [];
    return {
        order,
        getChainTip: sinon.stub().callsFake(async () => {
            order.push('get');
            return { chainId: storedId };
        }),
        deleteCrossChainMatchesByNetwork: sinon.stub().callsFake(async () => { order.push('matches'); }),
        deleteCrossChainCallsByNetwork: sinon.stub().callsFake(async () => { order.push('calls'); }),
        deleteAllCapabilitySnapshots: sinon.stub().callsFake(async () => { order.push('snapshots'); }),
        setChainTip: sinon.stub().callsFake(async () => { order.push('set'); })
    };
}

async function push(db, overrides = {}, hubOverrides = {}) {
    const params = {
        coin: 'BTC', network: 'regtest', block_height: 42,
        block_time: 1700000000, chain_id: NEW_ID,
        ...overrides
    };
    return buildFeedRpc({ hub: { db, network: 'regtest', ...hubOverrides } }).pushchaintip(params);
}

function registerScopedSqlTest() {
    it('uses scoped SQL for cross-chain rows and an unfiltered snapshot delete', async function () {
        const doQuery = sinon.stub().resolves();
        await crossChainDb.deleteCrossChainMatchesByNetwork.call({ doQuery }, 'regtest');
        await crossChainDb.deleteCrossChainCallsByNetwork.call({ doQuery }, 'regtest');
        await capabilityDb.deleteAllCapabilitySnapshots.call({ doQuery });

        expect(doQuery.getCall(0).args).to.deep.equal([
            'DELETE FROM cross_chain_matches WHERE network = ?', ['regtest']
        ]);
        expect(doQuery.getCall(1).args).to.deep.equal([
            'DELETE FROM cross_chain_calls WHERE network = ?', ['regtest']
        ]);
        expect(doQuery.getCall(2).args).to.deep.equal(['DELETE FROM capability_snapshots']);
    });
}

function registerPurgeAndFailureTests() {
    it('purges all three tables before replacing a changed BTC regtest tip', async function () {
        const db = makeDb();
        expect(await push(db)).to.deep.equal({ status: 'success' });
        expect(db.order).to.deep.equal(['get', 'matches', 'calls', 'snapshots', 'set']);
        expect(db.deleteCrossChainMatchesByNetwork.calledWithExactly('regtest')).to.equal(true);
        expect(db.deleteCrossChainCallsByNetwork.calledWithExactly('regtest')).to.equal(true);
        expect(db.deleteAllCapabilitySnapshots.calledOnceWithExactly()).to.equal(true);
    });

    for (const failedMethod of [
        'getChainTip',
        'deleteCrossChainMatchesByNetwork',
        'deleteCrossChainCallsByNetwork',
        'deleteAllCapabilitySnapshots'
    ]) {
        it('does not update the tip when ' + failedMethod + ' fails', async function () {
            const db = makeDb();
            db[failedMethod].rejects(new Error(failedMethod + ' failed'));
            const result = await push(db);
            expect(result).to.deep.equal({ error: failedMethod + ' failed' });
            expect(db.setChainTip.called).to.equal(false);
        });
    }
}

function registerNoOpTests() {
    const noOps = [
        ['no stored identity', null, {}],
        ['an unchanged identity', NEW_ID, {}],
        ['a non-BTC tip', OLD_ID, { coin: 'DOGE' }],
        ['a non-regtest tip', OLD_ID, { network: 'mainnet' }]
    ];
    for (const [label, storedId, overrides] of noOps) {
        it('does not purge for ' + label, async function () {
            const db = makeDb(storedId);
            expect(await push(db, overrides)).to.deep.equal({ status: 'success' });
            expect(db.deleteCrossChainMatchesByNetwork.called).to.equal(false);
            expect(db.deleteCrossChainCallsByNetwork.called).to.equal(false);
            expect(db.deleteAllCapabilitySnapshots.called).to.equal(false);
            expect(db.setChainTip.calledOnce).to.equal(true);
        });
    }
}

// The purge must gate on THIS hub's own configured network, never the caller's
// param alone: a caller (an indexer relaying a pushed tip) claiming network:
// 'regtest' twice with different chain_ids is not evidence of a regtest
// re-genesis when the hub answering the call is a testnet or mainnet hub.
function registerHubNetworkGuardTests() {
    for (const hubNetwork of ['testnet', 'mainnet']) {
        it('does not purge when the caller sends regtest but the hub is ' + hubNetwork, async function () {
            const db = makeDb(OLD_ID);
            expect(await push(db, {}, { network: hubNetwork })).to.deep.equal({ status: 'success' });
            expect(db.deleteCrossChainMatchesByNetwork.called).to.equal(false);
            expect(db.deleteCrossChainCallsByNetwork.called).to.equal(false);
            expect(db.deleteAllCapabilitySnapshots.called).to.equal(false);
            expect(db.setChainTip.calledOnce).to.equal(true);
        });
    }

    it('still purges for a regtest hub, unaffected by the added hub.network guard', async function () {
        const db = makeDb(OLD_ID);
        expect(await push(db, {}, { network: 'regtest' })).to.deep.equal({ status: 'success' });
        expect(db.order).to.deep.equal(['get', 'matches', 'calls', 'snapshots', 'set']);
    });
}

describe('regtest chain-tip identity purge', function () {
    registerScopedSqlTest();
    registerPurgeAndFailureTests();
    registerNoOpTests();
    registerHubNetworkGuardTests();
});
