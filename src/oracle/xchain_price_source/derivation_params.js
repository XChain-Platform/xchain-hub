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
 * XChain Hub - XCHAIN/USD derived price source: derivation parameters
 *
 * Resolves the four consensus-uniform XCHAIN/USD derivation parameters (window,
 * confirmation buffer, bootstrap, supersession volume) for the XchainPriceSource
 * constructor, honoring an override only on regtest.
 *
 ********************************************************************/

'use strict';

const bcmath = require('../../bcmath.js');
const { getLogger } = require('../../observability');
const logger = getLogger();
const { XCHAIN_PRICE_WINDOW_BLOCKS, XCHAIN_PRICE_CONFIRMATION_BUFFER,
        XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC, XCHAIN_PRICE_MIN_BTC_VOLUME } = require('../../constants.js');

// Network gate for the four CONSENSUS-UNIFORM derivation parameters below.
//
// constants.js declares them fleet-uniform: every validator must compute the
// same window over the same fills, so a hub honoring a local override produces a
// different XCHAIN/BTC leg and lands outside the co-sign deviation band, which
// this file calls a slashing lottery. The overrides are for regtest and e2e
// drills only, and that restriction is enforced HERE rather than stated in a
// comment elsewhere, because a comment leaves one stray env var on a validator
// enough to diverge it. Retuning these for real is a coordinated flag-day
// change to constants.js, never an operator env var.
//
// Same rule and warning shape as the platform's other consensus-adjacent seams
// (OracleConsensus ORACLE_ALLOW_UNVERIFIED_PAIRS, XChainHub.oracleMaxAgeSeconds,
// coins/index.js resolveFeeDestination): honored on regtest, set-but-IGNORED and
// warned everywhere else, with standalone mode (network '') failing closed to the
// pin for the same reason those do. The per-operator INDEXER_DB_* keys read in the
// XchainPriceSource constructor stay ungated: they are per-validator by design and
// gating them would take every non-regtest hub off the pair entirely.
function makePinOffRegtest(config) {
    let network = String(config.HUB_NETWORK || '').toLowerCase();
    let regtest = network === 'regtest';
    // Returns the override's value on regtest, the pin everywhere else; warns only on
    // a real divergence, since ConfigService bakes the host shell's XCHAIN_PRICE_*
    // into the container on every regenerate and a hub carrying the pinned value has
    // drifted from nothing.
    // `diverges` is decided per key by the caller rather than by a generic compare:
    // the honored bootstrap is a bcmath BigNumber against a fixed-8dp string pin, and
    // the honored threshold is a string against a null (DISABLED) pin, so one shared
    // comparison would either warn on every equal value or swallow a real divergence.
    let pinOffRegtest = (key, honored, pinned, diverges) => {
        if (regtest) return honored;
        let raw = config[key];
        let isSet = raw !== undefined && raw !== null && String(raw) !== '';
        if (isSet && diverges) {
            logger.info('WARNING: ' + key + '=' + raw + ' is set but IGNORED on ' +
                (network || '<unset>') + '; using the consensus-pinned value (' +
                (pinned === null ? 'DISABLED' : pinned) +
                '). The XCHAIN/USD derivation parameters are consensus-uniform and move ' +
                'only by a coordinated flag-day, never by a local override.');
        }
        return pinned;
    };
    return pinOffRegtest;
}

// Resolves the four parameters in the order the constructor has always assigned
// them, so any set-but-IGNORED warnings print in that same order.
function resolveDerivationParams(config) {
    let pinOffRegtest = makePinOffRegtest(config);
    let params = {};

    let windowHonored = parseInt(config.XCHAIN_PRICE_WINDOW_BLOCKS) || XCHAIN_PRICE_WINDOW_BLOCKS;
    params.windowBlocks = pinOffRegtest('XCHAIN_PRICE_WINDOW_BLOCKS', windowHonored,
        XCHAIN_PRICE_WINDOW_BLOCKS, windowHonored !== XCHAIN_PRICE_WINDOW_BLOCKS);

    let bufferHonored = Number.isFinite(parseInt(config.XCHAIN_PRICE_CONFIRMATION_BUFFER))
        ? parseInt(config.XCHAIN_PRICE_CONFIRMATION_BUFFER) : XCHAIN_PRICE_CONFIRMATION_BUFFER;
    params.confirmationBuffer = pinOffRegtest('XCHAIN_PRICE_CONFIRMATION_BUFFER', bufferHonored,
        XCHAIN_PRICE_CONFIRMATION_BUFFER, bufferHonored !== XCHAIN_PRICE_CONFIRMATION_BUFFER);

    // Satoshi-denominated (D2, 2026-08-03). Stored as the BTC-denominated rate
    // because that is the unit `toUsd` and the fill pipeline both expect.
    let bootstrapHonored = config.XCHAIN_PRICE_BOOTSTRAP_SATS
        ? bcmath.bcdiv(String(config.XCHAIN_PRICE_BOOTSTRAP_SATS), '100000000', 8)
        : XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC;
    params.bootstrapXchainBtc = pinOffRegtest('XCHAIN_PRICE_BOOTSTRAP_SATS', bootstrapHonored,
        XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC,
        Number(String(bootstrapHonored)) !== Number(XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC));

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
    let volOverride  = config.XCHAIN_PRICE_MIN_BTC_VOLUME;
    let volumeHonored = XCHAIN_PRICE_MIN_BTC_VOLUME;
    if (volOverride !== undefined && volOverride !== null && String(volOverride) !== '') {
        let parsed = Number(volOverride);
        if (Number.isFinite(parsed) && parsed >= 0) volumeHonored = String(volOverride);
    }
    params.minBtcVolume = pinOffRegtest('XCHAIN_PRICE_MIN_BTC_VOLUME', volumeHonored,
        XCHAIN_PRICE_MIN_BTC_VOLUME, volumeHonored !== XCHAIN_PRICE_MIN_BTC_VOLUME);

    return params;
}

module.exports = { resolveDerivationParams };
