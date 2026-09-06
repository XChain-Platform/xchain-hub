'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// _resolveBtcLatestBlock has two paths and only the first one is age-gated.
// When _btcPushedTipFresh rejects a frozen pushed tip, the direct getlatestblock
// path re-serves the same frozen height, so a halted BTC stack still anchors
// rounds. `lag` cannot catch it: a halted bitcoind freezes the decoder and the
// committed tip together, so lag reads 0 on a dead chain.
//
// The gate that closes it must not fire on a healthy chain. Bitcoin block gaps
// are exponential with a 600s mean, so a 1200s bound rejects a live mainnet tip
// about 13.5% of the time, and refusing any height that fails to BEAT the
// rejected pushed tip breaks the same way (a slow block leaves both heights
// equal). The cases below pin both the defect and those two liveness traps.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

describe('XChainHub direct-tip staleness gate', function () {

    let XChainHub, axiosStub, mockDb, warnLog, errorLog;

    const ENV_KEYS = ['MAX_TIP_AGE_S', 'MAX_DIRECT_TIP_AGE_S', 'MAX_INDEXER_LAG_BLOCKS',
                      'INDEXER_COIN_CHECK'];
    let savedEnv;

    const HEIGHT = 900000;

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
        mockDb = {
            getAllConfigs: sinon.stub().resolves({}),
            getChainTip:   sinon.stub().resolves(null)
        };
        warnLog  = sinon.stub(console, 'warn');
        errorLog = sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    // Seconds-since-epoch for a tip that is `ageS` old right now.
    function tipAged(height, ageS) {
        return { blockHeight: height, blockTime: Math.floor(Date.now() / 1000) - ageS };
    }

    // A hub whose indexer URL resolves without a coin probe, so only the two tip
    // paths under test decide the answer.
    function hubWith(tip, directResult) {
        const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'mainnet' });
        hub.db = mockDb;
        mockDb.getChainTip.resolves(tip);
        hub._resolveBtcNetwork   = async () => 'mainnet';
        hub._resolveBtcIndexerUrl = async () => 'http://indexer.invalid/api';
        axiosStub.post.resolves({ data: { result: directResult } });
        return hub;
    }

    it('refuses a direct height that a halted stack has frozen past the terminal bound', async function () {
        // bitcoind stopped three hours ago: the pushed tip is frozen, and the direct
        // path re-serves the same height with lag 0 because the decoder froze too.
        const hub = hubWith(tipAged(HEIGHT, 10800), { block_index: HEIGHT, lag: 0 });
        expect(await hub._resolveBtcLatestBlock()).to.equal(null);
    });

    it('serves a direct height on a healthy chain whose newest block is merely slow', async function () {
        // 1500s past the pushed-tip bound is an ordinary mainnet gap, not a halt.
        const hub = hubWith(tipAged(HEIGHT, 1500), { block_index: HEIGHT, lag: 0 });
        expect(await hub._resolveBtcLatestBlock()).to.equal(HEIGHT);
    });

    it('serves a direct height that beats the pushed tip however old that tip is', async function () {
        // The push is broken, not the chain; this is the case the direct path exists for.
        const hub = hubWith(tipAged(HEIGHT, 86400), { block_index: HEIGHT + 50, lag: 0 });
        expect(await hub._resolveBtcLatestBlock()).to.equal(HEIGHT + 50);
    });

    it('serves a direct height when no pushed tip exists to date it against', async function () {
        // A stack with no pushChainTip leaves chain_tips empty, so there is no
        // block_time anywhere in the hub and nothing to gate on.
        const hub = hubWith(null, { block_index: HEIGHT, lag: 0 });
        expect(await hub._resolveBtcLatestBlock()).to.equal(HEIGHT);
    });

    it('serves a direct height when the pushed tip carries no block_time', async function () {
        const hub = hubWith({ blockHeight: HEIGHT, blockTime: 0 }, { block_index: HEIGHT, lag: 0 });
        expect(await hub._resolveBtcLatestBlock()).to.equal(HEIGHT);
    });

    it('takes the terminal bound from MAX_DIRECT_TIP_AGE_S, not from MAX_TIP_AGE_S', async function () {
        // Raising the pushed-tip bound must not raise the terminal one: they answer
        // different questions and a shared value is what makes the terminal gate unsafe.
        process.env.MAX_TIP_AGE_S        = '60';
        process.env.MAX_DIRECT_TIP_AGE_S = '3000';
        const hub = hubWith(tipAged(HEIGHT, 3600), { block_index: HEIGHT, lag: 0 });
        expect(await hub._resolveBtcLatestBlock()).to.equal(null);
    });

    it('honours a MAX_DIRECT_TIP_AGE_S wider than the default', async function () {
        process.env.MAX_DIRECT_TIP_AGE_S = '86400';
        const hub = hubWith(tipAged(HEIGHT, 10800), { block_index: HEIGHT, lag: 0 });
        expect(await hub._resolveBtcLatestBlock()).to.equal(HEIGHT);
    });
});
