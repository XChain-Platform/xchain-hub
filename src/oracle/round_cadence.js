'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Oracle round interval and submission window, resolved once per process.
// Both anchor fleet-wide round numbering, so the env override is honoured on
// regtest only; every other network gets the p2pConfig value or the default.

const { positiveIntConfig } = require('../lib/config_int.js');
const hubConfig = require('../config');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS, DEFAULT_ORACLE_SUBMISSION_WINDOW_MS } = require('../constants.js');

let cached = null;

function isRegtest() {
    return String(hubConfig.HUB_NETWORK || '').toLowerCase() === 'regtest';
}

function pick(name, cfg, dflt) {
    const fromEnv = isRegtest() ? hubConfig.env()[name] : undefined;
    const raw = (fromEnv !== undefined && fromEnv !== '') ? fromEnv : cfg[name];
    return positiveIntConfig(raw, dflt, name);
}

function resolveRoundCadence(cfg) {
    if (cached) return cached;
    cfg = cfg || {};
    cached = {
        roundInterval: pick('ORACLE_ROUND_INTERVAL', cfg, DEFAULT_ORACLE_ROUND_INTERVAL_MS),
        submissionWindow: pick('ORACLE_SUBMISSION_WINDOW', cfg, DEFAULT_ORACLE_SUBMISSION_WINDOW_MS)
    };
    return cached;
}

function resetRoundCadence() {
    cached = null;
}

module.exports = { resolveRoundCadence, resetRoundCadence };
