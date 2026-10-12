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
 * test/unit/XchainPriceSource.test.js
 *
 * Validator-side XCHAIN/USD source.
 *
 * The formula and the row selection are tested in xchain-indexer against real dumped
 * rows; this file tests the DECISION this module owns, which is the one with teeth:
 * abstain, or publish. Get it backwards in either direction and the damage is
 * asymmetric but real - abstaining on a quiet market ages the pair past the 1800s
 * staleness bound and re-bricks LTC/DOGE fees (the exact bug this source exists to fix),
 * while publishing when the hub could not actually look asserts a market observation
 * it never made.
 */

'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { DB_METHODS } = require('../../helpers/mockHub.js');

const { XCHAIN_PRICE_BOOTSTRAP_SATS, PRICE_MAX } = require('../../../src/constants.js');

// The D2 rule uses satoshi denominations, so the bootstrap only becomes a USD
// price once a CONSENSUS BTC/USD exists to convert it with. Every carry-forward
// case therefore has to seed one. At 1000 sat and BTC/USD 100000 the arithmetic
// is exact and needs no rounding: 0.00001000 x 100000 = 1.00000000.
const FINALIZED_BTC = { 'BTC/USD': '100000.00000000' };
const BOOTSTRAP_AT_100K = '1.00000000';
const { COIN_ID_SQL, XCHAIN_TICK_SQL, DISPENSE_FILLS_SQL, DEX_FILLS_SQL } =
    require('../../../src/xchainPriceQuery.js');
const { INDEXER_TIP_SQL } = require('../../../src/db/price/indexer_tip_sql.js');

// HUB_NETWORK belongs in the shared fixture because the four consensus-uniform
// derivation overrides are honored only on regtest. A fixture that omitted it would
// silently take the set-but-IGNORED path and assert the pinned constants instead of
// the override each case means to exercise.
const CONFIG = {
    HUB_NETWORK: 'regtest',
    XCHAIN_PRICE_INDEXER_DB_HOST: '127.0.0.1',
    XCHAIN_PRICE_INDEXER_DB_NAME: 'XChain_BTC_Regtest_Indexer',
    XCHAIN_PRICE_INDEXER_DB_USER: 'reader',
    XCHAIN_PRICE_INDEXER_DB_PASS: 'unused-by-the-double',
};

// Supersession ships DISABLED (D2 threshold undecided), so the shipped config never
// publishes a derived value however good the fills are. Every case that means to
// exercise the derived branch must therefore turn it on explicitly, exactly as the
// regtest drill harness does - which is the point: a test that forgot would silently
// assert the carry-forward and prove nothing.
const DERIVING_CONFIG = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '0' };

// Real regtest row shapes (see the indexer's xchainPriceQuery suite): 5 XCHAIN for
// 0.011 BTC = 0.0022 BTC each.
const DISPENSE_ROW = { venue: 'dispense', action_index: 946, block_index: 2018,
                       xchain_amount: '5', coin_amount: '0.01100000' };

// Stand in for the indexer Database the source opens. Returns row sets by SQL, or
// throws to simulate an unreachable/erroring indexer.
function indexerDouble(rows = {}) {
    return function FakeDatabase() {
        return {
            pool: { end: async () => {} },
            async doQuery(sql) {
                if (rows.log) rows.log.push(sql);
                if (rows.throwOn && rows.throwOn(sql)) throw new Error('indexer unreachable');
                // Default tip: the indexer has reached the window top of the shared CTX.
                if (sql === INDEXER_TIP_SQL)  return rows.tip === undefined ? [{ tip: CTX.referenceHeight }] : rows.tip;
                if (sql === COIN_ID_SQL)      return rows.coin  === undefined ? [{ id: 1, coin: 'BTC' }] : rows.coin;
                if (sql === XCHAIN_TICK_SQL)  return rows.tick  === undefined ? [{ id: 1, tick: 'XCHAIN' }] : rows.tick;
                if (sql === DISPENSE_FILLS_SQL) return rows.dispenses || [];
                if (sql === DEX_FILLS_SQL)      return rows.dex || [];
                return [];
            },
        };
    };
}

// Stand in for the hub's own DB, answering the finalized-price lookups.
function hubDouble(finalized = {}) {
    // DB_METHODS first: the source calls a named query method, which routes its
    // statement through the doQuery below.
    return { ...DB_METHODS,
        queries: [],
        async doQuery(sql, args) {
            this.queries.push({ sql, args });
            const pair = args[0];
            return finalized[pair] ? [{ price: finalized[pair] }] : [];
        },
    };
}

function makeSource(rows, finalized, config = CONFIG) {
    const XchainPriceSource = proxyquire('../../../src/oracle/xchain_price_source.js', {
        '../db': indexerDouble(rows),
    });
    const hubDb = hubDouble(finalized);
    return { src: new XchainPriceSource(config, hubDb), hubDb };
}

const CTX = { round: 100, referenceHeight: 3000, btcUsdPrice: '100000.00000000', chainTipReliable: true };

function xchainPriceSourceTests(title, registerTests) {
    describe('XchainPriceSource: validator-side XCHAIN/USD @regression', function () {
        describe(title, registerTests);
    });
}


xchainPriceSourceTests('abstention (LOCAL failures) - the pair is omitted entirely', function () {
    it('abstains when no indexer database is configured', async function () {
        // A hub without price-capability indexer access is not broken; it just
        // does not submit this pair.
        const { src } = makeSource({}, {}, {});
        expect(src.isConfigured()).to.equal(false);
        expect(await src.derive(CTX)).to.equal(null);
    });

    it('abstains when the BTC chain-tip anchor is unreliable', async function () {
        // OracleRound falls back to currentBtcBlockHeight = currentRound when the
        // tip is unavailable. A round number is a small integer that would window
        // over an arbitrary early block range and derive a fee input from it.
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, {});
        expect(await src.derive({ ...CTX, chainTipReliable: false })).to.equal(null);
    });

    it('abstains when this hub has no local BTC/USD for the round', async function () {
        // The published value is on-chain XCHAIN/BTC x this validator's own
        // BTC/USD. With no BTC/USD there is nothing to multiply by.
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, {});
        expect(await src.derive({ ...CTX, btcUsdPrice: null })).to.equal(null);
        expect(await src.derive({ ...CTX, btcUsdPrice: '0' })).to.equal(null);
    });

    it('abstains, rather than carrying forward, when the indexer is unreachable', async function () {
        // THE distinction this module exists to get right. Carry-forward asserts
        // "I looked and the market was quiet"; a hub that could not look at all has
        // made no such observation and must stay silent.
        const { src } = makeSource({ throwOn: () => true }, { 'XCHAIN/USD': '3.00000000' });
        expect(await src.derive(CTX)).to.equal(null);
    });

    it('abstains when the XCHAIN ticker cannot be resolved', async function () {
        const { src } = makeSource({ tick: [] }, {});
        expect(await src.derive(CTX)).to.equal(null);
    });

    it('abstains when the reference height or round is malformed', async function () {
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, {});
        expect(await src.derive({ ...CTX, referenceHeight: -1 })).to.equal(null);
        expect(await src.derive({ ...CTX, referenceHeight: NaN })).to.equal(null);
        expect(await src.derive({ ...CTX, round: undefined })).to.equal(null);
    });

});
xchainPriceSourceTests('abstention (LOCAL failures) - the pair is omitted entirely', function () {

    // The D2 rule makes the bootstrap satoshi-denominated, which bought a new
    // abstention: with no finalized BTC/USD below the round there is no CONSENSUS
    // multiplier, and converting with the local price would give every validator a
    // different first XCHAIN/USD print to be slashed on. The old USD bootstrap
    // published straight through this gap; a satoshi-denominated one must not.
    it('abstains when the satoshi bootstrap has no consensus BTC/USD to convert with', async function () {
        const { src } = makeSource({}, {});
        expect(await src.derive(CTX)).to.equal(null);
    });

    // The other half of the same guard: it must STOP firing the moment a finalized
    // BTC/USD exists, or the pair would be bricked permanently rather than for one
    // round. A guard that only ever fires is indistinguishable from a broken pair.
    it('stops abstaining as soon as one BTC/USD has finalized', async function () {
        const { src } = makeSource({}, FINALIZED_BTC);
        const out = await src.derive(CTX);
        expect(out).to.not.equal(null);
        expect(out.price).to.equal(BOOTSTRAP_AT_100K);
    });

    it('never throws, so an abstention cannot take the 36 API pairs with it', async function () {
        const { src } = makeSource({ throwOn: (sql) => sql === COIN_ID_SQL }, {});
        let out;
        try { out = await src.derive(CTX); } catch (e) { expect.fail('derive() threw: ' + e.message); }
        expect(out).to.equal(null);
    });

});


xchainPriceSourceTests('carry-forward (publication is unconditional)', function () {
    it('publishes the bootstrap when the window is empty and nothing has finalized', async function () {
        // Pre-market: no fills, no history. Suppressing the pair here would age it
        // past the 1800s staleness bound within a few rounds.
        const { src } = makeSource({}, FINALIZED_BTC);
        const out = await src.derive(CTX);
        expect(out.coinPair).to.equal('XCHAIN/USD');
        expect(out.price).to.equal(BOOTSTRAP_AT_100K);
        expect(out.meta.derived).to.equal(false);
        expect(out.meta.carriedFrom).to.equal('bootstrap');
    });

    it('publishes the last finalized value in preference to the bootstrap', async function () {
        const { src } = makeSource({}, { 'XCHAIN/USD': '3.50000000' });
        const out = await src.derive(CTX);
        expect(out.price).to.equal('3.50000000');
        expect(out.meta.carriedFrom).to.equal('last-finalized');
    });

    it('reads the reference from rounds STRICTLY BELOW this one', async function () {
        // Rounds finalize asynchronously. "The newest row I happen to have" is a
        // race that would let two honest validators clamp against different
        // references and diverge past the co-sign band.
        const { src, hubDb } = makeSource({}, { 'XCHAIN/USD': '3.50000000' });
        await src.derive(CTX);
        const q = hubDb.queries.find(x => x.args[0] === 'XCHAIN/USD');
        expect(q.args[1]).to.equal(CTX.round);
        expect(q.sql).to.match(/round_number\s*<\s*\?/);
        expect(q.sql).to.match(/status\s*=\s*'finalized'/);
    });

});


xchainPriceSourceTests('indexer tip gate - a lagging indexer abstains instead of reading as a quiet market', function () {
    // The window top the source itself computes, never a hardcoded buffer.
    function windowTop(src) { return CTX.referenceHeight - src.confirmationBuffer; }

    it('abstains when the indexer tip is below the window top and the window is empty', async function () {
        const probe = makeSource({}, FINALIZED_BTC).src;
        const { src } = makeSource({ tip: [{ tip: windowTop(probe) - 1 }] }, FINALIZED_BTC);
        expect(await src.derive(CTX)).to.equal(null);
    });

    it('abstains on a partial window, even with fills present', async function () {
        const probe = makeSource({}, FINALIZED_BTC).src;
        const { src } = makeSource({ tip: [{ tip: windowTop(probe) - 1 }], dispenses: [DISPENSE_ROW] }, FINALIZED_BTC);
        expect(await src.derive(CTX)).to.equal(null);
    });

    it('abstains when the tip query returns no row or a null tip', async function () {
        expect(await makeSource({ tip: [] }, FINALIZED_BTC).src.derive(CTX)).to.equal(null);
        expect(await makeSource({ tip: [{ tip: null }] }, FINALIZED_BTC).src.derive(CTX)).to.equal(null);
    });

    it('proceeds when the tip sits exactly at the window top', async function () {
        const probe = makeSource({}, FINALIZED_BTC).src;
        const { src } = makeSource({ tip: [{ tip: windowTop(probe) }] }, FINALIZED_BTC);
        const out = await src.derive(CTX);
        expect(out).to.not.equal(null);
        expect(out.price).to.equal(BOOTSTRAP_AT_100K);
    });

    it('reads the tip before either fill query', async function () {
        const log = [];
        await makeSource({ log }, FINALIZED_BTC).src.derive(CTX);
        expect(log.indexOf(INDEXER_TIP_SQL)).to.be.at.least(0);
        expect(log.indexOf(INDEXER_TIP_SQL)).to.be.below(log.indexOf(DISPENSE_FILLS_SQL));
        expect(log.indexOf(INDEXER_TIP_SQL)).to.be.below(log.indexOf(DEX_FILLS_SQL));
    });

    it('skips the tip read for a window empty by chain youth and still carries forward', async function () {
        const log = [];
        const { src } = makeSource({ log, tip: [] }, FINALIZED_BTC);
        const out = await src.derive({ ...CTX, referenceHeight: src.confirmationBuffer });
        expect(out).to.not.equal(null);
        expect(log).to.not.include(INDEXER_TIP_SQL);
    });
});
