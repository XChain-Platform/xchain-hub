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
 * XChain Hub - Oracle Round Message Types
 *
 * The one gossip message type the round path broadcasts and receives. Held
 * beside the parts rather than in either of them, because the sender
 * (executeRoundInner) and the receiver (_handleMessage) live in different
 * files and must spell it identically.
 *
 ********************************************************************/

const ORACLE_PRICE_SUBMIT = 'ORACLE_PRICE_SUBMIT';

module.exports = { ORACLE_PRICE_SUBMIT };
