'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// resolveDogeLatestBlock serves a DOGE height or null, never 0, and the anchor
// publisher callers treat null as unresolved.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

let XChainHub, axiosStub;

function hubWith(url, post) {
    const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'mainnet' });
    hub.db = { getAllConfigs: sinon.stub().resolves({}), getChainTip: sinon.stub().resolves(null) };
    hub.resolveIndexerUrl = sinon.stub().callsFake(async () => url);
    if (post instanceof Error) axiosStub.post.rejects(post); else axiosStub.post.resolves(post);
    return hub;
}

describe('ChainTips.resolveDogeLatestBlock', function () {
    before(function () {
        this.timeout(30000);
        axiosStub = { post: sinon.stub() };
        XChainHub = proxyquire('../../../src/XChainHub', {
            'axios': axiosStub,
            './db': function () { return {}; }
        });
    });
    beforeEach(function () {
        axiosStub.post.reset();
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
        sinon.stub(console, 'log');
    });
    afterEach(function () { sinon.restore(); });

    it('returns the indexer block_index for DOGE', async function () {
        const hub = hubWith('http://indexer.invalid/api', { data: { result: { block_index: 5000123, lag: 2 } } });
        expect(await hub.resolveDogeLatestBlock()).to.equal(5000123);
        expect(hub.resolveIndexerUrl.firstCall.args[0]).to.equal('DOGE');
    });

    it('returns null when no DOGE indexer URL resolves', async function () {
        const hub = hubWith(null, { data: { result: { block_index: 1 } } });
        expect(await hub.resolveDogeLatestBlock()).to.equal(null);
        expect(axiosStub.post.called).to.equal(false);
    });

    it('returns null for no result, an error, a bad block_index, a stale lag or a failed call', async function () {
        for (const post of [
            { data: {} },
            { data: { result: { error: 'boom' } } },
            { data: { result: { block_index: null } } },
            { data: { result: { block_index: 0 } } },
            { data: { result: { block_index: 9, lag: 100000 } } },
            new Error('down')
        ]) {
            const hub = hubWith('http://indexer.invalid/api', post);
            expect(await hub.resolveDogeLatestBlock()).to.equal(null);
        }
    });
});

describe('anchor publisher callers treat a null DOGE height as unresolved', function () {
    const canonicalForms = require('../../../src/anchor/publisher/canonical_forms.js');
    const bundle = require('../../../src/anchor/publisher/bundle.js');

    it('co-sign refuses when the DOGE height is null', async function () {
        const ctx = Object.assign({}, {
            identity: { getPubkeyHex: () => 'aa' },
            hub: { resolveDogeLatestBlock: async () => null }
        });
        const env = { data: { archive: { checkpoint: {} }, sections: [], sig_pubkey: 'bb', publisher: 'bb', snapshot_block: 1, network: 'mainnet' } };
        expect(await canonicalForms.foldPublisherMethods.coSignFoldArchiveRequest.call(ctx, env)).to.equal(null);
    });

    it('publishPendingCheckpoints keeps the BTC fallback height when the DOGE height is null', async function () {
        const suppress = sinon.stub();
        const ctx = {
            hub: { resolveDogeLatestBlock: async () => null },
            network: 'mainnet',
            findAnchorEligibleSections: async () => [],
            groupSectionsByNetwork: () => [],
            suppressLegacyArchiveLeg: suppress
        };
        const cf = require('../../../src/anchor/publisher/canonical_forms.js');
        const spy = sinon.spy(cf, 'isAnchorFoldActive');
        try {
            await bundle.publishPendingCheckpoints.call(ctx, {}, 777, false);
            expect(spy.called).to.equal(true);
            expect(spy.firstCall.args[0]).to.equal(777);
        } finally { spy.restore(); }
    });
});
