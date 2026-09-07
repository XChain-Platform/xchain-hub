/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * How a BIGINT column is rendered on the wire, in ONE place.
 *
 * A hub-db consumer can bootstrap over REST and then stream over the websocket,
 * and both feeds must render the same column the same way: the response mirror's
 * effective_time is a BIGINT that feeds a signed canonical and a block predicate,
 * where a string-versus-number swap is a fork rather than a display bug.
 *
 * The rule previously lived as a module-local const inside the broadcaster, which
 * exported only its class. The snapshot routes destructured bigIntReplacer off that
 * module and so read a property nobody had ever attached: it was undefined
 * deterministically, in every environment, and every snapshot route threw
 * "Do not know how to serialize a BigInt" the first time a column arrived as a real
 * BigInt. It looked environment-specific only because the pool sets bigIntAsNumber,
 * so nothing outside a test ever handed those routes a BigInt to trip over.
 *
 * A leaf module is the fix because it cannot be half-initialized. Keeping the rule
 * beside a class invites re-publishing it as a property of that class, which is both
 * easy to omit (what happened) and, once a cycle joins the graph, orderable ahead of
 * its own assignment. This module imports nothing, so neither consumer has a load
 * order left to lose, and the suite pins that.
 *
 ********************************************************************/

'use strict';

const bigIntReplacer = (k, v) => typeof v === 'bigint' ? v.toString() : v;

module.exports = { bigIntReplacer };
