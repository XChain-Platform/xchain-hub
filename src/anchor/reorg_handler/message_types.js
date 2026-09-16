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
 * Reorg handler - p2p message types
 *
 * The three wire types of a reorg round, shared by the class file's dispatcher and
 * the parts that broadcast them.
 *
 ********************************************************************/

'use strict';

const REORG_ALERT          = 'REORG_ALERT';
const XCHAIN_REORG_PREPARE = 'XCHAIN_REORG_PREPARE';
const XCHAIN_REORG_COMMIT  = 'XCHAIN_REORG_COMMIT';

module.exports = { REORG_ALERT, XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT };
