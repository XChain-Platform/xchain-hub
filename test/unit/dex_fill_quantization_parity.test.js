'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The hub half of the shared fill-quantization
// contract. bcmath.js declares itself byte-equivalent to the indexer's helpers;
// this is what makes that claim testable rather than aspirational.
//
// The defect: the bottleneck clamp in CrossChainDexEngine multiplied at precision
// 18 while the indexer's identical derivation runs at 64, so for any price that is
// not finitely representable the two engines derived DIFFERENT fill quantities from
// the same pair of offers, and a hub that finalizes a fill the indexer will not
// reproduce livelocks matching.

const assert     = require('assert');
const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const proxyquire = require('proxyquire');
const bc         = require('../../src/bcmath.js');
const { createMockHub } = require('../helpers/mockHub');

// Warm the mathjs/bcmath require cache outside any timed hook (mirrors
// CrossChainDexEngine.test.js: the first mathjs load can exceed a 5s hook timeout).
require('mathjs');

// axios is stubbed: the engine-level assertions below drive _tryOrderMatch directly and
// must never reach an indexer.
const CrossChainDexEngine = proxyquire('../../src/CrossChainDexEngine', { axios: { post: sinon.stub() } });

function makeDexHub() {
    const hub = createMockHub();
    hub.db = { doQuery: sinon.stub().resolves([]) };
    hub.hubDbBroadcaster = null;
    hub.capabilitySnapshot = null;
    return hub;
}

const FIXTURE = path.join(__dirname, '../fixtures/dex-fill-quantization-vectors.json');
const vectors = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

describe('DEX fill quantization parity, hub half (#3145/#3146) @regression @tier1', function () {

    describe('precision alignment', function () {
        for (const v of vectors.precision_alignment) {
            it(`${v.label}: derives at precision 64, not 18`, function () {
                // Two vector shapes: the get-side branch derives give from max_get, the
                // give-side branch clamps give and derives get from max_give. Both branches
                // multiply, and both had to move off 18.
                const giveSide = v.clamped_side === 'give';
                const operand  = giveSide ? v.max_give  : v.max_get;
                const rate     = giveSide ? v.give_price : v.get_price;
                const exp64    = giveSide ? v.derived_get_at_64 : v.at_precision_64;
                const exp18    = giveSide ? v.derived_get_at_18 : v.at_precision_18;

                const at64 = String(bc.bcmul(operand, rate, 64));
                const at18 = String(bc.bcmul(operand, rate, 18));

                assert.strictEqual(at64, String(bc.bcnum(exp64)),
                    'precision-64 derivation must match the shared vector');

                if (giveSide) {
                    // The clamp step itself is exact here; pin it so the branch is fully covered.
                    assert.strictEqual(String(bc.bcmul(v.max_get, v.get_price, 64)),
                                       String(bc.bcnum(v.give_from_get_at_64)));
                }

                if (exp18 !== exp64) {
                    // This is the whole point: on an inexact price the two disagree, so
                    // running at 18 was observably not byte-equivalent to the indexer.
                    assert.notStrictEqual(at18, at64,
                        'this vector exists because 18 and 64 diverge; if they agree the ' +
                        'vector has stopped testing anything');
                } else {
                    // Exactly representable: proves the change is surgical, not blanket.
                    assert.strictEqual(at18, at64,
                        'an exactly representable price must be unaffected by the precision change');
                }
            });
        }

        it('the engine multiplies at 64 at BOTH clamp sites', function () {
            // Source-level pin: the two bcmul call sites are the fix. A future edit that
            // reintroduces 18 on either branch silently restores the divergence, and no
            // value-level test above would catch it because both branches are reachable
            // only through a full offer pair.
            const src = fs.readFileSync(path.join(__dirname, '../../src/CrossChainDexEngine.js'), 'utf8');
            const clampMuls = src.match(/bc\.bcmul\((?:max_get|max_give),\s*taker\w+Price,\s*(\d+)\)/g) || [];
            assert.strictEqual(clampMuls.length, 2, 'expected exactly the two clamp multiplications');
            for (const m of clampMuls) {
                assert.match(m, /,\s*64\)$/,
                    'both clamp multiplications must run at precision 64 to match order_match.js');
            }
        });
    });

    describe('bcround is present and faithful', function () {
        it('is exported (it was missing entirely, which made the parity claim false)', function () {
            assert.strictEqual(typeof bc.bcround, 'function',
                'the indexer quantizes both derived amounts with bcround; the hub had no such helper');
        });

        // These run the hub's ported helper against the SAME vectors the indexer half
        // runs, so the two implementations are pinned to one another. The engine-level
        // application of the same vectors is asserted further down.
        for (const v of vectors.tick_quantization) {
            it(`${v.label}: bcround(${v.amount}, ${v.decimals}) -> ${v.expected}`, function () {
                assert.strictEqual(String(bc.bcround(v.amount, v.decimals)),
                                   String(bc.bcnum(v.expected)));
            });
        }

        it('rounds half-UP, not to even (the mode, not just the width)', function () {
            assert.strictEqual(String(bc.bcround('0.5', 0)), '1');
            assert.strictEqual(String(bc.bcround('1.5', 0)), '2');
            assert.strictEqual(String(bc.bcround('2.5', 0)), '3', 'banker\'s rounding would give 2');
        });
    });

    describe('the engine applies the grid, and never guesses it', function () {
        // KEPT from the pre-parity suite, deliberately: a fallback default is still the
        // wrong way to close this, and it is the edit someone would reach for first.
        it('the engine does NOT quantize with a guessed COIN_DECIMALS', function () {
            const src = fs.readFileSync(path.join(__dirname, '../../src/CrossChainDexEngine.js'), 'utf8');
            assert.doesNotMatch(src, /bcround\s*\([^)]*COIN_DECIMALS/,
                'guessing 8 decimals would mis-quantize every 0-decimal (NFT) and ' +
                'non-8-decimal tick, which is worse than not rounding at all');
        });

        it('the fixture marks the tick-quantization vectors as hub-reachable', function () {
            // The flip of these flags IS the record that the hub now applies them. Going
            // back to false means the engine stopped quantizing, which is a consensus
            // change and must be reviewed as one.
            for (const v of vectors.tick_quantization) {
                assert.strictEqual(v.hub_reachable, true,
                    'the hub quantizes cross-chain fills on the offer-reported decimals');
            }
        });

        it('quantizes each derived amount on the GIVING leg\'s own reported decimals', function () {
            // The one shape that matters and that no unit-level bcround test covers: which
            // decimals go with which amount. takerGive is denominated in the taker's give
            // tick, takerGet in the MAKER's give tick, and each value comes from that leg's
            // own home indexer. Swapping them would quantize a DOGE-side fill on an
            // LTC-side grid, which reads plausible and settles wrong.
            const eng = new CrossChainDexEngine(makeDexHub());
            // Maker (earlier block) gives 100 LTCT at 8dp; taker gives 20 DOGT on a
            // 0-decimal (NFT-style) tick. Price 1 LTCT per 0.5 DOGT crosses.
            const maker = { kind: 'order', action_index: 1, home_coin: 'LTC', home_network: 'regtest',
                block_index: 10, give_coin: 'LTC', give_tick: 'LTCT', give_amount: '100',
                get_coin: 'DOGE', get_tick: 'DOGT', get_amount: '50', give_ownership: 0,
                get_ownership: 0, get_address: 'Laddr', give_decimals: 8 };
            const taker = { kind: 'order', action_index: 7, home_coin: 'DOGE', home_network: 'regtest',
                block_index: 20, give_coin: 'DOGE', give_tick: 'DOGT', give_amount: '21',
                get_coin: 'LTC', get_tick: 'LTCT', get_amount: '42', give_ownership: 0,
                get_ownership: 0, get_address: 'Daddr', give_decimals: 0 };
            const d = eng._tryOrderMatch(maker, taker);
            assert.ok(d, 'the pair crosses');
            // DOGE leg (0 decimals) settles a whole number; LTC leg (8) keeps its grid.
            const dogeFill = (d.lo.home_coin === 'DOGE') ? d.loFill : d.hiFill;
            const ltcFill  = (d.lo.home_coin === 'LTC')  ? d.loFill : d.hiFill;
            assert.doesNotMatch(String(dogeFill), /\./,
                'a 0-decimal give side must settle an integer quantity');
            assert.ok(Number(ltcFill) > 0);
        });

        it('declines the match when an offer carries no decimals, rather than defaulting', function () {
            // Fail-closed: the only way to see this is a hub polling a pre-batch indexer,
            // and the documented behaviour there is stalled matching, never a guessed grid.
            const eng = new CrossChainDexEngine(makeDexHub());
            const mk = (extra) => Object.assign({ kind: 'order', home_network: 'regtest',
                give_ownership: 0, get_ownership: 0 }, extra);
            const maker = mk({ action_index: 1, home_coin: 'LTC', block_index: 10, give_coin: 'LTC',
                give_tick: 'LTCT', give_amount: '100', get_coin: 'DOGE', get_tick: 'DOGT',
                get_amount: '50', get_address: 'Laddr', give_decimals: 8 });
            const taker = mk({ action_index: 7, home_coin: 'DOGE', block_index: 20, give_coin: 'DOGE',
                give_tick: 'DOGT', give_amount: '20', get_coin: 'LTC', get_tick: 'LTCT',
                get_amount: '40', get_address: 'Daddr', give_decimals: 8 });
            assert.ok(eng._tryOrderMatch(maker, taker), 'control: with decimals on both sides it matches');

            for (const missing of [undefined, null, '', 'eight', -1, 19, 2.5]) {
                const bad = Object.assign({}, taker, { give_decimals: missing });
                assert.strictEqual(eng._tryOrderMatch(maker, bad), null,
                    'give_decimals ' + JSON.stringify(missing) + ' must decline the match');
                const badMaker = Object.assign({}, maker, { give_decimals: missing });
                assert.strictEqual(eng._tryOrderMatch(badMaker, taker), null,
                    'the maker side must fail closed too');
            }
            // 0 is a VALID grid (indivisible ticks), not a missing value: a falsy check
            // here would silently refuse every NFT-side match.
            const zeroDp = Object.assign({}, taker, { give_decimals: 0 });
            assert.ok(eng._tryOrderMatch(maker, zeroDp), '0 decimals is valid, not absent');
        });
    });
});
