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
 **********************************************************************/

'use strict';

/**
 * The in-flight caps on the REST /hub-db/snapshot gate and the JSON-RPC price
 * snapshot gate, resolved in one place so the two gates and the boot-time budget
 * check read the same numbers.
 *
 * Each admitted read holds one pooled connection, and the gates count separately.
 * Their sum has to leave MIN_FREE_CONNECTIONS free, or the hub's writers and the
 * SELECT 1 liveness probe queue behind the reads and ping and health answer 503
 * while the database is fine. The defaults leave three free; an override is
 * checked against the same budget at boot and warned about, never clamped, so a
 * deliberate read-heavy mirror keeps what its operator set.
 */

const { POOL_CONNECTION_LIMIT } = require('../db/schema/pool_params.js');

const DEFAULT_REST_SNAPSHOT_MAX_INFLIGHT = 4;
const DEFAULT_RPC_SNAPSHOT_MAX_INFLIGHT = 3;
const MIN_FREE_CONNECTIONS = 3;

// A positive whole number written in digits only, as a number or a string. Anything
// else ('3abc', '2.5', '0', '-1', '') is not an override.
function parseCap(raw) {
    if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function resolveCap(raw, fallback) {
    const parsed = parseCap(raw);
    return parsed === null ? fallback : parsed;
}

function isSet(raw) {
    return raw !== undefined && raw !== null && raw !== '';
}

function resolveRestSnapshotCap(hubConfig) {
    return resolveCap((hubConfig || {}).HUB_SNAPSHOT_MAX_INFLIGHT, DEFAULT_REST_SNAPSHOT_MAX_INFLIGHT);
}

function resolveRpcSnapshotCap(hubConfig) {
    return resolveCap((hubConfig || {}).HUB_RPC_SNAPSHOT_MAX_INFLIGHT, DEFAULT_RPC_SNAPSHOT_MAX_INFLIGHT);
}

// One line per problem with the snapshot caps the hub will run with: an override the
// parser refused (the default is used instead), and a pair whose sum leaves fewer than
// MIN_FREE_CONNECTIONS of the pool free. Empty when the configuration is sound.
function snapshotCapWarnings(hubConfig) {
    const config = hubConfig || {};
    const warnings = [];
    for (const name of ['HUB_SNAPSHOT_MAX_INFLIGHT', 'HUB_RPC_SNAPSHOT_MAX_INFLIGHT']) {
        if (isSet(config[name]) && parseCap(config[name]) === null) {
            warnings.push(name + '=' + JSON.stringify(String(config[name])) +
                ' is not a positive whole number; using the default.');
        }
    }
    const rest = resolveRestSnapshotCap(config);
    const rpc = resolveRpcSnapshotCap(config);
    const budget = POOL_CONNECTION_LIMIT - MIN_FREE_CONNECTIONS;
    if (rest + rpc > budget) {
        warnings.push('Snapshot read caps allow ' + rest + ' REST and ' + rpc + ' RPC reads at once, ' +
            (rest + rpc) + ' of the ' + POOL_CONNECTION_LIMIT + ' pooled connections; keep the sum at or ' +
            'below ' + budget + ' so writers and the health probe retain ' + MIN_FREE_CONNECTIONS + ' slots.');
    }
    return warnings;
}

module.exports = {
    DEFAULT_REST_SNAPSHOT_MAX_INFLIGHT,
    DEFAULT_RPC_SNAPSHOT_MAX_INFLIGHT,
    MIN_FREE_CONNECTIONS,
    parseCap,
    resolveRestSnapshotCap,
    resolveRpcSnapshotCap,
    snapshotCapWarnings,
};
