/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Hub - Price Reads and Fee Quotes
 *
 * What this hub answers about oracle prices: the stored snapshots and their
 * per-round presence, the staleness bound a quote must clear, and the fee
 * quote priced off the XCHAIN rate.
 *
 ********************************************************************/

const coins = require('../coins');
const presence = require('../lib/oracle_round_presence.js');
const { bcmul, bcdiv } = require('../bcmath.js');
const mathjs = require('mathjs');
const hubConfig = require('../config');
const { getLogger } = require('../observability');
const logger = getLogger();

// A configs row that disagrees with the pinned bundle is INERT, never an
// override, so the only thing to do with one is tell the operator.
async function warnInertChainRows(hub, chain, network, gasSchedule, gasPrice) {
    // Chain-row divergence check, NOT an override layer. The indexer excludes
    // GAS_PRICE and GAS_SCHEDULE from its hub overlay by a consensus rule
    // (XChainIndexer._mergeHubParams: both lists are empty on every network, because
    // these feed block-hashed state and a live-polled consensus param forks the
    // federation), so a row applied here would move the QUOTE and never the fee the
    // indexer accepts. A wallet pre-flighting the quote would then broadcast an
    // underpaid action whose native-coin fee output is not refundable. Read the row
    // only to tell the operator it is inert. The configs tree keys coins by FULL
    // name and db.getConfig does not normalize, so the ticker must be mapped.
    let overrideKey = coins.COIN_FULL_NAME[chain] || chain;
    try {
        let chainCfg = await hub.db.getConfig(overrideKey, network, 'chain');
        if (chainCfg && chainCfg.GAS_PRICE && String(chainCfg.GAS_PRICE) !== gasPrice) {
            hub.warnFeeConfigInert(overrideKey, network, 'GAS_PRICE',
                String(chainCfg.GAS_PRICE), gasPrice);
        }
        if (chainCfg && chainCfg.GAS_SCHEDULE) {
            let sched = null;
            try { sched = JSON.parse(chainCfg.GAS_SCHEDULE); } catch (_) { /* malformed blob */ }
            // Any key that differs from the pinned schedule diverges, and so does a key
            // the pinned schedule does not carry at all (it would have invented an action).
            if (sched && typeof sched === 'object'
                && Object.keys(sched).some((k) => String(sched[k]) !== String(gasSchedule[k]))) {
                hub.warnFeeConfigInert(overrideKey, network, 'GAS_SCHEDULE',
                    chainCfg.GAS_SCHEDULE, 'the pinned per-chain schedule');
            }
        }
    } catch (_) { /* config store unavailable; the pinned bundle is the answer anyway */ }
}

// The quote itself, at the exactly-8-decimal shape consumers and the indexer
// fee charging expect.
function buildFeeQuote(action, chain, gasCost, gasPrice, xchainAmount, xchainUsdStr, coinPrice) {
    // Exactly 8 decimals, trailing zeros preserved, matching the toFixed(8) shape the
    // consumer tests and the indexer's fee charging expect.
    const fmt8 = (v) => mathjs.format(mathjs.bignumber(String(v)), {notation: 'fixed', precision: 8});

    let result = {
        action:       action,
        chain:        chain,
        gasCost:      gasCost,
        gasPrice:     fmt8(gasPrice),
        xchainAmount: fmt8(xchainAmount),
        xchainUsd:    fmt8(xchainUsdStr)
    };

    if (coinPrice && coinPrice.price) {
        let coinUsdStr = coinPrice.price;
        if (parseFloat(coinUsdStr) > 0) {
            let feeUsd           = bcmul(xchainAmount, xchainUsdStr, 8);
            let nativeCoinAmount = bcdiv(feeUsd, coinUsdStr, 8);

            result.feeUsd           = fmt8(feeUsd);
            result.coinUsd          = fmt8(coinUsdStr);
            result.nativeCoinAmount = fmt8(nativeCoinAmount);
            result.nativeCoin       = chain;
        }
    }

    return result;
}

class Prices {

    // status: optional. Default 'finalized' (the historical contract; fee and price
    // consumers must never see skipped/disputed rows). 'all' adds skipped (the round
    // produced no usable price for the pair) and disputed (reorg-retracted) rows so
    // health consumers see failure states instead of silently falling back to an older
    // finalized round.
    async getPriceSnapshots(limit, status) {
        if (status === 'all') return await this.db.findPriceSnapshotsAnyStatus(limit || 50);
        return await this.db.findPriceSnapshotsFinalized(limit || 50);
    }

    // Per-round PRESENCE over a range of oracle rounds: for each round,
    // did this hub record it at all, and with what outcome class. getpricesnapshots
    // returns the rows a hub HAS, so a hub holding nothing for a round is
    // indistinguishable there from a hub asked about a round that never happened;
    // this answers over an explicit range, so absence is a reported value.
    //
    // Range resolution: an omitted to_round anchors on this hub's highest recorded
    // round (deliberately NOT the current wall-clock round: the anchor is then a
    // fact about stored data, and a hub whose newest rounds are all missing reports
    // a lower to_round, which is itself the divergence signal). Callers comparing
    // hubs should pass both bounds so every hub answers about the same rounds.
    async getOracleRoundPresence(fromRound, toRound, limit) {
        let lim = parseInt(limit, 10);
        if (!Number.isFinite(lim) || lim <= 0) lim = presence.DEFAULT_RANGE;
        if (lim > presence.MAX_RANGE) lim = presence.MAX_RANGE;

        let to = parseInt(toRound, 10);
        if (!Number.isFinite(to)) {
            let top = await this.db.getPriceSnapshotsMaxRoundNumber();
            to = (top && top[0] && top[0].max_round != null) ? Number(top[0].max_round) : null;
            // No price_snapshots rows at all: an empty range, not a fabricated one.
            if (to === null) return { from_round: null, to_round: null, rounds: [], missing: [], digest: null };
        }
        let from = parseInt(fromRound, 10);
        if (!Number.isFinite(from)) from = to - (lim - 1);
        if (from < 0) from = 0;
        if (to < from) to = from;
        // Clamp the span the caller asked for, never the caller's own bounds
        // silently: from wins, so an explicit from_round is always honoured.
        if (to - from + 1 > presence.MAX_RANGE) to = from + presence.MAX_RANGE - 1;

        let rows = await this.db.findPriceSnapshotsBetweenRounds(from, to);
        let summary = presence.summarizeRoundPresence(rows, from, to);
        return { from_round: from, to_round: to, ...summary };
    }

    // Oracle price staleness bound in seconds, mirroring the indexer's
    // ORACLE_MAX_PRICE_AGE_SECONDS so advisory quotes reject the rounds the fee gate does.
    // Precedence: a regtest-only p2pConfig/env override (where 0 disables the bound),
    // else the pinned registry value.
    //
    // Regtest-gated because the key is consensus-pinned: consensusSubset() (coins/index.js)
    // content-hashes it into CONSENSUS_CONFIG_PIN, and the indexer reads only the pinned
    // bundle with no override path of its own. An override honored on mainnet or testnet
    // therefore detaches this hub's fee quotes and its getoraclesubmissions
    // oracleMaxPriceAgeSeconds field from the bound they claim to mirror, quoting rounds the
    // fleet's fee gate rejects (or refusing rounds it accepts). Same rule and warning shape
    // as the platform's other consensus-adjacent seams (coins/index.js resolveFeeDestination,
    // OracleConsensus ORACLE_ALLOW_UNVERIFIED_PAIRS); standalone mode, where network is '',
    // fails closed to the pinned value for the same reason those do.
    oracleMaxAgeSeconds(coinPair) {
        let raw = (this.p2pConfig && this.p2pConfig.ORACLE_MAX_PRICE_AGE_SECONDS != null)
            ? this.p2pConfig.ORACLE_MAX_PRICE_AGE_SECONDS
            : hubConfig.ORACLE_MAX_PRICE_AGE_SECONDS;
        let v = parseInt(raw, 10);
        if (!Number.isFinite(v)) return this.registryOracleMaxAge(coinPair);
        if (this.network === 'regtest') return v;
        let pinned = this.registryOracleMaxAge(coinPair);
        // Warned once per hub, not per call: this resolves on every getprice, every fee
        // quote and every health poll, so a per-call line would bury the log.
        if (v !== pinned && !this._warnedOracleMaxAgeOverride) {
            this._warnedOracleMaxAgeOverride = true;
            logger.info('WARNING: ORACLE_MAX_PRICE_AGE_SECONDS=' + v + ' is set but IGNORED on ' +
                (this.network || '<unset>') + '; using the consensus-pinned bound (' + pinned + '). ' +
                'To change the staleness gate, change the pinned coin bundle.');
        }
        return pinned;
    }

    // The consensus-pinned ORACLE_MAX_PRICE_AGE_SECONDS for the pair, from the canonical
    // coin registry. The pair's base tick selects the coin; an unknown pair or network
    // falls back to BTC so no literal copy of the pinned constant lives here.
    registryOracleMaxAge(coinPair) {
        let network = this.network || 'mainnet';
        let baseTick = String(coinPair || '').split('/')[0];
        let candidates = [[baseTick, network], ['BTC', network], ['BTC', 'mainnet']];
        for (let [tick, net] of candidates) {
            try {
                let cfg = coins.getCoinConfig(tick, net);
                let age = Number(cfg && cfg.ORACLE_MAX_PRICE_AGE_SECONDS);
                if (Number.isFinite(age)) return age;
            } catch (e) { /* non-registry pair or unknown network; try the next candidate */ }
        }
        // Registry unavailable (the bundle is vendored, so this should not happen). null
        // makes the caller's `maxAge > 0` guard fail open on staleness rather than
        // reintroduce a hardcoded copy of the consensus-pinned constant.
        return null;
    }

    // Latest finalized snapshot for a coin pair plus a staleness verdict:
    // { row, fresh, stale, missing, ageSeconds, maxAgeSeconds }. A snapshot whose
    // reference-block timestamp is older than the oracle max age is flagged stale so
    // callers can refuse it rather than serve it. A snapshot with no usable
    // block_timestamp is never aged out, since its age is unknown.
    async getPriceStatus(coinPair) {
        let rows = await this.db.getFinalizedPriceSnapshotByCoinPair(coinPair);
        let maxAge = this.oracleMaxAgeSeconds(coinPair);
        if (rows.length === 0)
            return { row: null, fresh: false, stale: false, missing: true, ageSeconds: null, maxAgeSeconds: maxAge };
        let row = rows[0];
        let snapTs = Number(row.block_timestamp);
        let nowS = Math.floor(Date.now() / 1000);
        let age = (Number.isFinite(snapTs) && snapTs > 0) ? (nowS - snapTs) : null;
        let stale = (maxAge > 0 && age !== null && age > maxAge);
        return { row: row, fresh: !stale, stale: stale, missing: false, ageSeconds: age, maxAgeSeconds: maxAge };
    }

    // Freshest finalized price for a coin pair, or null when missing OR stale, so
    // getFeeQuote fails closed: it treats an unavailable price as an error rather than
    // quoting an outdated round. Use getPriceStatus to tell stale from missing.
    async getPrice(coinPair) {
        let s = await this.getPriceStatus(coinPair);
        return s.fresh ? s.row : null;
    }

    // One line per (coin, network, param) that disagrees with the pinned bundle.
    // getFeeQuote is a polled public endpoint, so an un-deduped warning would be a
    // log flood rather than a signal an operator can act on.
    warnFeeConfigInert(coin, network, param, rowValue, pinnedValue) {
        if (!this._feeConfigInertWarned) this._feeConfigInertWarned = new Set();
        let key = coin + '/' + network + '/' + param;
        if (this._feeConfigInertWarned.has(key)) return;
        this._feeConfigInertWarned.add(key);
        logger.warn('XChainHub.getFeeQuote: configs row ' + key + ' = ' + rowValue
            + ' disagrees with the pinned bundle (' + pinnedValue + ') and is IGNORED. '
            + 'Indexers meter fees from their own pinned bundle and never from a hub '
            + 'overlay, so honouring this row would quote a fee no indexer accepts. '
            + 'Change the value by repinning the per-chain bundle on both sides.');
    }

    async getFeeQuote(action, chain) {
        // The hub's own deployment network (mainnet, testnet or regtest), so a testnet or
        // regtest hub reads its own config rows instead of always reading mainnet's.
        let network = this.network || 'mainnet';

        // Values come from the canonical per-chain bundle, never an inline literal and never
        // a config row, so a coordinated schedule or price repin cannot silently diverge from
        // what the indexer meters off the same bundle. The prior inline copy had already
        // drifted, omitting VM_XCALL_REQUEST, VM_XCALL_CALLBACK and VM_GUARD_GAS_CEILING, so
        // those actions quoted as 'unknown action'.
        let gasSchedule = {};
        let gasPrice    = '0.00001';
        try {
            let bundle = coins.getCoinConfig(chain, network);
            if (bundle && bundle.GAS_SCHEDULE) gasSchedule = Object.assign({}, bundle.GAS_SCHEDULE);
            if (bundle && bundle.GAS_PRICE)    gasPrice    = String(bundle.GAS_PRICE);
        } catch (_) { /* unknown chain (the public path is gated by validateChain); serve no schedule */ }

        await warnInertChainRows(this, chain, network, gasSchedule, gasPrice);
        if (!Object.prototype.hasOwnProperty.call(gasSchedule, action)) return { error: 'unknown action: ' + action };
        let gasCost = gasSchedule[action];

        // Use bignumber multiply (8 decimal places) to match indexer fee charging.
        let xchainAmount = bcmul(gasCost, gasPrice, 8);

        let xchainPriceRow = await this.getPrice('XCHAIN/USD');
        let coinPrice      = await this.getPrice(chain + '/USD');

        if (!xchainPriceRow || !xchainPriceRow.price) {
            throw new Error('XCHAIN/USD oracle price unavailable; cannot compute fee quote');
        }
        let xchainUsdStr = xchainPriceRow.price;
        if (parseFloat(xchainUsdStr) <= 0) {
            throw new Error('XCHAIN/USD oracle price is zero or negative; cannot compute fee quote');
        }

        return buildFeeQuote(action, chain, gasCost, gasPrice, xchainAmount, xchainUsdStr, coinPrice);
    }
}

module.exports = Prices;
