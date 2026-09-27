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
 * XChain Hub - per-source liveness samples.
 *
 **********************************************************************/

'use strict';

function setSourceLiveness(gauge, summary) {
    if(summary === null || typeof summary !== 'object') return 0;

    let count = 0;
    for(const [list, value] of [[summary.live, 1], [summary.dead, 0]]) {
        if(!Array.isArray(list)) continue;
        for(const key of list) {
            if(typeof key !== 'string') continue;
            gauge.set({ source: key }, value);
            count++;
        }
    }
    return count;
}

module.exports = { setSourceLiveness };
