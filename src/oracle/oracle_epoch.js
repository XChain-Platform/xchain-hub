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

// Oracle epoch start: on a network the pin table names, the pin wins and a
// differing env value is ignored with a warning; otherwise the env value stands.

const { getLogger } = require('../observability');
const { ORACLE_EPOCH_START_PINS } = require('../constants');

function defaultWarn(msg) {
    getLogger().warn(msg);
}

function resolveOracleEpochStart(network, envRaw, pins = ORACLE_EPOCH_START_PINS, warn) {
    const parsed = parseInt(envRaw, 10);
    const net = String(network || '').toLowerCase();
    if (net === 'regtest' || !pins || !Object.prototype.hasOwnProperty.call(pins, net)) return parsed;
    const pin = pins[net];
    if (envRaw !== undefined && envRaw !== null && envRaw !== '' && parsed !== pin) {
        (typeof warn === 'function' ? warn : defaultWarn)(
            'WARNING: ORACLE_EPOCH_START=' + envRaw + ' is set but IGNORED on ' + net +
            '; using ' + pin + '. The oracle epoch is fleet-uniform and moves only by a ' +
            'coordinated change to constants.js, never by a local override.');
    }
    return pin;
}

module.exports = { resolveOracleEpochStart };
