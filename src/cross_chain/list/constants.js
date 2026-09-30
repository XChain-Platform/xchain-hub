'use strict';

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
 ********************************************************************/

const LIST_CANONICAL_INT_FIELDS = [
    'snapshot_block',
    'home_list_index',
    'list_type',
    'seq',
    'origin_block'
];

// Canonical value: xchain-documentation/protocol/constants.js
// LIST_SHARE_MAX_MEMBERS. Named locally so the hub does not require across
// package boundaries.
const LIST_SHARE_MAX_MEMBERS = 10000;

module.exports = { LIST_CANONICAL_INT_FIELDS, LIST_SHARE_MAX_MEMBERS };
