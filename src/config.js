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
 * XChain Hub - configuration
 *
 * The one module that reads the environment at load time. Every other module
 * takes its settings from the object exported here instead of reaching for
 * process.env itself, so a setting has one name, one default and one place a
 * reader looks for it.
 *
 * The object is empty for now. The environment reads that are scattered across
 * src/ move into it in the next pass, each one with the default its current
 * read site uses, and the object stays frozen so no caller can change a
 * setting after boot.
 *
 ********************************************************************/

'use strict';

module.exports = Object.freeze({});
