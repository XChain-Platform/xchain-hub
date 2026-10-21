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

// Oracle epoch start, resolved from the env value and a per-network pin table.
// The epoch anchors fleet-wide round numbering, so on a network the table names
// the pin wins and a differing env value is set-but-IGNORED, with a warning.
// Regtest, and any network the table does not name, keeps the env value as parsed
// today. The table is an argument: nothing is read from or chosen in this module.

const { getLogger } = require('../observability');

function defaultWarn(msg) {
    getLogger().warn(msg);
}

function resolveOracleEpochStart(network, envRaw, pins, warn) {
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
