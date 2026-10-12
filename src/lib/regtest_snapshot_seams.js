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
 * XChain Hub - the regtest-only snapshot seams
 *
 * XDEX_SNAPSHOT_BLOCK supplies a fixed deterministic snapshot-block anchor and
 * XDEX_SEED_LOCAL_VALIDATOR seeds capability_snapshots with this hub's own
 * validator, so a no-BTC regtest stack can finalize. The override feeds the
 * SIGNED checkpoint canonical and the seeded validator joins the federation
 * set, so a stray env var or configs-table row must never reach either on
 * mainnet or testnet. One gate for every engine that reads them, so a new
 * engine or an edit cannot loosen one copy alone.
 *
 ********************************************************************/

const hubConfig = require('../config');

/**
 * Resolve both seams for one engine. Strict `network === 'regtest'`: every
 * other value, the empty string included, fails closed to NaN and false, the
 * shape makePinOffRegtest in oracle/xchain_price_source/derivation_params.js
 * gives its own regtest pins.
 *
 * @param {string} network  the engine's resolved network
 * @param {object} [cfg]    the hub's p2pConfig (configs-table values)
 * @param {object} [env]    the env view, hubConfig by default (its getters read process.env live)
 * @returns {{snapshotBlockOverride: number, seedLocalValidator: boolean}}
 */
function resolveRegtestSnapshotSeams(network, cfg, env) {
    const c = cfg || {};
    const e = env || hubConfig;
    if (network !== 'regtest') return { snapshotBlockOverride: NaN, seedLocalValidator: false };
    return {
        snapshotBlockOverride: parseInt(e.XDEX_SNAPSHOT_BLOCK || c.XDEX_SNAPSHOT_BLOCK),
        seedLocalValidator: e.XDEX_SEED_LOCAL_VALIDATOR === '1'
            || c.XDEX_SEED_LOCAL_VALIDATOR === '1' || c.XDEX_SEED_LOCAL_VALIDATOR === true
    };
}

module.exports = { resolveRegtestSnapshotSeams };
