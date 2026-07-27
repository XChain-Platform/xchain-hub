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
 * XChain Hub - XCHAIN/USD derived price source (, spec step 2)
 *
 * Every other pair in a round comes from an exchange API. This one comes from the
 * chain: XCHAIN is listed nowhere, so its price is derived from realized fills in
 * the validator's OWN BTC indexer database (read-only), which makes it MORE
 * deterministic than the API pairs beside it rather than less. Two validators
 * computing the same round see byte-identical fill sets; only the final multiply by
 * each one's own BTC/USD varies, which is exactly the variance every existing pair
 * already has and which aggregation already resolves.
 *
 * Spec: claude/specs/XCHAIN_PRICE_DERIVATION_SPEC.md (§4 formula, §6 plumbing/taxonomy, §7 bootstrap)
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
 * few rounds and re-brick LTC/DOGE fees, which is the exact bug  exists to fix.
 * Abstention is reserved for "this hub cannot compute", never "the market was quiet".
 *
 * THE INDEXER DATABASE IS UNTRUSTED INPUT. Amounts are VARCHAR(250) that a wedged or
 * compromised indexer could fill with anything; parseability, positivity and the
 * PRICE_MAX bound are enforced before any value leaves this file.
 *
 ********************************************************************/

'use strict';

const Database = require('./db.js');
const bcmath   = require('./bcmath.js');
const { deriveXchainRate, referenceRateFromUsd, toUsd } = require('./xchainPrice.js');
const { getWindowFills } = require('./xchainPriceQuery.js');
const { PRICE_MAX, XCHAIN_PRICE_WINDOW_BLOCKS, XCHAIN_PRICE_CONFIRMATION_BUFFER,
        XCHAIN_PRICE_BOOTSTRAP_USD, XCHAIN_PRICE_MIN_BTC_VOLUME,
        DERIVED_PAIRS } = require('./constants.js');

// The pair this source produces. Taken from DERIVED_PAIRS rather than re-spelled, so
// the producer and the admission allow-list cannot drift into a pair that is
// computed but never accepted (or vice versa).
const XCHAIN_PAIR = DERIVED_PAIRS[0];
const BTC_PAIR    = 'BTC/USD';

// The gas token's reserved ticker. Canonical source is
// xchain-documentation/protocol/constants.js GAS_TICK; spelled here because the hub
// does not vendor that file, and pinned by test against the pair name above.
const GAS_TICK = 'XCHAIN';

// Latest FINALIZED price for a pair strictly BELOW a round number.
//
// Strictly below, and keyed on the round rather than "the newest row I have", because
// §4 requires the winsorization anchor to be consensus-derived: rounds finalize
// asynchronously, so two honest validators reading "latest finalized" at different
// instants would clamp band-edge fills against different references and diverge past
// the co-sign band, turning every thin round into a slashing lottery. Walking back
// from R-1 is deterministic for everyone.
const LAST_FINALIZED_SQL =
    `SELECT price FROM price_snapshots
     WHERE coin_pair = ? AND round_number < ? AND status = 'finalized' AND price IS NOT NULL
     ORDER BY round_number DESC LIMIT 1`;

class XchainPriceSource {

    /**
     * @param {object} config
     *   INDEXER_DB_HOST / _PORT / _NAME / _USER / _PASS - read-only access to the
     *     validator's own BTC indexer database. Absent = this hub cannot derive the
     *     pair and abstains from it (holding the price capability implies this
     *     access; a validator without it simply does not submit this pair).
     *   INDEXER_COIN - reference chain, 'BTC'. XCHAIN is BTC-only as a
     *     balance-bearing token, so this is not expected to vary.
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

        this.windowBlocks       = parseInt(config.XCHAIN_PRICE_WINDOW_BLOCKS) || XCHAIN_PRICE_WINDOW_BLOCKS;
        this.confirmationBuffer = Number.isFinite(parseInt(config.XCHAIN_PRICE_CONFIRMATION_BUFFER))
            ? parseInt(config.XCHAIN_PRICE_CONFIRMATION_BUFFER) : XCHAIN_PRICE_CONFIRMATION_BUFFER;
        this.bootstrapUsd       = config.XCHAIN_PRICE_BOOTSTRAP_USD || XCHAIN_PRICE_BOOTSTRAP_USD;

        // D2 supersession threshold: the BTC-side notional a window must carry before
        // the derived VWAP replaces the carry-forward. null = DISABLED, which is how
        // the constant ships (the value is an open operator decision), and disabled
        // means the pair publishes carry-forward every round no matter what trades.
        //
        // The override exists for regtest and e2e drills, which need supersession ON
        // at drill scale to prove the derived branch at all - a proof that silently
        // matched the carry-forward would prove nothing (§10 step 7). An empty or
        // unparseable override reads as "not set" and leaves the constant in force;
        // an explicit '0' is a real value meaning "any volume supersedes", which is a
        // deliberate drill setting and NOT the same as disabled.
        let volOverride = config.XCHAIN_PRICE_MIN_BTC_VOLUME;
        this.minBtcVolume = XCHAIN_PRICE_MIN_BTC_VOLUME;
        if (volOverride !== undefined && volOverride !== null && String(volOverride) !== '') {
            let parsed = Number(volOverride);
            if (Number.isFinite(parsed) && parsed >= 0) this.minBtcVolume = String(volOverride);
        }

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

    async _lastFinalized(pair, round) {
        if (!this.hubDb) return null;
        let rows = await this.hubDb.doQuery(LAST_FINALIZED_SQL, [pair, round]);
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

            // The anchor must be a real height. OracleRound falls back to
            // `currentBtcBlockHeight = currentRound` when the BTC tip is unavailable,
            // and a round number is a small integer that would silently window over an
            // arbitrary early block range. Deriving a fee input off that is worse than
            // publishing nothing, so an unreliable anchor is a LOCAL failure.
            if (ctx.chainTipReliable === false) {
                console.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR +
                    ' - BTC chain-tip fallback active, reference height is not a real height');
                return null;
            }
            let referenceHeight = Number(ctx.referenceHeight);
            if (!Number.isInteger(referenceHeight) || referenceHeight < 0) return null;

            let round = Number(ctx.round);
            if (!Number.isInteger(round) || round < 0) return null;

            // This round's own BTC/USD converts the on-chain rate into USD. Without it
            // there is nothing to multiply by, so abstain rather than invent one.
            let btcUsd = ctx.btcUsdPrice ? String(ctx.btcUsdPrice) : null;
            if (!btcUsd || !bcmath.bcgt(btcUsd, '0')) {
                console.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - no local ' + BTC_PAIR + ' this round');
                return null;
            }

            // Carry-forward value and winsorization anchor, both from rounds strictly
            // below this one so every validator resolves the same reference.
            let lastXchainUsd = await this._lastFinalized(XCHAIN_PAIR, round);
            let carryForward  = lastXchainUsd || this.bootstrapUsd;

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
            let refBtcUsd = await this._lastFinalized(BTC_PAIR, round);
            let refRate   = referenceRateFromUsd(bcmath, carryForward, refBtcUsd);

            let selection = await getWindowFills(this._db(), {
                referenceHeight:    referenceHeight,
                confirmationBuffer: this.confirmationBuffer,
                windowLength:       this.windowBlocks,
                gasTick:            GAS_TICK,
                coin:               this.coin,
            });

            // A selection failure is LOCAL (unreachable DB, unresolvable ticker or
            // coin). Abstain: publishing carry-forward here would assert "I looked and
            // the market was quiet" when in fact this hub could not look at all.
            if (!selection.ok) {
                console.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - ' + selection.error);
                return null;
            }

            let meta = {
                window:      selection.window,
                fillCount:   selection.fills.length,
                carriedFrom: lastXchainUsd ? 'last-finalized' : 'bootstrap',
            };

            // An EMPTY window is a defined state, not a failure: publish carry-forward
            // (§7). Suppressing the pair on a quiet market would age it past the 1800s
            // staleness bound and re-brick LTC/DOGE fees within a few rounds.
            let derived = selection.fills.length ? deriveXchainRate(bcmath, selection.fills, refRate) : null;
            if (!derived) {
                return this._entry(carryForward, Object.assign(meta, { derived: false }));
            }

            // D2 supersession gate. Below the threshold the window's trades are real
            // but too thin to be called a market, so the carry-forward stands.
            //
            // Stateless by design (§7): this is a pure function of THIS round's window,
            // with nothing persisted about previous rounds. A consecutive-rounds streak
            // requirement was considered and cut - the ~week-long window slides by about
            // one block per round, so any burst that clears the bar keeps clearing it for
            // roughly W blocks anyway, and persisted state is something restarts and
            // skipped rounds can split the fleet on.
            //
            // Measured pre-winsorize (totalCoin), so a clamped print cannot inflate the
            // evidence for its own admission.
            if (!this._volumeSupersedes(derived.totalCoin)) {
                return this._entry(carryForward, Object.assign(meta, {
                    derived:        false,
                    reason:         this.minBtcVolume === null
                        ? 'supersession disabled (D2 threshold undecided)'
                        : 'window volume below the supersession threshold',
                    btcVolume:      derived.totalCoin,
                    minBtcVolume:   this.minBtcVolume,
                    wouldHaveBeen:  derived.rate,
                }));
            }

            let usd = toUsd(bcmath, derived.rate, btcUsd);
            if (!usd) return this._entry(carryForward, Object.assign(meta, { derived: false, reason: 'usd leg unusable' }));

            // §10 step 6: everything needed to re-derive and audit this print after the
            // fact. §5's claim that manipulation is "visible" is only true if these are
            // recorded - rawXchainBtc beside xchainBtc is what makes a winsorized round
            // distinguishable from a quiet one, and btcVolume is what makes the
            // supersession decision reviewable rather than a bare yes/no.
            Object.assign(meta, {
                derived:      true,
                xchainBtc:    derived.rate,
                rawXchainBtc: derived.rawRate,
                usedFills:    derived.usedCount,
                clampedFills: derived.clampedCount,
                droppedFills: derived.droppedCount,
                totalXchain:  derived.totalXchain,
                btcVolume:    derived.totalCoin,
                minBtcVolume: this.minBtcVolume,
                refRate:      derived.refRate,
            });
            return this._entry(usd, meta);
        } catch (err) {
            // Never propagate: this pair is appended to a submission carrying 36
            // others, and a throw here would take the whole round's fetch down.
            console.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - ' +
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
    _volumeSupersedes(btcVolume) {
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
    _entry(price, meta) {
        let value;
        try {
            value = bcmath.bcformat(price, 8);
            if (!bcmath.bcgt(value, '0') || !bcmath.bclt(value, String(PRICE_MAX))) return null;
        } catch (e) {
            return null;
        }
        // sources: 1 - this hub derived it once from one place (its own chain data).
        // Unlike an API pair there is no second upstream to corroborate, and inventing
        // a higher count would mislead the federation single-source health signal.
        return { coinPair: XCHAIN_PAIR, price: value, sources: 1, meta: meta };
    }
}

module.exports = XchainPriceSource;
module.exports.XCHAIN_PAIR = XCHAIN_PAIR;
module.exports.GAS_TICK    = GAS_TICK;
module.exports.LAST_FINALIZED_SQL = LAST_FINALIZED_SQL;
