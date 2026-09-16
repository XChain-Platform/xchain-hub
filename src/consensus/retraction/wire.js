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
 * XChain Hub - Retraction Consensus: wire types
 *
 * The three gossip types of a retraction round and the tables whose retractions
 * require the co-signature set, in one place because the dispatch in
 * retraction.js and both round parts must spell them identically.
 *
 ********************************************************************/

'use strict';

const XRETRACT_SIGN_REQ  = 'XRETRACT_SIGN_REQ';
const XRETRACT_SIGN      = 'XRETRACT_SIGN';
const XRETRACT_FINALIZED = 'XRETRACT_FINALIZED';

// Tables whose retractions require the co-signature set (their insertions are
// the quorum-signed relay rows this consensus protects). Price-table retractions stay
// on the fence-guarded legacy path: their insertions are not quorum-signed
// either, so signing their deletions would claim a trust tier the data lacks.
const QUORUM_CLASS_TABLES = new Set(['cross_chain_calls', 'cross_chain_matches']);

module.exports = {
    XRETRACT_SIGN_REQ,
    XRETRACT_SIGN,
    XRETRACT_FINALIZED,
    QUORUM_CLASS_TABLES
};
