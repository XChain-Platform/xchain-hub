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
 * XChain Hub - DEX Engine Constants
 *
 * The DEX engine's chain list, poll cadence, confirmation floor and the canonical integer
 * field list the follower checks spellings against, in one place so the matcher, the
 * finalizer and the follower cannot drift apart on any of them.
 *
 ********************************************************************/

const coins = require('../../coins');

// The INT-backed fields _canonicalMatch signs VERBATIM while the indexer's
// settlement pass rebuilds them from the mirrored BIGINT row. The fill and
// filled-before fields are bcmath DECIMAL strings compared through amountsEqual,
// and ticks / addresses / kinds / payout legs are string compares, so none of them
// belong here.
const DEX_CANONICAL_INT_FIELDS = ['snapshot_block', 'a_action_index', 'b_action_index',
                                  'a_ownership', 'b_ownership', 'effective_time'];

const ALLOWED_CHAINS = [...coins.ALLOWED_COINS];

const DEFAULT_POLL_MS = 15000;

// Min on-chain confirmations a give-side escrow must have before a peer will sign
// a proposed match (Byzantine safety against matching on a reorg-able escrow).
const DEFAULT_MIN_CONFIRMATIONS = 1;

module.exports = { DEX_CANONICAL_INT_FIELDS, ALLOWED_CHAINS, DEFAULT_POLL_MS, DEFAULT_MIN_CONFIRMATIONS };
