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

const { XCHAIN_PRICE_BOOTSTRAP_SATS, PRICE_MAX } = require('../../src/constants.js');

// D2 (2026-08-03) is satoshi-denominated, so the bootstrap only becomes a USD
// price once a CONSENSUS BTC/USD exists to convert it with. Every carry-forward
// case therefore has to seed one. At 1000 sat and BTC/USD 100000 the arithmetic
// is exact and needs no rounding: 0.00001000 x 100000 = 1.00000000.
const FINALIZED_BTC = { 'BTC/USD': '100000.00000000' };
const BOOTSTRAP_AT_100K = '1.00000000';
const { COIN_ID_SQL, XCHAIN_TICK_SQL, DISPENSE_FILLS_SQL, DEX_FILLS_SQL } =
    require('../../src/xchainPriceQuery.js');

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

// Stand in for the hub's own DB, answering the finalized-price lookups.
function hubDouble(finalized = {}) {
    return {
        queries: [],
        async doQuery(sql, args) {
            this.queries.push({ sql, args });
            const pair = args[0];
            return finalized[pair] ? [{ price: finalized[pair] }] : [];
        },
    };
}

function makeSource(rows, finalized, config = CONFIG) {
    const XchainPriceSource = proxyquire('../../src/XchainPriceSource.js', {
        './db.js': indexerDouble(rows),
    });
    const hubDb = hubDouble(finalized);
    return { src: new XchainPriceSource(config, hubDb), hubDb };
}

const CTX = { round: 100, referenceHeight: 3000, btcUsdPrice: '100000.00000000', chainTipReliable: true };

describe('XchainPriceSource: validator-side XCHAIN/USD @regression', function () {

    describe('abstention (LOCAL failures) - the pair is omitted entirely', function () {
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

        // D2 (2026-08-03) made the bootstrap satoshi-denominated, which bought a new
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

    describe('carry-forward (publication is unconditional)', function () {
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

    describe('derivation', function () {
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
    describe('the supersession threshold (D2)', function () {
        const FINALIZED = { 'XCHAIN/USD': '220.00000000', 'BTC/USD': '100000.00000000' };

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

    describe('ingestion bounds', function () {
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

    describe('consensus-uniform overrides are regtest-only', function () {
        // constants.js declares W/K/bootstrap/threshold CONSENSUS-UNIFORM: a hub running
        // different values computes a different XCHAIN/BTC leg and lands outside the
        // co-sign deviation band. The overrides exist for regtest and e2e drills, and
        // that restriction is code rather than an api.js comment, because a stray env var on
        // a validator was a slashing lottery. Same enforced shape as the platform's other
        // consensus-adjacent seams (OracleConsensus ORACLE_ALLOW_UNVERIFIED_PAIRS,
        // XChainHub._oracleMaxAgeSeconds).
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

        it('leaves the per-operator indexer credentials ungated', function () {
            // The INDEXER_DB_* keys are per-validator by design; gating them would take
            // every non-regtest hub off the pair entirely.
            const cfg = { ...CONFIG, HUB_NETWORK: 'mainnet' };
            const { src } = makeSource({}, FINALIZED_BTC, cfg);
            expect(src.isConfigured()).to.equal(true);
            expect(src.host).to.equal('127.0.0.1');
        });
    });
});
