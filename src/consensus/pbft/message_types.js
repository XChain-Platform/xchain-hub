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
 * XChain Hub - PBFT Consensus Engine: message types
 *
 * The five PBFT gossip types, in one place because the handler dispatch in
 * pbft.js and every part that broadcasts one must spell them identically.
 *
 ********************************************************************/

'use strict';

const PBFT_PRE_PREPARE = 'PBFT_PRE_PREPARE';
const PBFT_PREPARE     = 'PBFT_PREPARE';
const PBFT_COMMIT      = 'PBFT_COMMIT';
const PBFT_VIEW_CHANGE = 'PBFT_VIEW_CHANGE';
const PBFT_NEW_VIEW    = 'PBFT_NEW_VIEW';

module.exports = {
    PBFT_PRE_PREPARE,
    PBFT_PREPARE,
    PBFT_COMMIT,
    PBFT_VIEW_CHANGE,
    PBFT_NEW_VIEW
};
