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
 * XChain Hub - XCHAIN/USD derived price source: pair and ticker names
 *
 * The names XchainPriceSource reads and emits, shared by the class file and its
 * parts so each spelling exists once.
 *
 ********************************************************************/

'use strict';

const { DERIVED_PAIRS } = require('../../constants.js');

// The pair this source produces. Taken from DERIVED_PAIRS rather than re-spelled, so
// the producer and the admission allow-list cannot drift into a pair that is
// computed but never accepted (or vice versa).
const XCHAIN_PAIR = DERIVED_PAIRS[0];
const BTC_PAIR    = 'BTC/USD';

// The gas token's reserved ticker. Canonical source is
// xchain-documentation/protocol/constants.js GAS_TICK; spelled here because the hub
// does not vendor that file, and pinned by test against the pair name above.
const GAS_TICK = 'XCHAIN';

module.exports = { XCHAIN_PAIR, BTC_PAIR, GAS_TICK };
