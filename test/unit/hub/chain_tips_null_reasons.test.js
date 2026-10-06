'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Every null the tip resolvers return names its reason in a log line.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

let XChainHub, axiosStub, mockDb, warnLog;

function hubWith(url, post) {
    const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'mainnet' });
    hub.db = mockDb;
    hub.resolveBtcNetwork    = async () => 'mainnet';
    hub.resolveBtcIndexerUrl = async () => url;
    hub.resolveIndexerUrl    = async () => url;
    axiosStub.post.resolves(post);
    return hub;
}

function warned(fragment) {
    return warnLog.getCalls().some((c) => c.args.join(' ').includes(fragment));
}

function installFixtures() {
    before(function () {
        this.timeout(30000);
        axiosStub = { post: sinon.stub() };
        XChainHub = proxyquire('../../../src/XChainHub', {
            'axios': axiosStub,
            './db': function () { return mockDb; }
        });
    });

    beforeEach(function () {
        axiosStub.post.reset();
        mockDb = {
            getAllConfigs: sinon.stub().resolves({}),
            getChainTip:   sinon.stub().resolves(null)
        };
        warnLog = sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
        sinon.stub(console, 'log');
    });

    afterEach(function () { sinon.restore(); });
}

describe('chain tips null reasons: BTC latest block', function () {
    installFixtures();

    it('logs when no BTC indexer URL resolves', async function () {
        const hub = hubWith(null, { data: { result: { block_index: 1 } } });
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        expect(warned('no BTC indexer URL resolves')).to.equal(true);
        expect(axiosStub.post.called).to.equal(false);
    });

    it('logs when the BTC indexer returns no result', async function () {
        const hub = hubWith('http://indexer.invalid/api', { data: {} });
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        expect(warned('returned no result')).to.equal(true);
    });

    it('logs when the BTC indexer returns an error', async function () {
        const hub = hubWith('http://indexer.invalid/api', { data: { result: { error: 'boom' } } });
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        expect(warned('returned an error ("boom")')).to.equal(true);
    });

    it('logs when the BTC indexer returns no usable block_index', async function () {
        const hub = hubWith('http://indexer.invalid/api', { data: { result: { block_index: null } } });
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        expect(warned('no usable block_index')).to.equal(true);
    });

    it('logs when the BTC indexer lag exceeds the bound', async function () {
        const hub = hubWith('http://indexer.invalid/api', { data: { result: { block_index: 5, lag: 100000 } } });
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        expect(warned('exceeds MAX_INDEXER_LAG_BLOCKS')).to.equal(true);
    });

});

describe('chain tips null reasons: admission tip', function () {
    installFixtures();

    it('logs when an admission tip read returns no result', async function () {
        const hub = hubWith('http://indexer.invalid/api', { data: {} });
        expect(await hub.resolveAdmissionTip('BTC')).to.equal(null);
        expect(warned('returned no result')).to.equal(true);
    });

    it('logs when an admission tip read returns an error', async function () {
        const hub = hubWith('http://indexer.invalid/api', { data: { result: { error: 'boom' } } });
        expect(await hub.resolveAdmissionTip('BTC')).to.equal(null);
        expect(warned('returned an error ("boom")')).to.equal(true);
    });
});
