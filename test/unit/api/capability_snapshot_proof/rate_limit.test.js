/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

// The production route, mounted as api.js mounts it, answering a BTC indexer
// 429 and its own budget refusal as 429 with Retry-After instead of 503.

const http = require('http');
const express = require('express');
const sinon = require('sinon');
const { expect } = require('chai');

const { mountSnapshotRoutes } = require('../../../../src/api/rest/hub_db_snapshot.js');

const CREDENTIAL = 'snapshot-reader';
const CAPABILITY = 'oracle_publish';
const PUBKEY_A = 'a'.repeat(64);
const PATH = '/hub-db/snapshot/capability_snapshot_proof?snapshot_block=100&capability=' +
    CAPABILITY + '&pubkeys=' + PUBKEY_A;

function request(server) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, method: 'GET', path: PATH,
            headers: { 'x-api-key': CREDENTIAL }
        }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode, retryAfter: res.headers['retry-after'], body: JSON.parse(text)
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

function checkpoint() {
    return {
        id: 91, chain: 'BTC', network: 'regtest', block_index: 94,
        block_hash: 'c'.repeat(64), state_root: 'd'.repeat(64), state_root_version: 2,
        validator_signatures: '[]',
    };
}

function upstream429(retryAfter) {
    const error = new Error('Request failed with status code 429');
    error.response = { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } };
    return error;
}

let server;
let axios;

function boot(hubConfig) {
    return new Promise(resolve => {
        axios = { post: sinon.stub().resolves({ data: { result: { root: 'd'.repeat(64), leaves: [] } } }) };
        const hub = {
            db: {
                getSnapshotCheckpoint: sinon.stub().resolves(checkpoint()),
                findCapabilitySnapshotsBySnapshotBlockAndCapability: sinon.stub().resolves([]),
            },
            network: 'regtest',
            p2pConfig: { CAPABILITIES: { [CAPABILITY]: { MIN_STAKE: '1' } } },
            resolveIndexerUrl: sinon.stub().resolves('http://btc-indexer.test'),
        };
        const app = express();
        mountSnapshotRoutes(app, {
            hub, axios, hubConfig, p2pConfig: hub.p2pConfig,
            HUB_NETWORK: 'regtest', HUB_API_KEY: CREDENTIAL,
            HUB_API_KEY_PREVIOUS: '', HUB_FEED_API_KEY: '',
            logger: { error: sinon.stub() },
            bigIntReplacer: (key, value) => value,
        });
        server = app.listen(0, '127.0.0.1', resolve);
    });
}

describe('capability proof route under the BTC indexer rate limit', function () {
    afterEach(done => { server.close(done); });

    it('answers an upstream 429 as 429 with its Retry-After, not 503', async function () {
        await boot({});
        axios.post.onFirstCall().rejects(upstream429('7'));
        const response = await request(server);
        expect(response.status).to.equal(429);
        expect(response.retryAfter).to.equal('7');
        expect(response.body).to.deep.equal({ error: 'PROOF_RATE_LIMITED' });
    });

    it('stops calling the BTC indexer while the upstream Retry-After runs', async function () {
        await boot({});
        axios.post.onFirstCall().rejects(upstream429('30'));
        expect((await request(server)).status).to.equal(429);
        const held = await request(server);
        expect(held.status).to.equal(429);
        expect(Number(held.retryAfter)).to.be.within(29, 30);
        expect(axios.post.callCount).to.equal(1);
    });

    it('gives a 429 without a Retry-After header a bounded wait', async function () {
        await boot({});
        axios.post.onFirstCall().rejects(upstream429());
        const response = await request(server);
        expect(response.status).to.equal(429);
        expect(response.retryAfter).to.equal('10');
    });

    it('shares one configured budget across concurrent clients and refuses the excess with 429', async function () {
        // One call a minute: the burst of four passes, the rest of the clients are told to wait.
        await boot({ HUB_CAPABILITY_PROOF_RPM: '1' });
        const responses = await Promise.all(Array.from({ length: 6 }, () => request(server)));
        const statuses = responses.map(r => r.status).sort();
        expect(statuses).to.deep.equal([200, 200, 200, 200, 429, 429]);
        for (const refused of responses.filter(r => r.status === 429)) {
            expect(Number(refused.retryAfter)).to.be.within(59, 60);
            expect(refused.body).to.deep.equal({ error: 'PROOF_RATE_LIMITED' });
        }
        expect(axios.post.callCount).to.equal(4);
    });

    it('still answers 503 for an upstream failure that is not a rate limit', async function () {
        await boot({});
        axios.post.onFirstCall().rejects(new Error('offline'));
        const response = await request(server);
        expect(response.status).to.equal(503);
        expect(response.body).to.deep.equal({ error: 'PROOF_UNAVAILABLE' });
    });
});
