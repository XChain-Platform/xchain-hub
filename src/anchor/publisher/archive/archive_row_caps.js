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
 * ANCHOR publisher - receiver-side archive row caps
 *
 ********************************************************************/

'use strict';

const constants = require('../constants.js');

const { ARCHIVE_MAX_POLICY_ROWS, ARCHIVE_MAX_LIST_ROWS, ARCHIVE_MAX_PRICE_ROUNDS } = constants;

function archiveWithinRowCaps(archive, logger){
    const specs = [
        ['policy_snapshots', 'policy', ARCHIVE_MAX_POLICY_ROWS, row => String(row.snapshot_id), true],
        ['list_snapshots', 'list', ARCHIVE_MAX_LIST_ROWS, row => String(row.snapshot_id), true],
        ['price_snapshots', 'price round', ARCHIVE_MAX_PRICE_ROUNDS, row => Number(row.round_number), false]
    ];
    for(const [key, label, cap, identity, unique] of specs){
        if(archive[key] === undefined) continue;
        if(!Array.isArray(archive[key])){
            logger.warn('StateAnchorPublisher: archive ' + key + ' is not an array; NOT signing');
            return false;
        }
        const ids = archive[key].map(identity);
        const distinct = new Set(ids);
        const count = unique ? archive[key].length : distinct.size;
        if(count > cap){
            logger.warn('StateAnchorPublisher: archive ' + label + ' count ' + count +
                        ' exceeds cap ' + cap + '; NOT signing');
            return false;
        }
        if(unique && distinct.size !== archive[key].length){
            logger.warn('StateAnchorPublisher: archive has duplicate ' + label + ' ids; NOT signing');
            return false;
        }
    }
    return true;
}

module.exports = { archiveWithinRowCaps };
