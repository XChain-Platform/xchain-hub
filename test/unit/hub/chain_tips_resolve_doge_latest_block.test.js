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

describe('anchor co-sign treats a null DOGE height as unresolved', function () {
    it('co-sign refuses before consulting the fold gate when the DOGE height is null', async function () {
        const activeAt = sinon.stub().returns(true);
        const forms = proxyquire('../../../src/anchor/publisher/canonical_forms.js', {
            '../../consensus/gate_registry.js': { activeAt }
        });
        const getStateCheckpoint = sinon.stub();
        const ctx = {
            identity: { getPubkeyHex: () => 'aa' },
            hub: { resolveDogeLatestBlock: sinon.stub().resolves(null) },
            db: { getStateCheckpointByChain: getStateCheckpoint }
        };
        const checkpoint = { chain: 'BTC', block_index: 1, checkpoint_seq: 2 };
        const env = { data: {
            archive: { checkpoint, wrapper_section_index: 0 },
            sections: [checkpoint], sig_pubkey: 'bb', publisher: 'bb',
            snapshot_block: 9999999999, network: 'mainnet'
        } };
        expect(await forms.foldPublisherMethods.coSignFoldArchiveRequest.call(ctx, env)).to.equal(null);
        expect(activeAt.called).to.equal(false);
        expect(getStateCheckpoint.called).to.equal(false);
    });
});

describe('anchor bundle callers treat a null DOGE height as unresolved', function () {
    const canonicalForms = require('../../../src/anchor/publisher/canonical_forms.js');
    const bundle = require('../../../src/anchor/publisher/bundle.js');

    it('publishNetworkBundles does not consult the fold gate when the DOGE height is null', async function () {
        const suppress = sinon.stub();
        const ctx = {
            hub: { resolveDogeLatestBlock: sinon.stub().resolves(null) },
            identity: { getPubkeyHex: () => 'aa' },
            getActiveOraclePublishPubkeys: sinon.stub().resolves(['aa']),
            splitBundle: sinon.stub().returns({ bundles: [], oversize: [] }),
            suppressLegacyArchiveLeg: suppress
        };
        const spy = sinon.spy(canonicalForms, 'isAnchorFoldActive');
        try {
            await bundle.publishNetworkBundles.call(ctx, {}, 'mainnet', [{ snapshot_block: 9999999999 }],
                                                    777, false, [], { rows: 0 });
            expect(spy.called).to.equal(false);
            expect(suppress.called).to.equal(false);
        } finally { spy.restore(); }
    });

    it('publishPendingCheckpoints does not consult the fold gate when the DOGE height is null', async function () {
        const suppress = sinon.stub();
        const ctx = {
            hub: { resolveDogeLatestBlock: sinon.stub().resolves(null) },
            network: 'mainnet',
            findAnchorEligibleSections: async () => [],
            groupSectionsByNetwork: () => [],
            suppressLegacyArchiveLeg: suppress
        };
        const cf = require('../../../src/anchor/publisher/canonical_forms.js');
        const spy = sinon.spy(cf, 'isAnchorFoldActive');
        try {
            await bundle.publishPendingCheckpoints.call(ctx, {}, 9999999999, false);
            expect(spy.called).to.equal(false);
            expect(suppress.called).to.equal(false);
        } finally { spy.restore(); }
    });
});
