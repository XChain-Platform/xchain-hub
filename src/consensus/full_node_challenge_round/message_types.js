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
 * XChain Hub - Full-Node Challenge Round: gossip types
 *
 * The four round gossip types, in one place because the dispatch in the class
 * file and every part that broadcasts one must spell them identically.
 *
 ********************************************************************/

'use strict';

const XNODE_ANSWER   = 'XNODE_ANSWER';
const XNODE_SIGN_REQ = 'XNODE_SIGN_REQ';
const XNODE_SIGN     = 'XNODE_SIGN';
const XNODE_DONE     = 'XNODE_DONE';

module.exports = {
    XNODE_ANSWER,
    XNODE_SIGN_REQ,
    XNODE_SIGN,
    XNODE_DONE
};
