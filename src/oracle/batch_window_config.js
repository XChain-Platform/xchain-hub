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
 * XChain Hub - PRICE batch window, resolved from its config knobs in one place
 *
 * The batch signer refuses proposals by this window and the publisher proposes by
 * it, so both call this one resolver and cannot derive different boundaries.
 *
 ********************************************************************/

'use strict';

const hubConfig = require('../config');
const { positiveIntConfig, nonNegativeIntConfig } = require('../lib/config_int.js');
const { maxBatchWindowRounds, pinnedMaxPriceAgeMs,
        DEFAULT_BATCH_LANDING_RESERVE_MS,
        LEGACY_BATCH_WINDOW_ROUNDS } = require('./price_batch_cadence.js');
const { createHourlyWindowPlan } = require('./publisher/window_plan.js');

const DEFAULT_BATCH_GRACE_MS = 300000;

/**
 * Resolve the PRICE batch window and its hourly plan for one hub.
 *
 * An over-ceiling ORACLE_BATCH_WINDOW_ROUNDS is clamped here; the caller that reports
 * the cadence compares requestedRounds with smallRounds to say so.
 *
 * @param {object} opts
 * @param {string} opts.network          the hub's network name
 * @param {object} [opts.cfg]            the hub's p2pConfig, read after the env
 * @param {boolean} opts.enabled         false keeps the hourly switch unarmed
 * @param {number} opts.roundIntervalMs  the fleet round interval (round_cadence.js)
 * @returns {{ roundIntervalMs: number, graceMs: number, landingReserveMs: number,
 *             maxPriceAgeMs: number, ceiling: (number|null), satisfiable: boolean,
 *             requestedRounds: number, smallRounds: number, hourly: object }}
 */
function resolveBatchWindow({ network, cfg, enabled, roundIntervalMs }) {
    cfg = cfg || {};
    // Read the grace and the landing reserve first: the window ceiling is derived from them.
    const graceMs = positiveIntConfig(
        hubConfig.ORACLE_BATCH_GRACE_MS || cfg.ORACLE_BATCH_GRACE_MS,
        DEFAULT_BATCH_GRACE_MS, 'ORACLE_BATCH_GRACE_MS');
    const landingReserveMs = nonNegativeIntConfig(
        hubConfig.ORACLE_BATCH_LANDING_RESERVE_MS || cfg.ORACLE_BATCH_LANDING_RESERVE_MS,
        DEFAULT_BATCH_LANDING_RESERVE_MS, 'ORACLE_BATCH_LANDING_RESERVE_MS');
    const maxPriceAgeMs = pinnedMaxPriceAgeMs(network);
    const cadence = maxBatchWindowRounds({ maxPriceAgeMs, roundIntervalMs, graceMs, landingReserveMs });

    // Default the window to the largest that fits the staleness bound, and never exceed it.
    const requestedRounds = positiveIntConfig(
        hubConfig.ORACLE_BATCH_WINDOW_ROUNDS || cfg.ORACLE_BATCH_WINDOW_ROUNDS,
        cadence.ceiling === null ? LEGACY_BATCH_WINDOW_ROUNDS : cadence.ceiling,
        'ORACLE_BATCH_WINDOW_ROUNDS');
    const smallRounds = cadence.ceiling !== null && requestedRounds > cadence.ceiling
        ? cadence.ceiling
        : requestedRounds;

    const hourly = createHourlyWindowPlan({
        network, enabled, smallRounds, roundIntervalMs, graceMs, landingReserveMs
    });
    return {
        roundIntervalMs, graceMs, landingReserveMs, maxPriceAgeMs,
        ceiling: cadence.ceiling, satisfiable: cadence.satisfiable,
        requestedRounds, smallRounds, hourly
    };
}

module.exports = { resolveBatchWindow, DEFAULT_BATCH_GRACE_MS };
