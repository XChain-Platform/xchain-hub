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
 * XChain Hub - Finalized Signer Set
 *
 * Picks the signatures a finalized response carries. Arrival order differs
 * per hub, so the choice is a pure function of the held signatures: ascending
 * pubkey, truncated to the count the quorum needs.
 *
 ********************************************************************/

'use strict';

function selectFinalizedSigners(signatures, needed){
    let all = [];
    for(let [pk, sg] of signatures){
        all.push({ pubkey: pk, sig: sg });
    }
    all.sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
    return all.slice(0, Math.max(0, Number(needed) || 0));
}

module.exports = { selectFinalizedSigners };
