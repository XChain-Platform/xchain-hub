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

const http = require('http');
const express = require('express');
const sinon = require('sinon');
const { expect } = require('chai');

const { mountSnapshotRoutes } = require('../../../../src/api/rest/hub_db_snapshot.js');

const CREDENTIAL = 'snapshot-reader';
const CAPABILITY = 'oracle_publish';
const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const CHECKPOINT_BLOCK = 94;

function request(server, path, credential = CREDENTIAL) {
    return new Promise((resolve, reject) => {
        const headers = credential === null ? {} : { 'x-api-key': credential };
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, method: 'GET', path, headers
        }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end();
    });
}

function checkpoint() {
    return {
        id: 91,
        chain: 'BTC',
        network: 'regtest',
        block_index: CHECKPOINT_BLOCK,
        block_hash: 'c'.repeat(64),
        state_root: 'd'.repeat(64),
        state_root_version: 2,
        validator_signatures: '[{"pubkey":"signed"}]',
        created_at: 'not public',
    };
}

function proof() {
    return { root: 'd'.repeat(64), leaves: [{ pubkey: PUBKEY_A, amount: '10' }] };
}

function routePath(pubkeys) {
    let path = '/hub-db/snapshot/capability_snapshot_proof?snapshot_block=100&capability=' + CAPABILITY;
    if (pubkeys !== undefined) path += '&pubkeys=' + pubkeys.join(',');
    return path;
}

describe('GET /hub-db/snapshot/capability_snapshot_proof', function () {
    let server;
    let db;
    let axios;
    let hub;

    beforeEach(function (done) {
        db = {
            getSnapshotCheckpoint: sinon.stub().resolves(checkpoint()),
            findCapabilitySnapshotsBySnapshotBlockAndCapability: sinon.stub().resolves([
                { signing_pubkey: PUBKEY_A }, { signing_pubkey: PUBKEY_B }
            ]),
        };
        axios = { post: sinon.stub().resolves({ data: { result: proof() } }) };
        hub = {
            db,
            network: 'regtest',
            p2pConfig: { CAPABILITIES: { [CAPABILITY]: { MIN_STAKE: '1' } } },
            resolveIndexerUrl: sinon.stub().resolves('http://btc-indexer.test'),
            btcIndexerHeaders: sinon.stub().returns({
                'Content-Type': 'application/json', 'x-api-key': 'indexer-key'
            }),
        };
        const app = express();
        mountSnapshotRoutes(app, {
            hub, axios, p2pConfig: hub.p2pConfig,
            HUB_NETWORK: 'regtest', HUB_API_KEY: CREDENTIAL,
            HUB_API_KEY_PREVIOUS: '', HUB_FEED_API_KEY: '',
            logger: { error: sinon.stub() },
            bigIntReplacer: (key, value) => value,
        });
        server = app.listen(0, '127.0.0.1', done);
    });

    afterEach(function (done) {
        server.close(done);
    });

    it('refuses a request without the snapshot feed credential', async function () {
        const response = await request(server, routePath([PUBKEY_A]), null);
        expect(response.status).to.equal(401);
        expect(response.body).to.deep.equal({ error: 'Unauthorized' });
        expect(db.getSnapshotCheckpoint.called).to.equal(false);
        expect(axios.post.called).to.equal(false);
    });

    it('returns BAD_PARAMS before storage or RPC work for invalid input', async function () {
        const malformed = await request(server,
            '/hub-db/snapshot/capability_snapshot_proof?snapshot_block=-1&capability=' + CAPABILITY);
        expect(malformed.status).to.equal(400);
        expect(malformed.body).to.deep.equal({ error: 'BAD_PARAMS' });

        const unconfigured = await request(server,
            '/hub-db/snapshot/capability_snapshot_proof?snapshot_block=100&capability=full_node');
        expect(unconfigured.status).to.equal(400);
        expect(unconfigured.body).to.deep.equal({ error: 'BAD_PARAMS' });
        expect(db.getSnapshotCheckpoint.called).to.equal(false);
        expect(axios.post.called).to.equal(false);
    });

    it('returns the stable not-yet-checkpointed response before requesting a proof', async function () {
        db.getSnapshotCheckpoint.resolves(null);
        const response = await request(server, routePath([PUBKEY_A]));
        expect(response.status).to.equal(404);
        expect(response.body).to.deep.equal({ error: 'SNAPSHOT_NOT_YET_CHECKPOINTED' });
        expect(db.getSnapshotCheckpoint.calledOnceWithExactly('BTC', 'regtest', CHECKPOINT_BLOCK))
            .to.equal(true);
        expect(axios.post.called).to.equal(false);
    });

    it('returns PROOF_UNAVAILABLE for RPC errors and does not cache a failure', async function () {
        axios.post.onFirstCall().rejects(new Error('offline'));
        axios.post.onSecondCall().resolves({ data: { result: proof() } });

        const unavailable = await request(server, routePath([PUBKEY_A]));
        expect(unavailable.status).to.equal(503);
        expect(unavailable.body).to.deep.equal({ error: 'PROOF_UNAVAILABLE' });

        const recovered = await request(server, routePath([PUBKEY_A]));
        expect(recovered.status).to.equal(200);
        expect(recovered.body.proof).to.deep.equal(proof());
        expect(axios.post.callCount).to.equal(2);
    });

    it('treats JSON-RPC error and null answers as unavailable', async function () {
        const answers = [
            { data: { error: { code: -1 } } },
            { data: { result: { error: 'not ready' } } },
            { data: { result: null } },
        ];
        for (const answer of answers) {
            axios.post.resolves(answer);
            const response = await request(server, routePath([PUBKEY_A]));
            expect(response.status).to.equal(503);
            expect(response.body).to.deep.equal({ error: 'PROOF_UNAVAILABLE' });
        }
    });

    it('forwards explicit keys and returns only the specified success shape', async function () {
        const response = await request(server, routePath([PUBKEY_A, PUBKEY_B]));
        expect(response.status).to.equal(200);
        expect(response.body).to.deep.equal({
            snapshot_block: 100,
            capability: CAPABILITY,
            checkpoint: {
                chain: 'BTC', network: 'regtest', block_index: CHECKPOINT_BLOCK,
                block_hash: 'c'.repeat(64), state_root: 'd'.repeat(64),
                state_root_version: 2, validator_signatures: '[{"pubkey":"signed"}]',
            },
            proof: proof(),
        });
        expect(db.findCapabilitySnapshotsBySnapshotBlockAndCapability.called).to.equal(false);
        expect(hub.resolveIndexerUrl.calledOnceWithExactly('BTC')).to.equal(true);
        expect(axios.post.calledOnceWithExactly(
            'http://btc-indexer.test',
            {
                jsonrpc: '2.0', method: 'getcapabilitystakeproof', id: 1,
                params: { capability: CAPABILITY, block_index: CHECKPOINT_BLOCK, pubkeys: [PUBKEY_A, PUBKEY_B] },
            },
            {
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'indexer-key' },
                timeout: 15000,
            }
        )).to.equal(true);
    });

    it('defaults to the unique signing pubkey set stored at the requested snapshot', async function () {
        db.findCapabilitySnapshotsBySnapshotBlockAndCapability.resolves([
            { signing_pubkey: PUBKEY_A },
            { signing_pubkey: PUBKEY_A },
            { signing_pubkey: PUBKEY_B },
        ]);
        const response = await request(server, routePath());
        expect(response.status).to.equal(200);
        expect(db.findCapabilitySnapshotsBySnapshotBlockAndCapability
            .calledOnceWithExactly(100, CAPABILITY)).to.equal(true);
        expect(axios.post.firstCall.args[1].params.pubkeys).to.deep.equal([PUBKEY_A, PUBKEY_B]);
    });

    it('refuses an empty or oversized default signing pubkey set', async function () {
        db.findCapabilitySnapshotsBySnapshotBlockAndCapability.resolves([]);
        const empty = await request(server, routePath());
        expect(empty.status).to.equal(400);
        expect(empty.body).to.deep.equal({ error: 'BAD_PARAMS' });

        db.findCapabilitySnapshotsBySnapshotBlockAndCapability.resolves(
            Array.from({ length: 257 }, (_, index) => ({
                signing_pubkey: index.toString(16).padStart(64, '0')
            })));
        const oversized = await request(server, routePath());
        expect(oversized.status).to.equal(400);
        expect(oversized.body).to.deep.equal({ error: 'BAD_PARAMS' });
        expect(db.getSnapshotCheckpoint.called).to.equal(false);
        expect(axios.post.called).to.equal(false);
    });
});
