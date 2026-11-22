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

/**
 * One admitted getpricesnapshots call with with_quorum_margin starts a snapshot
 * read for each distinct anchor in the same tick. On a hub that finds its BTC
 * indexer in the configs table, each of those reads resolves the indexer URL, and
 * the gate budgets one pooled connection per admitted call. The resolutions
 * therefore share one configs read.
 */

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const IndexerUrls = require('../../../../src/hub/indexer_urls.js');
const { buildOracleRpc } = require('../../../../src/api/rpc/oracle.js');
const { waitUntil } = require('../../../helpers/waitUntil');

const ENV_KEYS = ['BTC_INDEXER_API_URL', 'BTC_INDEXER_URL', 'INDEXER_COIN_CHECK'];
const CONFIGS = { bitcoin: { regtest: { 'xchain-indexer': { host: 'indexer.local', port: '8080' } } } };

function row(anchor) {
    return {
        round_number: anchor,
        coin_pair: 'BTC/USD',
        status: 'finalized',
        reference_block: anchor,
        consensus_proof: JSON.stringify(['a', 'b', 'c'].map(pubkey => ({ pubkey, sig: 'sig-' + pubkey }))),
    };
}

function indexerReply(body) {
    const weighted = body.method === 'getstakeweightsbycapability';
    return { data: { result: {
        capability: body.params.capability,
        block_index: body.params.block_index,
        count: 4,
        source_count: weighted ? 4 : undefined,
        validators: ['a', 'b', 'c', 'd'].map(pubkey => (weighted
            ? { pubkey, source: 'source-' + pubkey, weight: '50000' }
            : { pubkey, amount: '50000' })),
    } } };
}

// A hub whose configs read holds a pooled connection until the test lets it go, and counts how
// many are held at once.
function poolHub(anchorCount) {
    const axios = { post: sinon.spy(async (url, body) => indexerReply(body)) };
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    const CapabilitySnapshot = proxyquire('../../../../src/validators/capability_snapshot.js', {
        axios,
        '../observability': { getLogger: () => log, '@global': true },
    });
    const held = [];
    const pool = { reads: 0, open: 0, peak: 0, releaseAll() { while (held.length) held.shift()(); } };
    const hub = Object.assign(Object.create(IndexerUrls.prototype), {
        network: 'regtest',
        db: {
            async getAllConfigs() {
                pool.reads++;
                pool.open++;
                pool.peak = Math.max(pool.peak, pool.open);
                await new Promise((resolve) => held.push(resolve));
                pool.open--;
                return CONFIGS;
            },
        },
        getPriceSnapshots: async () => Array.from({ length: anchorCount }, (_, index) => row(1000 + index)),
    });
    hub.capabilitySnapshot = new CapabilitySnapshot(hub);
    return { hub, pool, axios };
}

describe('getpricesnapshots quorum margin pool use', function () {
    const saved = {};
    beforeEach(function () {
        for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
        process.env.INDEXER_COIN_CHECK = '0';
    });
    afterEach(function () {
        sinon.restore();
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('reads the configs table once for sixteen cold anchors, so one slot holds one connection', async function () {
        const { hub, pool, axios } = poolHub(16);
        const call = buildOracleRpc({ hub, hubConfig: {} }).getpricesnapshots({ limit: 16, with_quorum_margin: true });
        // All sixteen resolutions start in one synchronous pass, so the first read to appear
        // is the moment every read the request will issue is already open.
        await waitUntil(() => pool.reads > 0, { label: 'a configs read' });
        pool.releaseAll();
        const out = await call;

        expect(axios.post.callCount, 'every distinct anchor still fetched its own snapshot').to.equal(16);
        expect(out.every(item => item.quorum_margin !== null)).to.equal(true);
        expect(pool.peak).to.equal(1);
        expect(pool.reads).to.equal(1);
    });

    it('reads the configs table again for a later resolution and hands a failure to the callers that joined', async function () {
        const { hub, pool } = poolHub(1);
        hub.db.getAllConfigs = async () => { pool.reads++; return CONFIGS; };
        expect(await hub.resolveIndexerUrl('BTC')).to.equal('http://indexer.local:8080');
        expect(await hub.resolveIndexerUrl('BTC')).to.equal('http://indexer.local:8080');
        expect(pool.reads).to.equal(2);

        hub.db.getAllConfigs = async () => { pool.reads++; throw new Error('pool closed'); };
        const failed = await Promise.all([hub.resolveIndexerUrl('BTC'), hub.resolveIndexerUrl('BTC')]);
        expect(failed).to.deep.equal([null, null]);
        expect(pool.reads).to.equal(3);

        hub.db.getAllConfigs = async () => { pool.reads++; return CONFIGS; };
        expect(await hub.resolveIndexerUrl('BTC')).to.equal('http://indexer.local:8080');
        expect(pool.reads).to.equal(4);
    });
});
