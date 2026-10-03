'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { buildHubsRpc } = require('../../../src/api/rpc/hubs.js');
const { authGate, feedPortAllowlist } = require('../../../src/api/auth_gate.js');

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function requestThrough(middleware, key) {
    const req = {
        xchainFeedOrigin: true,
        method: 'POST',
        headers: key ? { 'x-api-key': key } : {},
        body: { jsonrpc: '2.0', id: 1, method: 'gethubs', params: {} }
    };
    const res = response();
    let nexted = false;
    middleware(req, res, () => { nexted = true; });
    return { req, res, nexted };
}

describe('gethubs feed read', function () {
    const hubs = [{ api_url: 'https://hub.example:10002', signing_pubkey: 'aabb' }];
    const ctx = {
        HUB_API_KEY: 'feed-key',
        HUB_REORG_API_KEY: '',
        HUB_CONFIG_SECRETS_API_KEY: '',
        REORG_WRITE_METHODS: new Set(),
        WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(),
        SENSITIVE_READ_AUTH: false
    };

    it('answers with self and connected signer-set peer advertisements', function () {
        const methods = buildHubsRpc({
            hub: { getPeerManager: () => ({ getHubAdvertisements: () => hubs }) }
        });
        expect(methods.gethubs()).to.deep.equal({ hubs });
    });

    it('answers on the feed port after the feed key gate', function () {
        const keyed = requestThrough(authGate(ctx), 'feed-key');
        expect(keyed.nexted).to.equal(true);
        const allowed = requestThrough(feedPortAllowlist(), 'feed-key');
        expect(allowed.nexted).to.equal(true);

        const result = buildHubsRpc({
            hub: { peerManager: { getHubAdvertisements: () => hubs } }
        }).gethubs();
        expect(result).to.deep.equal({ hubs });
    });

    it('refuses the read without the feed key even when sensitive-read auth is disabled', function () {
        const denied = requestThrough(authGate(ctx));
        expect(denied.nexted).to.equal(false);
        expect(denied.res.statusCode).to.equal(401);
        expect(denied.res.body.error.code).to.equal(-32001);
    });
});
