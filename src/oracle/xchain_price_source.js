/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - XCHAIN/USD derived price source
 *
 * Every other pair in a round comes from an exchange API. This one comes from the
 * chain: XCHAIN is listed nowhere, so its price is derived from realized fills in
 * the validator's OWN BTC indexer database (read-only), which makes it MORE
 * deterministic than the API pairs beside it rather than less. Two validators
 * computing the same round see byte-identical fill sets; only the final multiply by
 * each one's own BTC/USD varies, which is exactly the variance every existing pair
 * already has and which aggregation already resolves.
 *
 * The arithmetic and the row selection are NOT here. They are xchainPrice.js and
 * xchainPriceQuery.js, vendored byte-identically from xchain-indexer and guarded by
 * test/unit/XchainPriceVendorParity.test.js. This file is only the wiring: open the
 * connection, resolve the round's window and reference, hand rows to the formula,
 * and decide abstain-vs-publish. Keeping it that way is what lets the consensus math
 * live in one auditable place instead of two.
 *
 * FAILURE TAXONOMY (§6), and the distinction is load-bearing:
 *
 *   LOCAL failure  -> ABSTAIN from this pair only (return null). Indexer
 *                     unreachable, query error, ambiguous tick lookup, unreliable
 *                     chain-tip anchor. The other pairs in the round are untouched;
 *                     the aggregator treats a pair short of quorum as skipped for
 *                     that pair, never as a failed round for its neighbours.
 *   ROW CONTENT    -> EXCLUDE the row and continue. Handled inside the formula,
 *                     not here. Fill rows are consensus data, identical on every
 *                     honest indexer, so the exclusion is identical everywhere.
 *                     Abstaining on a bad row instead would let ONE crafted on-chain
 *                     fill freeze the pair federation-wide, forever.
 *
 * PUBLICATION IS UNCONDITIONAL (§7). An empty window is not an abstention: it
 * publishes the carry-forward value (last finalized, else the bootstrap). Abstaining
 * on a quiet market would let the pair age past the 1800s staleness bound within a
 * few rounds and re-brick LTC/DOGE fees, which is the exact bug this file exists to fix.
 * Abstention is reserved for "this hub cannot compute", never "the market was quiet".
 *
 * THE INDEXER DATABASE IS UNTRUSTED INPUT. Amounts are VARCHAR(250) that a wedged or
 * compromised indexer could fill with anything; parseability, positivity and the
 * PRICE_MAX bound are enforced before any value leaves this file.
 *
 * Parts live beside this file in xchain_price_source/: pairs.js (the pair and
 * ticker names), derivation_params.js (the regtest-only overrides) and
 * derive_steps.js (the ordered steps of derive, mixed onto the prototype).
 *
 ********************************************************************/

'use strict';

const Database = require('../db');
const bcmath   = require('../bcmath.js');
const { referenceRateFromUsd } = require('../xchainPrice.js');
const { getLogger } = require('../observability');
const logger = getLogger();
const { PRICE_MAX } = require('../constants.js');
const { XCHAIN_PAIR, BTC_PAIR, GAS_TICK } = require('./xchain_price_source/pairs.js');
const { resolveDerivationParams } = require('./xchain_price_source/derivation_params.js');
const deriveSteps = require('./xchain_price_source/derive_steps.js');

class XchainPriceSource {

    /**
     * @param {object} config
     *   INDEXER_DB_HOST / _PORT / _NAME / _USER / _PASS - read-only access to the
     *     validator's own BTC indexer database. Absent = this hub cannot derive the
     *     pair and abstains from it (holding the price capability implies this
     *     access; a validator without it simply does not submit this pair).
     *   INDEXER_COIN - reference chain, 'BTC'. XCHAIN is BTC-only as a
     *     balance-bearing token, so this is not expected to vary.
     *   HUB_NETWORK - the api.js-validated deployment network. It gates the four
     *     CONSENSUS-UNIFORM derivation overrides (xchain_price_source/derivation_params.js):
     *     they are honored only on regtest, and set-but-IGNORED (with a warning) anywhere else.
     *   XCHAIN_PRICE_WINDOW_BLOCKS / _CONFIRMATION_BUFFER / _BOOTSTRAP_SATS /
     *     _MIN_BTC_VOLUME - regtest and e2e-drill overrides of the constants.js pins.
     * @param {object} hubDb  the hub's own Database, for the finalized-price reads
     */
    constructor(config = {}, hubDb = null) {
        this.hubDb  = hubDb;
        this.coin   = config.XCHAIN_PRICE_INDEXER_DB_COIN || 'BTC';
        this.host   = config.XCHAIN_PRICE_INDEXER_DB_HOST || '';
        this.port   = parseInt(config.XCHAIN_PRICE_INDEXER_DB_PORT) || 3306;
        this.dbName = config.XCHAIN_PRICE_INDEXER_DB_NAME || '';
        this.user   = config.XCHAIN_PRICE_INDEXER_DB_USER || '';
        this.pass   = config.XCHAIN_PRICE_INDEXER_DB_PASS || '';

        // The four CONSENSUS-UNIFORM derivation parameters: the constants.js pins,
        // or an override honored on regtest only (rationale in derivation_params.js).
        let params = resolveDerivationParams(config);
        this.windowBlocks       = params.windowBlocks;
        this.confirmationBuffer = params.confirmationBuffer;
        this.bootstrapXchainBtc = params.bootstrapXchainBtc;
        this.minBtcVolume       = params.minBtcVolume;

        // Lazily opened: constructing a pool for a hub that will never derive the
        // pair would hold idle connections against the indexer for nothing.
        this.indexerDb = null;
    }

    // Whether this hub has been given indexer access at all. A hub without it is not
    // broken; it just does not submit this pair (§6).
    isConfigured() {
        return Boolean(this.host && this.dbName && this.user);
    }

    _db() {
        if (!this.indexerDb)
            this.indexerDb = new Database(this.host, this.port, this.dbName, this.user, this.pass);
        return this.indexerDb;
    }

    async close() {
        if (this.indexerDb && this.indexerDb.pool) {
            try { await this.indexerDb.pool.end(); } catch (e) { /* shutdown path */ }
        }
        this.indexerDb = null;
    }

    // Latest FINALIZED price for a pair strictly below `round`: the consensus-derived
    // winsorization anchor (db.getLatestFinalizedPriceBelowRound records why it is keyed
    // on the round rather than on the newest row this hub holds).
    async lastFinalized(pair, round) {
        if (!this.hubDb) return null;
        let rows = await this.hubDb.getLatestFinalizedPriceBelowRound(pair, round);
        if (!rows || !rows.length) return null;
        let v = String(rows[0].price);
        try { return bcmath.bcgt(v, '0') ? v : null; } catch (e) { return null; }
    }

    /**
     * Derive this round's XCHAIN/USD.
     *
     * @param {object} ctx
     *   @param {number}  ctx.round             the round being built
     *   @param {number}  ctx.referenceHeight   H, the round's BTC reference height
     *   @param {string}  ctx.btcUsdPrice       this hub's own BTC/USD for THIS round
     *   @param {boolean} ctx.chainTipReliable  false when OracleRound fell back to
     *                                          using the round number as the anchor
     * @returns {object|null} { coinPair, price, sources, meta } to append to the
     *   submission, or null to abstain from this pair (never throws: an abstention
     *   must not disturb the 36 API pairs travelling in the same round).
     */
    async derive(ctx = {}) {
        try {
            if (!this.isConfigured()) return null;

            // Anchor height, round number and local BTC/USD; null means abstain.
            let inputs = this.readDeriveContext(ctx);
            if (!inputs) return null;
            let { referenceHeight, round, btcUsd } = inputs;

            // Carry-forward value and winsorization anchor, both from rounds strictly
            // below this one so every validator resolves the same reference.
            let lastXchainUsd = await this.lastFinalized(XCHAIN_PAIR, round);

            // The band is applied in BTC terms, the units the fills are quoted in, so
            // the anchor is converted with the SAME round's BTC/USD it was published
            // against - R-1's finalized BTC/USD, not this round's local one.
            //
            // NO FALLBACK TO THE LOCAL PRICE, deliberately. An earlier cut read
            // `refBtcUsd || btcUsd`, which contradicted the sentence above and
            // reintroduced exactly the divergence §4 exists to prevent: with no
            // finalized BTC/USD below this round, every validator would anchor the
            // band on its OWN API price, those differ by construction (it is why the
            // aggregation exists), and a fill near a band edge would clamp differently
            // per validator - publishing different values into deviation slashing.
            //
            // Null here is a DEFINED state, not an error: referenceRateFromUsd returns
            // null, deriveXchainRate then returns null, and the caller carries forward.
            // That is deterministic for everyone, because "has any BTC/USD finalized
            // below round R" is consensus data, identical on every honest hub. It only
            // arises before the federation's first BTC/USD finalization.
            let refBtcUsd = await this.lastFinalized(BTC_PAIR, round);

            let carryForward = this.resolveCarryForward(lastXchainUsd, refBtcUsd, round);
            if (!carryForward) return null;

            let refRate = referenceRateFromUsd(bcmath, carryForward, refBtcUsd);

            let selection = await this.findWindowFills(referenceHeight);
            if (!selection) return null;

            return this.entryFromWindow(selection, {
                carryForward:  carryForward,
                lastXchainUsd: lastXchainUsd,
                refRate:       refRate,
                btcUsd:        btcUsd,
            });
        } catch (err) {
            // Never propagate: this pair is appended to a submission carrying 36
            // others, and a throw here would take the whole round's fetch down.
            logger.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - ' +
                ((err && err.message) || err));
            return null;
        }
    }

    // Whether this window's BTC notional clears the D2 supersession threshold.
    //
    // Fails CLOSED on anything it cannot evaluate: an unparseable volume holds the
    // carry-forward rather than publishing a market observation off a number the
    // arithmetic could not read. Closed is the safe direction because the
    // carry-forward is always a value the federation already agreed on.
    volumeSupersedes(btcVolume) {
        if (this.minBtcVolume === null) return false;   // disabled: never supersede
        try {
            return bcmath.bcgte(btcVolume, String(this.minBtcVolume));
        } catch (e) {
            return false;
        }
    }

    // Final ingestion bound, applied to every value this file emits whether derived or
    // carried forward. The API sources bound their values the same way for the same
    // reason: garbage must never enter a round, and a carried-forward value read out
    // of a database is no more trusted than a fetched one.
    entry(price, meta) {
        let value;
        try {
            value = bcmath.bcformat(price, 8);
            if (!bcmath.bcgt(value, '0') || !bcmath.bclt(value, String(PRICE_MAX))) {
                logger.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - computed value ' +
                    price + ' failed the ingestion bound (0 < value < ' + PRICE_MAX + ')');
                return null;
            }
        } catch (e) {
            logger.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - ingestion bound threw on value ' +
                price + ' - ' + ((e && e.message) || e));
            return null;
        }
        // sources: 1 - this hub derived it once from one place (its own chain data).
        // Unlike an API pair there is no second upstream to corroborate, and inventing
        // a higher count would mislead the federation single-source health signal.
        return { coinPair: XCHAIN_PAIR, price: value, sources: 1, meta: meta };
    }
}

// The ordered steps of derive, mixed onto the prototype so the class keeps one
// method surface for callers and prototype reads.
Object.assign(XchainPriceSource.prototype, deriveSteps);

module.exports = Object.assign(XchainPriceSource, {
    XCHAIN_PAIR,
    GAS_TICK
});
