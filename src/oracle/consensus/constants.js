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
 * XChain Hub - Oracle Consensus: shared constants
 *
 * The message type names, the fallback grace the seat split and the round-abandonment
 * watchdog both derive from, and the per-pair clamp table the aggregation and the slash
 * gate must read from one place.
 *
 ********************************************************************/

'use strict';

const { ORACLE_MAX_CHANGE_PER_ROUND, XCHAIN_PRICE_MAX_CHANGE_PER_ROUND, DERIVED_PAIRS } = require('../../constants.js');

const ORACLE_PROPOSE = 'ORACLE_PROPOSE';
const ORACLE_PREPARE = 'ORACLE_PREPARE';
const ORACLE_COMMIT  = 'ORACLE_COMMIT';

const FALLBACK_GRACE_MS = 3000;  // brief grace before fallback proposer takes over

// Per-pair override for the aggregation move clamp (D4). Most pairs track
// deep external markets and share ORACLE_MAX_CHANGE_PER_ROUND; XCHAIN/USD is
// derived from a thin on-platform market and gets a tighter bound.
//
// CONSENSUS-CRITICAL and federation-uniform: two hubs on different values clamp the
// same aggregate to different prices, so they publish different finalized rows and
// the disagreeing one walks into deviation slashing. A retune is a coordinated
// flag-day (§8), never a rolling deploy.
//
// Keyed off DERIVED_PAIRS[0] rather than a second 'XCHAIN/USD' literal, so the pair
// name has exactly one spelling in this repo and a rename cannot silently leave the
// override attached to a pair that no longer exists.
const MAX_CHANGE_PER_ROUND_BY_PAIR = {
    [DERIVED_PAIRS[0]]: XCHAIN_PRICE_MAX_CHANGE_PER_ROUND,
};

// The per-round move bound in force for `coinPair`. Unknown pairs get the global
// default, so a new pair is never accidentally unclamped.
function maxChangeForPair(coinPair) {
    let pct = MAX_CHANGE_PER_ROUND_BY_PAIR[coinPair];
    return (typeof pct === 'number' && Number.isFinite(pct) && pct > 0)
        ? pct : ORACLE_MAX_CHANGE_PER_ROUND;
}

module.exports = { ORACLE_PROPOSE, ORACLE_PREPARE, ORACLE_COMMIT, FALLBACK_GRACE_MS, maxChangeForPair };
