'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const ReorgHandler = require('../../../../src/anchor/reorg_handler');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');

const KEY = 'anchor/reorg_handler/snapshot_round.REORG_DIGEST_V2_ACTIVATION';
const OLD_HASH_A = 'a'.repeat(64);
const OLD_HASH_B = 'b'.repeat(64);
const NEW_HASH = 'c'.repeat(64);

function handler(network) {
    const instance = Object.create(ReorgHandler.prototype);
    instance.network = network;
    return instance;
}

function digest(instance, options = {}) {
    return instance.reorgRoundDigest(
        options.reorgId || 'round',
        'BTC',
        options.reorgHeight || 50,
        1234,
        options.oldHash || OLD_HASH_A,
        options.newHash || NEW_HASH,
        options.btcBlockHeight === undefined ? 100 : options.btcBlockHeight
    );
}

function legacyDigest(options = {}) {
    const payload = {
        reorgId: options.reorgId || 'round',
        chain: 'BTC',
        reorgHeight: options.reorgHeight || 50,
        timestamp: 1234,
        oldHash: options.oldHash || OLD_HASH_A,
        newHash: options.newHash || NEW_HASH
    };
    if (options.btcBlockHeight !== null) payload.btcBlockHeight = options.btcBlockHeight;
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

describe('reorg digest v2 gate', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('registers a height gate armed on regtest and on testnet at its v0.25.0 heights', function () {
        const row = gateRegistry.get(KEY);
        // The v0.25.0 cut arms the per-chain keys and the bare testnet key at the BTC height.
        expect(row).to.deep.equal({
            mainnet: gateRegistry.UNARMED,
            'BTC:testnet': 157053,
            'LTC:testnet': 4928170,
            'DOGE:testnet': 68008790,
            testnet: 157053,
            regtest: 0
        });
    });

    it('omits oldHash at the gate while binding the rest of the round', function () {
        const subject = handler('regtest');
        const baseline = digest(subject);

        expect(digest(subject, { oldHash: OLD_HASH_B })).to.equal(baseline);
        expect(digest(subject, { newHash: OLD_HASH_B })).to.not.equal(baseline);
        expect(digest(subject, { btcBlockHeight: 101 })).to.not.equal(baseline);
        expect(digest(subject, { reorgHeight: 51 })).to.not.equal(baseline);
        expect(digest(subject, { reorgId: 'other-round' })).to.not.equal(baseline);
    });

    it('keeps the literal legacy payload on dark networks and without a stamp', function () {
        for (const network of ['testnet', 'mainnet']) {
            const subject = handler(network);
            expect(digest(subject)).to.equal(legacyDigest({ btcBlockHeight: 100 }));
            expect(digest(subject, { oldHash: OLD_HASH_B }))
                .to.equal(legacyDigest({ oldHash: OLD_HASH_B, btcBlockHeight: 100 }));
        }
        expect(digest(handler('regtest'), { btcBlockHeight: null }))
            .to.equal(legacyDigest({ btcBlockHeight: null }));
    });

    it('flips exactly at a test-armed testnet height', function () {
        const activation = 500;
        const realActiveAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, network, coin, height, time) => {
            if (key === KEY && network === 'testnet') return height >= activation;
            return realActiveAt(key, network, coin, height, time);
        });
        const subject = handler('TESTNET');

        expect(digest(subject, { oldHash: OLD_HASH_B, btcBlockHeight: activation - 1 }))
            .to.not.equal(digest(subject, { btcBlockHeight: activation - 1 }));
        expect(digest(subject, { oldHash: OLD_HASH_B, btcBlockHeight: activation }))
            .to.equal(digest(subject, { btcBlockHeight: activation }));
    });
});
