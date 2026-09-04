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
 * THIS FILE HAS NO REQUIRES, AND THAT IS THE POINT. The rule previously lived on
 * the broadcaster class and was imported from there, which put it behind that
 * module's own load order: reached through a cycle, the import resolved before the
 * property was attached, the routes stringified with an undefined replacer, and
 * every snapshot route threw "Do not know how to serialize a BigInt" at runtime
 * while passing in isolation. A leaf module cannot be partially initialized, so
 * both consumers get the function no matter who loads first.
 *
 ********************************************************************/

'use strict';

const bigIntReplacer = (k, v) => typeof v === 'bigint' ? v.toString() : v;

module.exports = { bigIntReplacer };
