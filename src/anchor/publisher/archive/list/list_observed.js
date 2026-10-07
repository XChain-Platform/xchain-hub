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
 * ANCHOR publisher - observed archived list snapshots
 *
 ********************************************************************/

'use strict';

function observedListIds(archive){
    const observed = new Set();
    const rows = archive && Array.isArray(archive.list_snapshots) ? archive.list_snapshots : [];
    for(const row of rows)
        if(row && row.snapshot_id != null) observed.add(String(row.snapshot_id));
    return observed;
}

function firstListOutside(observed, lists){
    for(const row of (lists || []))
        if(row && row.snapshot_id != null && !observed.has(String(row.snapshot_id)))
            return 'list ' + String(row.snapshot_id).substring(0, 16) + '...';
    return null;
}

module.exports = { observedListIds, firstListOutside };
