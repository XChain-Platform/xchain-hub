'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// A BTC tip that cannot be resolved reaches the consensus-input monitor, so /health
// alarms on a BTC indexer outage instead of reading healthy until oracle staleness.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { ConsensusInputMonitor } = require('../../../src/validators/consensus_input_monitor.js');

let XChainHub, axiosStub, mockDb, monitor;

function hubWith(url) {
    const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'mainnet' });
    hub.db = mockDb;
    hub.resolveBtcNetwork    = async () => 'mainnet';
    hub.resolveBtcIndexerUrl = async () => url;
    hub.capabilitySnapshot   = { monitor };
    return hub;
}

// The stubs every case shares: a proxied XChainHub over a stubbed axios and db, a fresh
// monitor, and silenced console output.
function registerStubHooks() {
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
        monitor = new ConsensusInputMonitor({ log: () => {} });
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
        sinon.stub(console, 'log');
    });

    afterEach(function () { sinon.restore(); });
}

describe('chain tips: BTC tip failures reach the consensus-input monitor', function () {
    registerStubHooks();

    it('counts an unreachable indexer and alerts after repeated nulls', async function () {
        const hub = hubWith('http://idx');
        axiosStub.post.rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        for (let i = 0; i < 3; i++) expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        const snap = monitor.snapshot();
        expect(snap.failures).to.be.at.least(3);
        expect(snap.by_reason.unreachable).to.be.at.least(3);
        expect(snap.alerting).to.equal(true);
    });

    it('counts a missing indexer URL as no_indexer_url', async function () {
        const hub = hubWith(null);
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        expect(monitor.snapshot().by_reason.no_indexer_url).to.equal(1);
    });

    it('counts a response with no result as rpc_error', async function () {
        const hub = hubWith('http://idx');
        axiosStub.post.resolves({ data: {} });
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
        expect(monitor.snapshot().by_reason.rpc_error).to.equal(1);
    });

    it('leaves the monitor untouched on a good tip and on the pushed-tip fast path', async function () {
        const hub = hubWith('http://idx');
        axiosStub.post.resolves({ data: { result: { block_index: 500, lag: 0 } } });
        expect(await hub.resolveBtcLatestBlock()).to.equal(500);
        expect(monitor.snapshot().failures).to.equal(0);
        mockDb.getChainTip.resolves({ blockHeight: 600, blockTime: Math.floor(Date.now() / 1000) });
        axiosStub.post.reset();
        expect(await hub.resolveBtcLatestBlock()).to.equal(600);
        expect(axiosStub.post.called).to.equal(false);
        expect(monitor.snapshot().failures).to.equal(0);
    });

    it('tolerates a hub with no capability snapshot', async function () {
        const hub = hubWith('http://idx');
        hub.capabilitySnapshot = null;
        axiosStub.post.rejects(new Error('boom'));
        expect(await hub.resolveBtcLatestBlock()).to.equal(null);
    });
});
