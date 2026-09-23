'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The PRICE publish rotation's oracle_publish membership: the weight snapshot at and
// above the STAKE_WEIGHTED_QUORUM activation, the count snapshot below it, each key
// ranked once, and an empty set logged as loudly as an unresolved one.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);

let OraclePublisher;

function loadModule() {
    let fsMock = {
        mkdirSync: sinon.stub(), existsSync: sinon.stub().returns(true), writeFileSync: sinon.stub(),
        openSync: sinon.stub().returns(99), writeSync: sinon.stub(), fsyncSync: sinon.stub(),
        closeSync: sinon.stub(), readFileSync: sinon.stub().returns(''),
    };
    OraclePublisher = proxyquire('../../../../src/oracle/publisher', {
        fs: fsMock,
        '../peers/encoder_client': function () { return null; },
    });
}

function makeSnapshots(count, weight) {
    return {
        getSnapshot:       sinon.stub().resolves(count),
        getWeightSnapshot: sinon.stub().resolves(weight),
    };
}

function makePublisher(network, capSS) {
    return new OraclePublisher({
        network:            network,
        p2pConfig:          {},
        getIdentity:        sinon.stub().returns({ getPubkeyHex: sinon.stub().returns(A), sign: sinon.stub() }),
        capabilityRegistry: null,
        capabilitySnapshot: capSS,
        oracleConsensus:    null,
    });
}

function registerGateTests() {
    it('reads the count snapshot below the mainnet activation height', async function () {
        let capSS = makeSnapshots({ validators: [{ pubkey: A }] }, { validators: [{ pubkey: B }] });
        let keys = await makePublisher('mainnet', capSS).getActiveOraclePublishPubkeys(960999);
        expect(keys).to.deep.equal([A]);
        expect(capSS.getWeightSnapshot.called).to.equal(false);
    });

    it('reads the weight snapshot at the mainnet activation height', async function () {
        let capSS = makeSnapshots({ validators: [{ pubkey: A }] }, { validators: [{ pubkey: B }] });
        let keys = await makePublisher('mainnet', capSS).getActiveOraclePublishPubkeys(961000);
        expect(keys).to.deep.equal([B]);
        expect(capSS.getSnapshot.called).to.equal(false);
    });

    it('reads the weight snapshot at any height on testnet and regtest', async function () {
        for (const network of ['testnet', 'regtest']) {
            let capSS = makeSnapshots({ validators: [{ pubkey: A }] }, { validators: [{ pubkey: B }] });
            expect(await makePublisher(network, capSS).getActiveOraclePublishPubkeys(1), network).to.deep.equal([B]);
        }
    });

    it('keeps the count snapshot on an unscoped hub', async function () {
        let capSS = makeSnapshots({ validators: [{ pubkey: A }] }, { validators: [{ pubkey: B }] });
        expect(await makePublisher('', capSS).getActiveOraclePublishPubkeys(990000)).to.deep.equal([A]);
    });
}

function registerShapeTests() {
    it('ranks each key once when a weighted snapshot carries several sources for it', async function () {
        let rows = [{ pubkey: C, source: 's1' }, { pubkey: A.toUpperCase(), source: 's1' },
                    { pubkey: C, source: 's2' }, { pubkey: A, source: 's3' }];
        let pub = makePublisher('regtest', makeSnapshots(null, { validators: rows }));
        expect(await pub.getActiveOraclePublishPubkeys(5)).to.deep.equal([A, C]);
        expect(await pub.getMyRank(5)).to.equal(0);
        expect(await pub.getActiveOraclePublishCount(5)).to.equal(2);
    });

    it('logs an empty member set once per dark spell and fails closed', async function () {
        let warn = sinon.stub(console, 'warn');
        let capSS = makeSnapshots(null, { validators: [] });
        let pub = makePublisher('regtest', capSS);
        expect(await pub.getActiveOraclePublishPubkeys(5)).to.deep.equal([]);
        expect(await pub.getActiveOraclePublishPubkeys(5)).to.deep.equal([]);
        expect(warn.callCount).to.equal(1);
        expect(warn.firstCall.args.join(' ')).to.match(/empty member set/);
        capSS.getWeightSnapshot.resolves({ validators: [{ pubkey: B }] });
        expect(await pub.getActiveOraclePublishPubkeys(5)).to.deep.equal([B]);
        capSS.getWeightSnapshot.resolves({ validators: [] });
        await pub.getActiveOraclePublishPubkeys(5);
        expect(warn.callCount).to.equal(2);
    });

    it('still fails closed and logs on a null or throwing weight snapshot', async function () {
        let warn = sinon.stub(console, 'warn');
        let pub = makePublisher('regtest', makeSnapshots(null, null));
        expect(await pub.getActiveOraclePublishPubkeys(5)).to.deep.equal([]);
        let pub2 = makePublisher('regtest', { getWeightSnapshot: sinon.stub().rejects(new Error('indexer down')) });
        expect(await pub2.getActiveOraclePublishPubkeys(5)).to.deep.equal([]);
        expect(warn.callCount).to.equal(2);
    });
}

describe('OraclePublisher rotation membership', function () {
    beforeEach(loadModule);
    afterEach(function () { sinon.restore(); });

    describe('the stake-weighted quorum gate', registerGateTests);
    describe('the resolved set', registerShapeTests);
});
