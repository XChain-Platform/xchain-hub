'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// _resolveBtcIndexerUrl must not hand back an indexer that serves a
// different coin. Capability staking is BTC-only, so every consumer of this URL
// reads BTC-anchored state; on a DOGE-only venue the configs-table fallback
// resolved the DOGE indexer and the hub elected publishers off a set that did
// not exist and snapshotted checkpoints at a height where the stake was not
// active, silently. Only a POSITIVE identification of another
// coin fails closed: an unreachable or silent indexer stays on legacy behavior,
// because "cannot verify" is not evidence of a misconfiguration.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

describe('XChainHub BTC indexer coin guard', function () {

    let XChainHub, axiosStub, mockDb, hub, errorLog;

    const ENV_KEYS = ['BTC_INDEXER_API_URL', 'BTC_INDEXER_URL', 'INDEXER_COIN_CHECK'];
    let savedEnv;

    before(function () {
        this.timeout(30000);
        axiosStub = { post: sinon.stub() };
        XChainHub = proxyquire('../../src/XChainHub', {
            'axios': axiosStub,
            './db': function () { return mockDb; }
        });
    });

    beforeEach(function () {
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        axiosStub.post.reset();
        axiosStub.post.resolves({ data: { result: {} } });
        mockDb = { getAllConfigs: sinon.stub().resolves({}) };
        hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
        hub.db = mockDb;
        errorLog = sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    // The indexer's getblockhashes response names the chain it answers for.
    function coinReply(coin) {
        return { data: { result: { coin: coin, network: 'regtest', block_index: 218 } } };
    }

    it('returns the URL when the indexer confirms it serves BTC', async function () {
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3514';
        axiosStub.post.resolves(coinReply('BTC'));
        expect(await hub._resolveBtcIndexerUrl()).to.equal('http://127.0.0.1:3514');
        expect(errorLog.called).to.equal(false);
    });

    it('fails closed and loud when the resolved indexer serves another coin', async function () {
        // The drill shape: a DOGE-only venue, the configs table hands back the
        // DOGE indexer, and nothing in the old code noticed.
        mockDb.getAllConfigs.resolves({
            dogecoin: { regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3524 } } },
            bitcoin:  { regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3524 } } }
        });
        axiosStub.post.resolves(coinReply('DOGE'));
        expect(await hub._resolveBtcIndexerUrl()).to.equal(null);
        expect(errorLog.calledOnce).to.equal(true);
        let msg = String(errorLog.firstCall.args.join(' '));
        expect(msg).to.contain('DOGE');
        expect(msg).to.contain('BTC_INDEXER_API_URL');
    });

    it('an explicit env override is verified too (a wrong URL is still wrong)', async function () {
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3524';
        axiosStub.post.resolves(coinReply('LTC'));
        expect(await hub._resolveBtcIndexerUrl()).to.equal(null);
    });

    it('an unreachable indexer is unverifiable, not a mismatch', async function () {
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3514';
        axiosStub.post.rejects(new Error('ECONNREFUSED'));
        expect(await hub._resolveBtcIndexerUrl()).to.equal('http://127.0.0.1:3514');
        expect(errorLog.called).to.equal(false);
    });

    it('an indexer that reports no coin (not ready, or auth-gated) is not blocked', async function () {
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3514';
        axiosStub.post.resolves({ data: { result: { error: 'indexer database not ready' } } });
        expect(await hub._resolveBtcIndexerUrl()).to.equal('http://127.0.0.1:3514');
    });

    it('caches the confirmation so the probe costs one round trip, not one per call', async function () {
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3514';
        axiosStub.post.resolves(coinReply('btc'));                 // case-insensitive
        await hub._resolveBtcIndexerUrl();
        await hub._resolveBtcIndexerUrl();
        await hub._resolveBtcIndexerUrl();
        expect(axiosStub.post.callCount).to.equal(1);
    });

    it('re-probes a different URL rather than reusing the previous verdict', async function () {
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3514';
        axiosStub.post.resolves(coinReply('BTC'));
        expect(await hub._resolveBtcIndexerUrl()).to.equal('http://127.0.0.1:3514');
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3524';
        axiosStub.post.resolves(coinReply('DOGE'));
        expect(await hub._resolveBtcIndexerUrl()).to.equal(null);
        expect(axiosStub.post.callCount).to.equal(2);
    });

    it('INDEXER_COIN_CHECK=0 restores the unverified behavior', async function () {
        process.env.INDEXER_COIN_CHECK = '0';
        process.env.BTC_INDEXER_API_URL = 'http://127.0.0.1:3524';
        axiosStub.post.resolves(coinReply('DOGE'));
        expect(await hub._resolveBtcIndexerUrl()).to.equal('http://127.0.0.1:3524');
        expect(axiosStub.post.called).to.equal(false);
    });

    it('no configured URL still resolves to null without probing', async function () {
        expect(await hub._resolveBtcIndexerUrl()).to.equal(null);
        expect(axiosStub.post.called).to.equal(false);
    });

    it('the guard does not touch the generic per-coin resolver', async function () {
        // _resolveIndexerUrl('DOGE') must keep answering for DOGE: the guard is a
        // BTC-identity check, not a ban on other chains' indexers.
        process.env.DOGE_INDEXER_API_URL = 'http://127.0.0.1:3524';
        try {
            expect(await hub._resolveIndexerUrl('DOGE')).to.equal('http://127.0.0.1:3524');
            expect(axiosStub.post.called).to.equal(false);
        } finally {
            delete process.env.DOGE_INDEXER_API_URL;
        }
    });
});
