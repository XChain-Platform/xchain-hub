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

// The bridge engine loads its three flag-day gates by a computed path inside a
// try/catch that returns null, and a null gate idles the engine with no error, no
// failing round and no wire field naming it. The engine lives in a feature directory
// while the gates stay at the top of src/, so this suite constructs a real engine and
// checks that each predicate is the one the top-level carrier exports.

const { expect } = require('chai');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');

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
        engine = new CrossChainBridgeEngine({
            db:             {},
            network:        'regtest',
            p2pConfig:      {},
            getPeerManager: () => null,
            getIdentity:    () => null
        });
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
