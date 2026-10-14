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
 * XChain Hub - DEX Price-Cross Test
 *
 * Whether an ORDER pair's limits cross, the same test the indexer's local matcher
 * applies in order_match/match.js hasFillRoom on the same registry row, so a
 * cross-chain match and a local match judge one pair of limits alike.
 *
 ********************************************************************/

const bc = require('../../bcmath.js');
const gateRegistry = require('../../consensus/gate_registry');

const PRICE_CROSS_KEY = 'order_match_price_cross_activation.ORDER_MATCH_PRICE_CROSS_ACTIVATION';

// Passed in place of a snapshot block by the discovery pre-check, which runs before the
// snapshot is resolved: it admits an ORDER pair on structure alone, so a pair that
// crosses under either era's test is worth resolving a snapshot for.
const ANY_PRICE_ERA = 'any';

// takerGivePrice is the taker's ask and makerGetPrice the maker's bid, both in taker GET
// units per taker GIVE unit. From the order_match_price_cross_activation height, read on
// the bare network entry at the match's BTC snapshot_block (the plane the royalty and
// offer-list gates use), the pair crosses when the ask does not exceed the bid. Below it
// the legacy test stands unchanged: it refuses a bid above the ask, the reverse of its
// stated intent. A missing block reads as below the height.
function pricesCross(network, snapshotBlock, makerGetPrice, takerGivePrice){
    if(snapshotBlock === ANY_PRICE_ERA) return true;
    let height = (snapshotBlock === null || snapshotBlock === undefined) ? null : Number(snapshotBlock);
    if(gateRegistry.activeAt(PRICE_CROSS_KEY, network, null, height, null))
        return !bc.bcgt(takerGivePrice, makerGetPrice);
    return !bc.bcgt(makerGetPrice, takerGivePrice);
}

module.exports = { PRICE_CROSS_KEY, ANY_PRICE_ERA, pricesCross };
