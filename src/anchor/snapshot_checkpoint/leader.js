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
 * Snapshot checkpoint leader selection
 *
 ********************************************************************/

'use strict';

function leadsSnapshotSlot(blockIndex, validators, myPubkeyHex) {
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return false;
    if (!Array.isArray(validators) || validators.length === 0) return false;
    if (typeof myPubkeyHex !== 'string' || myPubkeyHex.length === 0) return false;

    let pubkeys = [...new Set(validators.map(validator =>
        String(validator && validator.pubkey).toLowerCase()
    ))].sort();
    let myRank = pubkeys.indexOf(myPubkeyHex.toLowerCase());
    return myRank >= 0 && blockIndex % pubkeys.length === myRank;
}

module.exports = { leadsSnapshotSlot };
