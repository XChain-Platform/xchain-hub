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
 * XChain Hub - XCHAIN/USD derived price source: derive steps
 *
 * The ordered steps XchainPriceSource.derive runs, mixed onto its prototype. Each
 * step returns null to abstain from the pair; derive keeps the single catch that
 * turns any throw into an abstention. The arithmetic stays in xchainPrice.js.
 *
 ********************************************************************/

'use strict';

const bcmath = require('../../bcmath.js');
const { deriveXchainRate, toUsd } = require('../../xchainPrice.js');
const { getWindowFills } = require('../../xchainPriceQuery.js');
const { getLogger } = require('../../observability');
const logger = getLogger();
const { XCHAIN_PAIR, BTC_PAIR, GAS_TICK } = require('./pairs.js');

const deriveSteps = {

    // Reads the round's anchor height, round number and local BTC/USD out of `ctx`.
    // Returns { referenceHeight, round, btcUsd }, or null to abstain.
    readDeriveContext(ctx) {
        // The anchor must be a real height. OracleRound falls back to
        // `currentBtcBlockHeight = currentRound` when the BTC tip is unavailable,
        // and a round number is a small integer that would silently window over an
        // arbitrary early block range. Deriving a fee input off that is worse than
        // publishing nothing, so an unreliable anchor is a LOCAL failure.
        if (ctx.chainTipReliable === false) {
            logger.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR +
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
            logger.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - no local ' + BTC_PAIR + ' this round');
            return null;
        }
        return { referenceHeight: referenceHeight, round: round, btcUsd: btcUsd };
    },

    // The value published when the window does not supersede: the last finalized
    // XCHAIN/USD, else the bootstrap converted to USD. Returns null to abstain.
    resolveCarryForward(lastXchainUsd, refBtcUsd, round) {
        // D2 (redecided 2026-08-03): the bootstrap is denominated in SATOSHIS, so
        // before it can be carried forward as a USD price it has to be converted,
        // and the multiplier has to be the CONSENSUS BTC/USD - the same
        // `refBtcUsd` the band anchor uses, never `btcUsd` from this round's local
        // submission. The reasoning is the paragraph above, applied one step
        // earlier: if each validator converted the bootstrap with its own API
        // price, the very first XCHAIN/USD round would be a different number on
        // every hub, and they would publish those differences straight into
        // deviation slashing.
        //
        // Consequence, and it is deliberate: with NO finalized BTC/USD below this
        // round there is nothing consensus-safe to convert with, so the pair
        // abstains for that round instead of inventing a value. Deterministic for
        // everyone ("has any BTC/USD finalized below R" is consensus data), and it
        // resolves itself the moment the federation finalizes its first BTC/USD.
        // The old USD-denominated bootstrap needed no conversion and so could
        // publish through that gap; a satoshi-denominated one cannot, and paying
        // one round of silence is the correct price for not forking.
        // ("The paragraph above" is the band-anchor note at the refBtcUsd read in
        // XchainPriceSource.derive.)
        let carryForward = lastXchainUsd;
        if (!carryForward) {
            carryForward = toUsd(bcmath, this.bootstrapXchainBtc, refBtcUsd);
            if (!carryForward) {
                logger.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR +
                    ' - bootstrap is satoshi-denominated and no finalized ' + BTC_PAIR +
                    ' exists below round ' + round + ' to convert it with');
                return null;
            }
        }
        return carryForward;
    },

    // Selects the round's fill window from the indexer. Returns the selection, or
    // null to abstain.
    async findWindowFills(referenceHeight) {
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
            logger.warn('XchainPriceSource: abstaining from ' + XCHAIN_PAIR + ' - ' + selection.error);
            return null;
        }
        return selection;
    },

    // Turns a successful selection into the entry to publish. `basis` carries
    // carryForward, lastXchainUsd, refRate and btcUsd from derive.
    entryFromWindow(selection, basis) {
        let meta = {
            window:      selection.window,
            fillCount:   selection.fills.length,
            carriedFrom: basis.lastXchainUsd ? 'last-finalized' : 'bootstrap',
        };

        // An EMPTY window is a defined state, not a failure: publish carry-forward
        // (§7). Suppressing the pair on a quiet market would age it past the 1800s
        // staleness bound and re-brick LTC/DOGE fees within a few rounds.
        let derived = selection.fills.length ? deriveXchainRate(bcmath, selection.fills, basis.refRate) : null;
        if (!derived) {
            return this.entry(basis.carryForward, Object.assign(meta, { derived: false }));
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
        if (!this.volumeSupersedes(derived.totalCoin)) {
            return this.entry(basis.carryForward, Object.assign(meta, {
                derived:        false,
                reason:         this.minBtcVolume === null
                    ? 'supersession disabled (D2 threshold undecided)'
                    : 'window volume below the supersession threshold',
                btcVolume:      derived.totalCoin,
                minBtcVolume:   this.minBtcVolume,
                wouldHaveBeen:  derived.rate,
            }));
        }

        return this.entryFromDerived(derived, basis, meta);
    },

    // Publishes the derived rate in USD, or the carry-forward when the USD leg
    // cannot be computed.
    entryFromDerived(derived, basis, meta) {
        let usd = toUsd(bcmath, derived.rate, basis.btcUsd);
        if (!usd) return this.entry(basis.carryForward, Object.assign(meta, { derived: false, reason: 'usd leg unusable' }));

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
        return this.entry(usd, meta);
    },
};

module.exports = deriveSteps;
