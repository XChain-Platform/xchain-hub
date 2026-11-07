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
 * ANCHOR publisher - unheld archive row verification
 *
 ********************************************************************/

'use strict';

function comparable(row){
    const out = Object.assign({}, row);
    delete out.id;
    delete out.validator_signatures;
    return out;
}

// Return why an unheld row is not the shape the archive builder emits, or null.
// Require unsigned status and key lists to match XBRIDGE, XPOLICY and XLISTSHARE rows.
function unheldRowRefusal(row, serialized, statuses){
    if(JSON.stringify(comparable(serialized)) !== JSON.stringify(comparable(row)))
        return 'does not re-serialize unchanged with no held row';
    if(!statuses.includes(row.status))
        return 'is ' + row.status + ' with no held row';
    return null;
}

module.exports = { comparable, unheldRowRefusal };
