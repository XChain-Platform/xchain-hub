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
 * XChain Hub - Mainnet write window
 *
 * Mainnet on-chain writes stay closed until MAINNET_WRITES_OPEN_AT (unix
 * seconds). Every other network is never gated. FAIL CLOSED on mainnet: a
 * clock reading that is not a finite number keeps the window shut.
 *
 ********************************************************************/

'use strict';

const MAINNET_WRITES_OPEN_AT = 1796083200;

function mainnetWritesOpen(network, nowSeconds){
    if(network !== 'mainnet') return true;
    if(typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds)) return false;
    return nowSeconds >= MAINNET_WRITES_OPEN_AT;
}

module.exports = { mainnetWritesOpen, MAINNET_WRITES_OPEN_AT };
