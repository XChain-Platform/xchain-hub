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

// The bridge engine resolves its three flag-day gates at construction: the table as a
// registry row, the predicate from the carrier at the top of src/ by a computed path.
// A miss that returned null idled the engine with no error, no failing
// round and no wire field naming it. The engine lives in a feature directory while the
// carriers stay at the top of src/, so this suite constructs a real engine, checks that
// each predicate is the one the top-level carrier exports, and checks that a registry
// row the build lacks throws at construction naming the key instead of idling.

const { expect } = require('chai');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const registry               = require('../../../../src/consensus/gate_registry.js');

const BARE_HUB = {
    db:             {},
    network:        'regtest',
    p2pConfig:      {},
    getPeerManager: () => null,
    getIdentity:    () => null
};

// [activation key on the engine, carrier module under src/, exported predicate]
const GATES = [
    ['bridge', 'xchain_bridge_activation', 'isXchainBridgeActive'],
    ['token',  'token_bridge_activation',  'isTokenBridgeActive'],
    ['policy', 'token_policy_activation',  'isTokenPolicyInheritanceActive']
];

describe('cross-chain bridge engine activation resolution', function () {

    let engine;

    before(function () {
        // A bare hub is enough: the constructor wires fields and two consensus
        // channels, and resolves the gates once, without polling or gossiping.
        engine = new CrossChainBridgeEngine(BARE_HUB);
    });

    for (const [key, carrier, predicate] of GATES) {
        it('resolves ' + carrier + ' (' + predicate + ') from the engine', function () {
            expect(typeof engine.activation[key],
                carrier + '.' + predicate + ' did not resolve from the bridge engine, so the bridge would idle silently')
                .to.equal('function');
            // The same function the carrier exports, not a stand-in that merely has the type.
            expect(engine.activation[key],
                carrier + '.' + predicate + ' resolved to something other than src/' + carrier + '.js')
                .to.equal(require('../../../../src/' + carrier + '.js')[predicate]);
        });
    }
});

describe('cross-chain bridge engine activation resolution: a registry miss', function () {

    const MISSING = 'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION';
    const realGet = registry.get;

    // The engine reads the registry through the module object, so a row can be taken
    // away for one construction without touching the block. Restored byte-exact after.
    beforeEach(function () {
        registry.get = function (key) {
            if (key === MISSING) throw new registry.RegistryMissError(key);
            return realGet.call(registry, key);
        };
    });
    afterEach(function () { registry.get = realGet; });

    it('throws at construction naming the key, instead of idling with a null gate', function () {
        expect(() => new CrossChainBridgeEngine(BARE_HUB))
            .to.throw(registry.RegistryMissError, MISSING);
    });

    it('resolves again once the row is back', function () {
        registry.get = realGet;
        expect(typeof new CrossChainBridgeEngine(BARE_HUB).activation.token).to.equal('function');
    });
});
