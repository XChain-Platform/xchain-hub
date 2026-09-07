/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/rollcall_activation.test.js
 *
 * ROLLCALL activation and epoch arithmetic, hub side.
 *
 * The hub SIGNS roll calls and elects the leader that lands them on DOGE; the
 * BTC indexer JUDGES them, closing each epoch and evicting an absent source by
 * synthetic UNSTAKE. A one-sided edit to either copy of these eight consensus
 * values forks the fleet at an epoch boundary: the hub signs for an epoch the
 * indexer does not believe exists, or counts a signature the indexer discards,
 * and a validator is evicted (or spared) on one side only.
 *
 * The indexer twin already asserts parity from its side. That assertion runs in
 * the INDEXER suite, and it skips outright when the hub checkout is absent, so
 * hub-side drift surfaces as somebody ELSE'S red PR while the hub's own suite
 * reads green on the same unlevelled twin. This file is the missing hub-side
 * half, and it is deliberately built in two layers:
 *
 *   1. A SIBLING-FREE layer that pins every consensus value and every
 *      predicate outcome as a literal. It has no sibling dependency, so it
 *      cannot skip: hub-side drift reddens the hub's own suite in a single-repo
 *      clone with no xchain-indexer next to it. This is the layer the false-green
 *      family exists to install.
 *   2. A TWIN layer against xchain-indexer, which skips when the sibling is
 *      absent (unless XCHAIN_REQUIRE_SIBLINGS=1), matching the convention of
 *      attest_relay_activation.test.js and price_pair_activation.test.js.
 *
 * Every gate keys on the carried BTC EPOCH height on both chains, never a local
 * processing height; see the module header for why.
 */

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local = require('../../src/rollcall_activation.js');

// Sibling resolution, same convention as price_pair_activation.test.js: an
// explicit env path for CI (actions/checkout cannot write above the workspace),
// falling back to the dev sibling layout. Absent -> skip, unless CI demands it.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'rollcall_activation.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', 'src', 'rollcall_activation.js');

const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const MAPS = [
    'ROLLCALL_ACTIVATION',
    'ROLLCALL_INTERVAL_BLOCKS',
    'ROLLCALL_ACCEPT_WINDOW_BLOCKS',
    'ROLLCALL_PROOF_DELAY_BLOCKS',
    'ROLLCALL_DOGE_MATURITY',
];
const SCALARS = ['ROLLCALL_EVICT_MISSES', 'ROLLCALL_STREAK_LOOKBACK', 'ROLLCALL_REWARD_AMOUNT'];

// ROLLCALL_ACTIVATION.regtest is resolved at REQUIRE time from
// XC_ROLLCALL_REGTEST_ACTIVATION, so the only honest way to exercise an armed
// venue is a fresh copy of the module under that environment.
//
// The EXACT original cache entry goes back afterwards, not a fresh require of
// the same path. Sibling suites (RollcallRound) hold their own reference to the
// module object and arm regtest by mutating it, so leaving a different instance
// in the cache strands that mutation and the engine reads an inert map.
function loadWithEnv(value){
    const id     = require.resolve(LOCAL_PATH);
    const cached = require.cache[id];
    const saved  = process.env[local.ROLLCALL_REGTEST_ENV];
    if (value === undefined) delete process.env[local.ROLLCALL_REGTEST_ENV];
    else process.env[local.ROLLCALL_REGTEST_ENV] = value;
    delete require.cache[id];
    try { return require(LOCAL_PATH); }
    finally {
        if (saved === undefined) delete process.env[local.ROLLCALL_REGTEST_ENV];
        else process.env[local.ROLLCALL_REGTEST_ENV] = saved;
        if (cached) require.cache[id] = cached;
        else delete require.cache[id];
    }
}

describe('ROLLCALL activation: hub copy @regression', function () {

    // ------------------------------------------------------------------
    // Layer 1: no sibling required. These pins are what make hub-side drift
    // red in a hub-only checkout.
    // ------------------------------------------------------------------
    describe('the eight consensus values this hub will sign against', function () {

        it('pins the per-network activation heights, mainnet and regtest INERT by default', function () {
            // null, not 0 and not a height: the operator owns the mainnet flag day.
            // regtest is null until the VENUE opts in; arming it by default
            // wedges every single-coin BTC venue at its first close, because the epoch
            // close has no DOGE peer to ask and defers rather than reading silence as
            // absence. All three copies, including the record in
            // xchain-documentation/protocol/constants.js, resolve it the same way.
            expect(local.ROLLCALL_ACTIVATION.mainnet).to.equal(null);
            expect(local.ROLLCALL_ACTIVATION.testnet).to.equal(151200);
            expect(local.ROLLCALL_ACTIVATION.regtest).to.equal(null);
        });

        it('names the regtest arming height, and puts it on a real epoch boundary', function () {
            expect(local.ROLLCALL_REGTEST_ARMED_HEIGHT).to.equal(0);
            expect(local.ROLLCALL_REGTEST_ARMED_HEIGHT % local.ROLLCALL_INTERVAL_BLOCKS.regtest).to.equal(0);
            expect(local.ROLLCALL_REGTEST_ENV).to.equal('XC_ROLLCALL_REGTEST_ACTIVATION');
        });

        it('arms this hub only when the venue opts in, and never a shared-ledger network', function () {
            const armed = loadWithEnv('armed');
            expect(armed.ROLLCALL_ACTIVATION.regtest).to.equal(0);
            expect(armed.isRollcallActive(0, 'regtest')).to.equal(true);
            // The 2026-09-01 ruling scopes the no-tunable-input rule to networks with a
            // shared ledger. These two must stay unreachable from the environment.
            expect(armed.ROLLCALL_ACTIVATION.mainnet).to.equal(null);
            expect(armed.ROLLCALL_ACTIVATION.testnet).to.equal(151200);
            expect(loadWithEnv('off').ROLLCALL_ACTIVATION.regtest).to.equal(null);
            expect(loadWithEnv('nonsense').ROLLCALL_ACTIVATION.regtest).to.equal(null);
        });

        it('pins the epoch cadence, accept window, proof delay and DOGE maturity', function () {
            expect(local.ROLLCALL_INTERVAL_BLOCKS)
                .to.deep.equal({ mainnet: 1008, testnet: 1008, regtest: 30 });
            expect(local.ROLLCALL_ACCEPT_WINDOW_BLOCKS)
                .to.deep.equal({ mainnet: 144, testnet: 144, regtest: 12 });
            expect(local.ROLLCALL_PROOF_DELAY_BLOCKS)
                .to.deep.equal({ mainnet: 36, testnet: 36, regtest: 2 });
            expect(local.ROLLCALL_DOGE_MATURITY)
                .to.deep.equal({ mainnet: 60, testnet: 60, regtest: 2 });
        });

        it('pins K, 2K and the frozen leader reward', function () {
            expect(local.ROLLCALL_EVICT_MISSES).to.equal(2);
            expect(local.ROLLCALL_STREAK_LOOKBACK).to.equal(4);
            // A string, in ANCHOR_REWARD_AMOUNT parity: never a float, never from the wire.
            expect(local.ROLLCALL_REWARD_AMOUNT).to.equal('10.00000000');
        });

        it('keeps the lookback at exactly 2K, so one edit cannot strand the streak window', function () {
            expect(local.ROLLCALL_STREAK_LOOKBACK).to.equal(2 * local.ROLLCALL_EVICT_MISSES);
        });

        it('keeps the proof delay at 1 or more on every network', function () {
            // A block's block_time is written AFTER its own processing, so the window
            // endpoint must be a strictly earlier block than the close.
            for (const net of NETWORKS)
                expect(local.ROLLCALL_PROOF_DELAY_BLOCKS[net], net + ' proof delay').to.be.at.least(1);
        });

        it('closes every epoch before the next one opens, on every network', function () {
            for (const net of NETWORKS) {
                const span = local.ROLLCALL_ACCEPT_WINDOW_BLOCKS[net] + local.ROLLCALL_PROOF_DELAY_BLOCKS[net];
                expect(span, net + ' close offset must stay inside the epoch interval')
                    .to.be.below(local.ROLLCALL_INTERVAL_BLOCKS[net]);
            }
        });

        it('arms testnet on a real epoch boundary, so no first epoch is skipped', function () {
            expect(local.ROLLCALL_ACTIVATION.testnet % local.ROLLCALL_INTERVAL_BLOCKS.testnet).to.equal(0);
        });

        it('exports every consensus value the indexer reads back', function () {
            // A dropped export is drift too: the twin would resolve undefined and the
            // parity checks below would compare undefined to undefined and pass.
            for (const name of MAPS.concat(SCALARS))
                expect(local[name], name + ' is not exported').to.not.equal(undefined);
        });
    });

    describe('isRollcallActive, as this hub evaluates it', function () {

        it('never arms an inert mainnet, at any height', function () {
            // 0 >= null is TRUE in JS: the trap the Number.isFinite guard exists for.
            expect(0 >= local.ROLLCALL_ACTIVATION.mainnet).to.equal(true);
            for (const h of [0, 1, 961000, 99999999])
                expect(local.isRollcallActive(h, 'mainnet'), 'mainnet armed at ' + h).to.equal(false);
        });

        it('gates testnet exactly at its pinned height', function () {
            expect(local.isRollcallActive(151199, 'testnet')).to.equal(false);
            expect(local.isRollcallActive(151200, 'testnet')).to.equal(true);
            expect(local.isRollcallActive(151201, 'testnet')).to.equal(true);
        });

        it('is active from genesis on an ARMED regtest venue, epoch 0 included', function () {
            expect(loadWithEnv('armed').isRollcallActive(0, 'regtest')).to.equal(true);
        });

        it('arms nothing on regtest while the venue has not opted in', function () {
            expect(local.isRollcallActive(0, 'regtest')).to.equal(false);
            expect(local.isRollcallActive(30, 'regtest')).to.equal(false);
        });

        it('fails closed on an unknown network or an unparseable height', function () {
            expect(local.isRollcallActive(5, 'bogusnet')).to.equal(false);
            expect(local.isRollcallActive('abc', 'regtest')).to.equal(false);
            expect(local.isRollcallActive(null, 'regtest')).to.equal(false);
            expect(local.isRollcallActive(undefined, 'regtest')).to.equal(false);
        });
    });

    describe('isRollcallEpoch', function () {

        it('treats regtest height 0 as a REAL epoch, not a falsy skip', function () {
            expect(local.isRollcallEpoch(0, 'regtest')).to.equal(true);
        });

        it('accepts multiples of the interval and rejects everything else', function () {
            expect(local.isRollcallEpoch(30, 'regtest')).to.equal(true);
            expect(local.isRollcallEpoch(60, 'regtest')).to.equal(true);
            expect(local.isRollcallEpoch(31, 'regtest')).to.equal(false);
            expect(local.isRollcallEpoch(151200, 'testnet')).to.equal(true);
            expect(local.isRollcallEpoch(151201, 'testnet')).to.equal(false);
        });

        it('fails closed on a negative height, an unknown network, or garbage', function () {
            expect(local.isRollcallEpoch(-30, 'regtest')).to.equal(false);
            expect(local.isRollcallEpoch(30, 'bogusnet')).to.equal(false);
            expect(local.isRollcallEpoch('abc', 'regtest')).to.equal(false);
        });
    });

    describe('epoch close arithmetic', function () {

        it('computes C = E + window + proof delay', function () {
            expect(local.rollcallWindowEndHeight(30, 'regtest')).to.equal(42);
            expect(local.rollcallCloseHeight(30, 'regtest')).to.equal(44);
            expect(local.rollcallCloseHeight(151200, 'testnet')).to.equal(151200 + 144 + 36);
        });

        it('round-trips a close block back to its epoch on an ARMED network', function () {
            const armed = loadWithEnv('armed');
            for (const [E, net] of [[30, 'regtest'], [60, 'regtest'], [151200, 'testnet']]) {
                const C = armed.rollcallCloseHeight(E, net);
                expect(armed.rollcallEpochClosingAt(C, net), net + ' close ' + C).to.equal(E);
            }
        });

        it('returns null for a block where no epoch closes', function () {
            const armed = loadWithEnv('armed');
            expect(armed.rollcallEpochClosingAt(43, 'regtest')).to.equal(null);
            expect(armed.rollcallEpochClosingAt(12345, 'regtest')).to.equal(null);
        });

        it('never closes an epoch on an inert mainnet', function () {
            const C = local.rollcallCloseHeight(1008, 'mainnet');
            expect(C, 'the arithmetic stays well-defined').to.be.a('number');
            expect(local.rollcallEpochClosingAt(C, 'mainnet'),
                'an inert network must never close an epoch, which is what keeps mainnet from evicting anyone')
                .to.equal(null);
        });

        it('fails closed on garbage rather than returning NaN', function () {
            expect(local.rollcallWindowEndHeight('abc', 'regtest')).to.equal(null);
            expect(local.rollcallCloseHeight(30, 'bogusnet')).to.equal(null);
            expect(local.rollcallEpochClosingAt('abc', 'regtest')).to.equal(null);
        });
    });

    // ------------------------------------------------------------------
    // Layer 2: the twin. Skips when the sibling is absent, which is exactly
    // why layer 1 above carries the literal pins.
    // ------------------------------------------------------------------
    describe('parity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        // Byte-identity apart from the ONE header line in which each copy names
        // the other, which is the only difference the module header sanctions.
        // Normalizing that line rather than skipping the comparison is what keeps
        // comment drift (which carries the reasoning a future editor relies on)
        // inside the guard.
        it('is byte-identical to xchain-indexer/src/rollcall_activation.js, twin-reference line aside', function () {
            const TWIN_REF = /xchain-\S+\/src\/rollcall_activation\.js/;
            const norm = (p) => fs.readFileSync(p, 'utf8')
                .split(/\r?\n/)
                .map(l => TWIN_REF.test(l) ? '<TWIN-REF>' : l)
                .join('\n');
            expect(norm(LOCAL_PATH)).to.equal(norm(TWIN_PATH),
                'the hub copy has drifted from the indexer twin; the hub would sign roll calls '
                + 'for epochs the indexer does not judge the same way, and eviction forks at the boundary');
        });

        it('agrees with the twin on every consensus value', function () {
            const twin = require(TWIN_PATH);
            for (const name of MAPS.concat(SCALARS))
                expect(local[name], name + ' drifted between hub and indexer').to.deep.equal(twin[name]);
        });

        it('agrees with the twin predicate across the boundaries and the failure cases', function () {
            const twin = require(TWIN_PATH);
            const cases = [
                [0, 'mainnet'], [1008, 'mainnet'],
                [151199, 'testnet'], [151200, 'testnet'], [151201, 'testnet'],
                [0, 'regtest'], [30, 'regtest'], [31, 'regtest'],
                [-30, 'regtest'], ['abc', 'regtest'], [null, 'regtest'], [7, 'bogusnet'],
            ];
            for (const [h, net] of cases) {
                const at = net + ':' + h;
                expect(local.isRollcallActive(h, net), 'isRollcallActive disagreed at ' + at)
                    .to.equal(twin.isRollcallActive(h, net));
                expect(local.isRollcallEpoch(h, net), 'isRollcallEpoch disagreed at ' + at)
                    .to.equal(twin.isRollcallEpoch(h, net));
                expect(local.rollcallWindowEndHeight(h, net), 'rollcallWindowEndHeight disagreed at ' + at)
                    .to.equal(twin.rollcallWindowEndHeight(h, net));
                expect(local.rollcallCloseHeight(h, net), 'rollcallCloseHeight disagreed at ' + at)
                    .to.equal(twin.rollcallCloseHeight(h, net));
                expect(local.rollcallEpochClosingAt(h, net), 'rollcallEpochClosingAt disagreed at ' + at)
                    .to.equal(twin.rollcallEpochClosingAt(h, net));
            }
        });
    });

    // The third copy, xchain-documentation/protocol/constants.js, is the map of
    // record. The hub is NOT the repo that diffs against it: rollcallActivation
    // .test.js in xchain-indexer already owns that assertion, and duplicating it
    // here would report one open drift as two. That check was RED on
    // ROLLCALL_ACTIVATION.regtest from 2026-08-31, when docs de1bb30 ruled regtest
    // INERT (null) and neither vendored twin was propagated. It is closed in
    // all three copies at once: regtest resolves from XC_ROLLCALL_REGTEST_ACTIVATION,
    // ships inert, and arms at ROLLCALL_REGTEST_ARMED_HEIGHT when a two-chain venue
    // opts in. Whoever changes that edits three files and the pins above together.
});
