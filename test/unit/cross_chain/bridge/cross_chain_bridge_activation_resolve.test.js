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
// registry row read by its literal key, the predicate as the registry's own activeAt
// over that row (W5: the predicate-only twin modules retired). A miss that returned
// null idled the engine with no error, no failing round and no wire field naming it.
// This suite constructs a real engine, checks that each predicate answers exactly what
// the registry answers for the row (coin-keyed slot first, fail closed on what it
// cannot read), that mainnet stays unarmed and testnet carries only the v0.19.0 cut's
// bridge heights, and that a registry row the build lacks throws at construction naming
// the key instead of idling.

const { expect } = require('chai');
const sinon = require('sinon');

const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const registry               = require('../../../../src/consensus/gate_registry.js');

const BARE_HUB = {
    db:             {},
    network:        'regtest',
    p2pConfig:      {},
    getPeerManager: () => null,
    getIdentity:    () => null
};

// [activation key on the engine, registry key]
const GATES = Object.entries(CrossChainBridgeEngine.BRIDGE_GATE_KEYS);

// Heights on both sides of every shipped threshold, plus what a predicate cannot read.
const PROBE_BLOCKS = [0, 1, 499, 500, 9999999998, 9999999999, 10000000000, -1, 'not-a-number', null, undefined, NaN];
const PROBE_NETS   = ['regtest', 'testnet', 'mainnet', 'nonsense-net', undefined];
const PROBE_COINS  = ['BTC', 'LTC', 'DOGE', undefined];

// Named helper steps for the resolution suite below, kept under the function-line
// limit: each step is its own named function registering its `it()` calls, called
// from a short describe body.
let engine;

function itNamesAllGatesByRegistryKey() {
    it('names all three gates by their registry keys, and each has a row', function () {
        expect(GATES.map(([k]) => k)).to.deep.equal(['bridge', 'token', 'policy']);
        for (const [, regKey] of GATES) expect(registry.has(regKey), regKey + ' has no registry row').to.equal(true);
    });
}

function itResolvesEachGateAsActiveAtOverTheRow() {
    for (const [key, regKey] of GATES) {
        it('resolves ' + regKey + ' from the engine as activeAt over the row', function () {
            expect(typeof engine.activation[key],
                regKey + ' did not resolve from the bridge engine, so the bridge would idle silently')
                .to.equal('function');
            // The predicate is the registry's answer for the row, on every probe, in the
            // (block, network, coin) shape the bridge parts call it in.
            for (const net of PROBE_NETS) for (const coin of PROBE_COINS) for (const block of PROBE_BLOCKS) {
                expect(engine.activation[key](block, net, coin), regKey + ' at ' + [block, net, coin].join(','))
                    .to.equal(registry.activeAt(regKey, net, coin, block, null));
            }
        });
    }
}

function itHandsTheCoinToTheRegistryAheadOfTheBareKey() {
    it('hands the coin to the registry, so the coin-keyed slot is read ahead of the bare network key', function () {
        // Every shipped slot of the bridge row holds the same value under its coin key
        // and its bare key, so only the call itself can show the coin reaching the
        // registry's resolution: the predicate is judged through activeAt's module
        // property, which is what the spy replaces for one call per gate.
        const spy = sinon.stub(registry, 'activeAt').returns(true);
        try {
            for (const [key, regKey] of GATES) {
                expect(engine.activation[key](7, 'regtest', 'DOGE')).to.equal(true);
                expect(spy.lastCall.args, regKey).to.deep.equal([regKey, 'regtest', 'DOGE', 7, null]);
            }
        } finally { spy.restore(); }
        const row = registry.get(GATES.find(([k]) => k === 'bridge')[1]);
        expect(row['regtest']).to.equal(0);
        expect(engine.activation.bridge(0, 'regtest', 'DOGE')).to.equal(true);
        // Every coin-keyed mainnet slot is unarmed, so the coin resolution must not fall
        // through to a bare key it would otherwise read.
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            expect(row[coin + ':mainnet'], coin + ':mainnet slot').to.equal(9999999999);
            expect(engine.activation.bridge(9999999998, 'mainnet', coin)).to.equal(false);
        }
    });
}

// The three rows must stay dark on mainnet for every chain, and the two token rows on
// testnet too: the hub signs transfer records, so an armed slot here is a federation that
// starts signing on a network the fleet has not deployed the flag day to. The one
// exception is what the v0.19.0 train wrote: the bridge row's three testnet coin slots,
// pinned here to the cut's heights so the row cannot drift from that record without this
// suite saying so; the bare testnet fallback stays dark. Sized 2026-09-16 at the v0.19.0
// cut (re-cut 16:33Z after the chain overran the first sizing) from each chain's own tip
// and measured cadence.
const ARMED_XCHAIN_TESTNET = { 'BTC:testnet': 152929, 'LTC:testnet': 4887898, 'DOGE:testnet': 67902062 };

function itHoldsEveryMainnetAndTestnetSlotUnarmed() {
    it('holds every mainnet slot of all three gates unarmed, the token gates unarmed on testnet, and the cut\'s bridge testnet heights', function () {
        for (const [key, regKey] of GATES) {
            const row = registry.get(regKey);
            for (const slot of Object.keys(row)) {
                if (!/mainnet$|testnet$/.test(slot)) continue;
                const armed = key === 'bridge' && ARMED_XCHAIN_TESTNET[slot] !== undefined;
                expect(row[slot], regKey + ' ' + slot + (armed ? ' does not carry the height the v0.19.0 cut sized' : ' is off the house sentinel'))
                    .to.equal(armed ? ARMED_XCHAIN_TESTNET[slot] : 9999999999);
            }
            expect(engine.activation[key](9999999998, 'mainnet', 'BTC'), regKey + ' mainnet').to.equal(false);
            if (key === 'bridge') continue;
            expect(engine.activation[key](9999999998, 'testnet', 'BTC'), regKey + ' testnet').to.equal(false);
        }
        // The armed slots resolve through the engine at their height and not one below,
        // and an unlisted coin reads the dark bare fallback.
        for (const [slot, height] of Object.entries(ARMED_XCHAIN_TESTNET)) {
            const coin = slot.split(':')[0];
            expect(engine.activation.bridge(height - 1, 'testnet', coin), slot + ' one below its height').to.equal(false);
            expect(engine.activation.bridge(height, 'testnet', coin), slot + ' at its height').to.equal(true);
        }
        expect(engine.activation.bridge(9999999998, 'testnet', 'BCH'), 'an unlisted testnet coin reads the dark fallback').to.equal(false);
    });
}

describe('cross-chain bridge engine activation resolution', function () {

    before(function () {
        // A bare hub is enough: the constructor wires fields and two consensus
        // channels, and resolves the gates once, without polling or gossiping.
        engine = new CrossChainBridgeEngine(BARE_HUB);
    });

    itNamesAllGatesByRegistryKey();
    itResolvesEachGateAsActiveAtOverTheRow();
    itHandsTheCoinToTheRegistryAheadOfTheBareKey();
    itHoldsEveryMainnetAndTestnetSlotUnarmed();
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
