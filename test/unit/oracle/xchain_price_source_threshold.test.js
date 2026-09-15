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


const FINALIZED_BTC = { 'BTC/USD': '100000.00000000' };
const BOOTSTRAP_AT_100K = '1.00000000';
const { COIN_ID_SQL, XCHAIN_TICK_SQL, DISPENSE_FILLS_SQL, DEX_FILLS_SQL } =
    require('../../../src/xchainPriceQuery.js');


const CONFIG = {
    HUB_NETWORK: 'regtest',
    XCHAIN_PRICE_INDEXER_DB_HOST: '127.0.0.1',
    XCHAIN_PRICE_INDEXER_DB_NAME: 'XChain_BTC_Regtest_Indexer',
    XCHAIN_PRICE_INDEXER_DB_USER: 'reader',
    XCHAIN_PRICE_INDEXER_DB_PASS: 'unused-by-the-double',
};


const DERIVING_CONFIG = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '0' };


const DISPENSE_ROW = { venue: 'dispense', action_index: 946, block_index: 2018,
                       xchain_amount: '5', coin_amount: '0.01100000' };


function indexerDouble(rows = {}) {
    return function FakeDatabase() {
        return {
            pool: { end: async () => {} },
            async doQuery(sql) {
                if (rows.throwOn && rows.throwOn(sql)) throw new Error('indexer unreachable');
                if (sql === COIN_ID_SQL)      return rows.coin  === undefined ? [{ id: 1, coin: 'BTC' }] : rows.coin;
                if (sql === XCHAIN_TICK_SQL)  return rows.tick  === undefined ? [{ id: 1, tick: 'XCHAIN' }] : rows.tick;
                if (sql === DISPENSE_FILLS_SQL) return rows.dispenses || [];
                if (sql === DEX_FILLS_SQL)      return rows.dex || [];
                return [];
            },
        };
    };
}


function hubDouble(finalized = {}) {


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

const FINALIZED = { 'XCHAIN/USD': '220.00000000', 'BTC/USD': '100000.00000000' };
function xchainPriceSourceTests(title, registerTests) {
    describe('XchainPriceSource: validator-side XCHAIN/USD @regression', function () {
        describe(title, registerTests);
    });
}


xchainPriceSourceTests('derivation', function () {
    it('publishes XCHAIN/BTC x this round own BTC/USD from a real fill', async function () {
        // 0.011 BTC / 5 XCHAIN = 0.0022 BTC each; x 100000 USD/BTC = 220 USD.
        // Reference 0.0022 BTC (= 220 USD / 100000) so nothing is winsorized.
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, { 'XCHAIN/USD': '220.00000000', 'BTC/USD': '100000.00000000' }, DERIVING_CONFIG);
        const out = await src.derive(CTX);
        expect(out.price).to.equal('220.00000000');
        expect(out.meta.derived).to.equal(true);
        expect(out.meta.xchainBtc).to.equal('0.00220000');
        expect(out.meta.usedFills).to.equal(1);
        expect(out.meta.clampedFills).to.equal(0);
    });

    it('reports one source, not a fabricated corroboration count', async function () {
        // There is no second upstream for a derived pair; claiming otherwise would
        // mislead the federation single-source health signal.
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, { 'XCHAIN/USD': '220.00000000', 'BTC/USD': '100000.00000000' }, DERIVING_CONFIG);
        expect((await src.derive(CTX)).sources).to.equal(1);
    });

    it('winsorizes a fill far outside the band instead of following it', async function () {
        // A self-dealt fill at 100x the reference is the §5 attack. It must be
        // clamped to the band edge, and the meta must say so.
        const wild = { ...DISPENSE_ROW, coin_amount: '1.10000000' };   // 100x the rate
        const { src } = makeSource({ dispenses: [wild] }, { 'XCHAIN/USD': '220.00000000', 'BTC/USD': '100000.00000000' }, DERIVING_CONFIG);
        const out = await src.derive(CTX);
        expect(out.meta.clampedFills).to.equal(1);
        // Clamped to ref x 2 = 0.0044 BTC -> 440 USD, not the 22000 USD it asked for.
        expect(out.price).to.equal('440.00000000');
    });

});


// D2: the volume gate that decides whether a real window is a real MARKET.
xchainPriceSourceTests('the supersession threshold (D2)', function () {

    it('ships DISABLED: a perfectly good fill still publishes the carry-forward', async function () {
        // The shipped constant is null because the threshold value is an open
        // operator decision, and guessing it permissively lets whoever wash-trades
        // first set the first market print. Disabled is safe, not broken: the pair
        // still publishes every round, it just publishes the value the federation
        // already agreed on.
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, FINALIZED);
        const out = await src.derive(CTX);
        expect(out.price).to.equal('220.00000000');           // carried, not derived
        expect(out.meta.derived).to.equal(false);
        expect(out.meta.reason).to.match(/supersession disabled/);
    });

    it('still reports what it WOULD have published, so the gate is auditable', async function () {
        // Without this a disabled threshold is indistinguishable from a broken
        // derivation: both just print the carry-forward forever.
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, FINALIZED);
        const out = await src.derive(CTX);
        expect(out.meta.wouldHaveBeen).to.equal('0.00220000');
        expect(out.meta.btcVolume).to.equal('0.01100000');
    });

    it('supersedes once the window clears the threshold', async function () {
        const cfg = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '0.01' };
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, FINALIZED, cfg);   // 0.011 BTC
        const out = await src.derive(CTX);
        expect(out.meta.derived).to.equal(true);
        expect(out.meta.btcVolume).to.equal('0.01100000');
    });

    it('holds the carry-forward when the window is just under the threshold', async function () {
        const cfg = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '0.02' };
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, FINALIZED, cfg);
        const out = await src.derive(CTX);
        expect(out.meta.derived).to.equal(false);
        expect(out.meta.reason).to.match(/below the supersession threshold/);
        expect(out.price).to.equal('220.00000000');
    });

    it('treats the threshold as inclusive: exactly at the bar supersedes', async function () {
        // D2 says "at or above". An exclusive comparison would make a threshold set
        // to the observed volume mysteriously never fire.
        const cfg = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '0.011' };
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, FINALIZED, cfg);
        expect((await src.derive(CTX)).meta.derived).to.equal(true);
    });

});

xchainPriceSourceTests('the supersession threshold (D2)', function () {

    it('measures PRE-winsorize, so a clamped print cannot buy its own admission', async function () {
        // The attack this ordering blocks: a fill whose rate is clamped to the band
        // edge still contributes its real BTC to the volume count, not the inflated
        // band-edge notional. Here 1.1 BTC really moved, so the bar is genuinely
        // cleared - but the PRICE is still held at the band edge.
        const wild = { ...DISPENSE_ROW, coin_amount: '1.10000000' };
        const cfg = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '1' };
        const { src } = makeSource({ dispenses: [wild] }, FINALIZED, cfg);
        const out = await src.derive(CTX);
        expect(out.meta.btcVolume).to.equal('1.10000000');
        expect(out.meta.derived).to.equal(true);
        expect(out.price).to.equal('440.00000000');       // clamped, not 22000
    });

    it('fails closed on an unparseable threshold rather than publishing anyway', async function () {
        // An override the arithmetic cannot read must not silently become "0" and
        // turn supersession on for a venue that never asked for it.
        const cfg = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: 'not-a-number' };
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, FINALIZED, cfg);
        const out = await src.derive(CTX);
        expect(out.meta.derived).to.equal(false);
        expect(out.meta.reason).to.match(/supersession disabled/);
    });

    it('carries forward rather than anchoring the band on its own local price', async function () {
        // §4: the winsorization reference must be consensus-derived, never local.
        // Here XCHAIN/USD has finalized but BTC/USD has NOT, so there is no
        // consensus anchor. An earlier cut fell back to this round's own BTC/USD,
        // which differs per validator by construction, so a band-edge fill would
        // clamp differently on each one and they would publish different values
        // straight into deviation slashing. With fills present and supersession
        // ENABLED, the only safe answer is the carry-forward.
        const cfg = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '0' };
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] },
            { 'XCHAIN/USD': '220.00000000' }, cfg);        // no BTC/USD finalized
        const out = await src.derive(CTX);
        expect(out.meta.derived).to.equal(false);
        expect(out.price).to.equal('220.00000000');
    });

    it('reads an empty override as "not set", leaving the shipped constant in force', async function () {
        // api.js passes '' for every unset XCHAIN_PRICE_* env, so '' MUST mean unset.
        const cfg = { ...CONFIG, XCHAIN_PRICE_MIN_BTC_VOLUME: '' };
        const { src } = makeSource({ dispenses: [DISPENSE_ROW] }, FINALIZED, cfg);
        expect((await src.derive(CTX)).meta.derived).to.equal(false);
    });

});

