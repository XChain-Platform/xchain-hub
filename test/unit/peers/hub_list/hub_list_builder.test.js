// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { normalizePublicApiUrl, buildHubList } = require('../../../../src/peers/hub_list.js');

const SELF_KEY = 'A'.repeat(64);
const PEER_KEY = 'B'.repeat(64);
const OTHER_KEY = 'C'.repeat(64);

function testNormalizesOrigins(){
    assert.strictEqual(
        normalizePublicApiUrl('  http://validator02.xchain.io:10002  '),
        'http://validator02.xchain.io:10002'
    );
    assert.strictEqual(
        normalizePublicApiUrl('http://validator02.xchain.io:10002/'),
        'http://validator02.xchain.io:10002'
    );
    assert.strictEqual(normalizePublicApiUrl('HTTPS://HUB.EXAMPLE.COM:443'), 'https://hub.example.com');
}

function testRefusesInvalidOrigins(){
    for(const value of [
        'ftp://hub.example.com',
        'https://user:pass@hub.example.com',
        '/relative',
        'https://hub.example.com/path',
        'https://hub.example.com?query=yes',
        'https://hub.example.com#fragment',
        'https://hub.example.com?',
        'https://hub.example.com#',
        'https://hub.example.com/.',
        42,
        null,
        undefined
    ]) assert.strictEqual(normalizePublicApiUrl(value), null, String(value));
}

function testNeverThrows(){
    for(const value of ['http://', 'https://[', {}, [], Symbol('url')]){
        assert.doesNotThrow(() => normalizePublicApiUrl(value));
        assert.strictEqual(normalizePublicApiUrl(value), null);
    }
}

function testSelfAndSignerPeers(){
    const result = buildHubList({
        self: { apiUrl: 'https://self.example.com/', signingPubkey: SELF_KEY },
        peers: [
            { apiUrl: 'http://peer.example.com:10002', signingPubkey: PEER_KEY },
            { apiUrl: 'https://other.example.com', signingPubkey: OTHER_KEY }
        ],
        isSigner: (pubkey) => pubkey === PEER_KEY.toLowerCase()
    });

    assert.deepStrictEqual(result, { hubs: [
        { api_url: 'https://self.example.com', signing_pubkey: SELF_KEY.toLowerCase() },
        { api_url: 'http://peer.example.com:10002', signing_pubkey: PEER_KEY.toLowerCase() }
    ] });
}

function testRefusedPeers(){
    const isSigner = (pubkey) => pubkey !== OTHER_KEY.toLowerCase();
    const result = buildHubList({
        self: null,
        peers: [
            { signingPubkey: PEER_KEY },
            { apiUrl: 'ftp://peer.example.com', signingPubkey: PEER_KEY },
            { apiUrl: 'https://short-key.example.com', signingPubkey: 'abcd' },
            { apiUrl: 'https://non-signer.example.com', signingPubkey: OTHER_KEY },
            null
        ],
        isSigner
    });

    assert.deepStrictEqual(result, { hubs: [] });
}

function testRefusedSelf(){
    const isSigner = () => true;
    assert.deepStrictEqual(buildHubList({
        self: { apiUrl: '/relative', signingPubkey: SELF_KEY }, peers: [], isSigner
    }), { hubs: [] });
    assert.deepStrictEqual(buildHubList({
        self: { apiUrl: 'https://self.example.com', signingPubkey: 'bad' }, peers: [], isSigner
    }), { hubs: [] });
}

function testDedupeOrder(){
    const result = buildHubList({
        self: { apiUrl: 'http://validator02.xchain.io:10002', signingPubkey: SELF_KEY },
        peers: [
            { apiUrl: 'http://validator02.xchain.io:10002/', signingPubkey: PEER_KEY },
            { apiUrl: 'https://third.example.com', signingPubkey: OTHER_KEY }
        ],
        isSigner: () => true
    });

    assert.deepStrictEqual(result, { hubs: [
        { api_url: 'http://validator02.xchain.io:10002', signing_pubkey: SELF_KEY.toLowerCase() },
        { api_url: 'https://third.example.com', signing_pubkey: OTHER_KEY.toLowerCase() }
    ] });
}

function testEmptyList(){
    assert.deepStrictEqual(buildHubList({
        self: { signingPubkey: SELF_KEY }, peers: [], isSigner: () => true
    }), { hubs: [] });
}

function registerNormalizeTests(){
    it('normalizes HTTP origins and trailing-slash twins', testNormalizesOrigins);
    it('refuses unsupported, credentialed and non-origin addresses', testRefusesInvalidOrigins);
    it('never throws for values that cannot be parsed', testNeverThrows);
}

function registerBuildTests(){
    it('puts self first, keeps signer peers and emits lowercase keys', testSelfAndSignerPeers);
    it('omits peers with missing or refused fields and non-signers', testRefusedPeers);
    it('omits self when its address or key is refused', testRefusedSelf);
    it('dedupes normalized addresses in first-seen order', testDedupeOrder);
    it('returns an empty list with no self address and no peers', testEmptyList);
}

describe('hub list builder', function(){
    describe('normalizePublicApiUrl()', registerNormalizeTests);
    describe('buildHubList()', registerBuildTests);
});
