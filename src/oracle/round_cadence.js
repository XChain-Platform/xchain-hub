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
// regtest only and is set-but-IGNORED, with a warning, on every other network.
// An explicit plain-object cfg value (a test fixture's p2pConfig) is honoured.

const { positiveIntConfig } = require('../lib/config_int.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS, DEFAULT_ORACLE_SUBMISSION_WINDOW_MS } = require('../constants.js');

const logger = getLogger();
let cached = null;

function network() {
    return String(hubConfig.HUB_NETWORK || '').toLowerCase();
}

// Name an env value that would have moved the cadence off regtest (silent when it equals the result).
function warnIgnored(name, raw, resolved) {
    if (raw === undefined || raw === null || raw === '') return;
    if (parseInt(raw, 10) === resolved) return;
    logger.warn('WARNING: ' + name + '=' + raw + ' is set but IGNORED on ' + (network() || '<unset>') +
        '; using ' + resolved + '. The oracle round cadence is fleet-uniform and moves only by a ' +
        'coordinated change to constants.js, never by a local override.');
}

function pick(name, cfg, dflt) {
    const envRaw = hubConfig.env()[name];
    if (network() === 'regtest' && envRaw !== undefined && envRaw !== '') return positiveIntConfig(envRaw, dflt, name);
    const resolved = positiveIntConfig(cfg[name], dflt, name);
    if (network() !== 'regtest') warnIgnored(name, envRaw, resolved);
    return resolved;
}

function resolveRoundCadence(cfg) {
    if (cached) return cached;
    // Treat the config module as no cfg: its getters read process.env, which would bypass the regtest gate.
    cfg = (cfg && cfg !== hubConfig) ? cfg : {};
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
