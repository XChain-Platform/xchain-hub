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
 * XChain Hub - indexer tip read for the XCHAIN/USD derivation
 *
 * Hub-only, unlike the vendored fill-selection SQL beside it. The indexer
 * writes a block's `blocks` row inside that block's own commit, so the
 * highest block_index is the last block whose fills are all present.
 *
 ********************************************************************/

'use strict';

const INDEXER_TIP_SQL = 'SELECT MAX(block_index) AS tip FROM blocks';

module.exports = { INDEXER_TIP_SQL };
