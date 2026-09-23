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

// constants.js declares W/K/bootstrap/threshold CONSENSUS-UNIFORM: a hub running
// different values computes a different XCHAIN/BTC leg and lands outside the
// co-sign deviation band. The overrides exist for regtest and e2e drills, and
// that restriction is code rather than an api.js comment, because a stray env var on
// a validator was a slashing lottery. Same enforced shape as the platform's other
// consensus-adjacent seams (OracleConsensus ORACLE_ALLOW_UNVERIFIED_PAIRS,
// XChainHub.oracleMaxAgeSeconds).
const OVERRIDES = {
    XCHAIN_PRICE_WINDOW_BLOCKS:       '10',
    XCHAIN_PRICE_CONFIRMATION_BUFFER: '0',
    XCHAIN_PRICE_BOOTSTRAP_SATS:      '5000',
    XCHAIN_PRICE_MIN_BTC_VOLUME:      '0',
};

function build(network) {
    const cfg = { ...CONFIG, ...OVERRIDES };
    if (network === undefined) delete cfg.HUB_NETWORK;
    else cfg.HUB_NETWORK = network;
    let logged = [];
    let orig = console.log;
    console.log = (...a) => logged.push(a.join(' '));
    let src;
    try { src = makeSource({}, FINALIZED_BTC, cfg).src; } finally { console.log = orig; }
    return { src, logged };
}

function expectPinned(src) {
    expect(src.windowBlocks, 'windowBlocks').to.equal(1000);
    expect(src.confirmationBuffer, 'confirmationBuffer').to.equal(6);
    expect(src.bootstrapXchainBtc, 'bootstrapXchainBtc').to.equal('0.00001000');
    expect(src.minBtcVolume, 'minBtcVolume').to.equal(null);
}
function xchainPriceSourceTests(title, registerTests) {
    describe('XchainPriceSource: validator-side XCHAIN/USD @regression', function () {
        describe(title, registerTests);
    });
}


xchainPriceSourceTests('ingestion bounds', function () {
    it('refuses a carried-forward value at or above PRICE_MAX', async function () {
        // A carried-forward value read out of a database is no more trusted than a
        // fetched one; the API sources bound theirs the same way.
        const { src } = makeSource({}, { 'XCHAIN/USD': String(PRICE_MAX) });
        expect(await src.derive(CTX)).to.equal(null);
    });

    it('ignores a non-positive finalized value and falls back to the bootstrap', async function () {
        const { src } = makeSource({}, { ...FINALIZED_BTC, 'XCHAIN/USD': '0' });
        const out = await src.derive(CTX);
        expect(out.price).to.equal(BOOTSTRAP_AT_100K);
        expect(out.meta.carriedFrom).to.equal('bootstrap');
    });

    it('abstains in the sub-ulp band the downstream gates round onto PRICE_MAX', function () {
        // Exact math admits this 8dp value; parseFloat rounds it to PRICE_MAX, so every
        // co-sign and ingest gate refuses it. The producer must refuse it first.
        const band = String(PRICE_MAX - 1) + '.99999999';
        expect(parseFloat(band), 'the band value rounds onto the ceiling').to.equal(PRICE_MAX);
        const { src } = makeSource({}, FINALIZED_BTC);
        expect(src.entry(band, {})).to.equal(null);
        expect(src.entry('0.05000000', {}).price).to.equal('0.05000000');
    });

    it('publishes at 8dp like every other pair', async function () {
        const { src } = makeSource({}, FINALIZED_BTC);
        expect((await src.derive(CTX)).price).to.match(/^\d+\.\d{8}$/);
    });

    it('names itself when the bound abstains (#3870)', async function () {
        // The bound is the LAST gate every emitted value crosses, so its abstention is
        // the one the operator most needs attributed. Every sibling abstention in the
        // module logs; a silent one drops the pair out of the round with no trace,
        // since OracleRound wraps the result in `if (entry)` with no else.
        const { src } = makeSource({}, { 'XCHAIN/USD': String(PRICE_MAX) });
        let warned = [];
        let orig = console.warn;
        console.warn = (...a) => warned.push(a.join(' '));
        let out;
        try { out = await src.derive(CTX); } finally { console.warn = orig; }
        expect(out).to.equal(null);
        expect(warned.some(w => /abstaining from XCHAIN\/USD.*ingestion bound/.test(w)),
            'the ingestion bound logged its abstention').to.be.true;
    });

});


xchainPriceSourceTests('consensus-uniform overrides are regtest-only', function () {

    it('honors all four on regtest', function () {
        const { src, logged } = build('regtest');
        expect(src.windowBlocks).to.equal(10);
        expect(src.confirmationBuffer).to.equal(0);
        // The honored path runs the sats through bcdiv, which hands back a mathjs
        // BigNumber; only the pinned fallback is the literal 8dp string.
        expect(String(src.bootstrapXchainBtc)).to.equal('0.00005');
        expect(src.minBtcVolume).to.equal('0');
        expect(logged.some(l => /IGNORED/.test(l)),
            'regtest must not warn about a hatch it honored').to.be.false;
    });

    it('ignores all four on mainnet and names each one it dropped', function () {
        const { src, logged } = build('mainnet');
        expectPinned(src);
        for (const key of Object.keys(OVERRIDES)) {
            expect(logged.some(l => l.includes(key) && /is set but IGNORED on mainnet/.test(l)),
                key + ' must log a set-but-IGNORED line').to.be.true;
        }
    });

    it('ignores all four on testnet', function () {
        expectPinned(build('testnet').src);
    });

    it('fails closed when the network is unset (standalone is not a bypass)', function () {
        const { src, logged } = build(undefined);
        expectPinned(src);
        expect(logged.some(l => /IGNORED on <unset>/.test(l)),
            'an unset network names itself in the warning').to.be.true;
    });

    it('stays silent off regtest when an override merely restates the pinned value', function () {
        // ConfigService bakes the host shell's XCHAIN_PRICE_* into the hub container on
        // every regenerate, so a validator carrying the pinned value would otherwise
        // warn at every boot about a divergence that does not exist.
        const cfg = { ...CONFIG, HUB_NETWORK: 'mainnet',
                      XCHAIN_PRICE_WINDOW_BLOCKS: '1000',
                      XCHAIN_PRICE_BOOTSTRAP_SATS: String(XCHAIN_PRICE_BOOTSTRAP_SATS) };
        let logged = [];
        let orig = console.log;
        console.log = (...a) => logged.push(a.join(' '));
        let src;
        try { src = makeSource({}, FINALIZED_BTC, cfg).src; } finally { console.log = orig; }
        expect(src.windowBlocks).to.equal(1000);
        expect(src.bootstrapXchainBtc).to.equal('0.00001000');
        expect(logged.some(l => /IGNORED/.test(l)),
            'a matching override is not a divergence').to.be.false;
    });

});

xchainPriceSourceTests('consensus-uniform overrides are regtest-only', function () {

    it('leaves the per-operator indexer credentials ungated', function () {
        // The INDEXER_DB_* keys are per-validator by design; gating them would take
        // every non-regtest hub off the pair entirely.
        const cfg = { ...CONFIG, HUB_NETWORK: 'mainnet' };
        const { src } = makeSource({}, FINALIZED_BTC, cfg);
        expect(src.isConfigured()).to.equal(true);
        expect(src.host).to.equal('127.0.0.1');
    });

});

