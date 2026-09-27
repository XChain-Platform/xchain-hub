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
 * XChain Hub - folded ANCHOR group placement
 *
 ********************************************************************/

'use strict';

const { ANCHOR_SIG_PAIR_BYTES } = require('../constants.js');
const { chooseArchiveGroup } = require('./archive_placement.js');
const { buildAnchorV3Payload, archiveSectionBytes } = require('./v3_payload.js');

function groupBytes(group, publisher, attestSigCount){
    const count = Math.max(0, Number(attestSigCount) || 0);
    const snapshotBlock = group.reduce((max, section) =>
        Math.max(max, Number(section.snapshot_block)), 0);
    const bundle = {
        network: String(group[0].network),
        snapshot_block: snapshotBlock,
        sections: group,
        archive_count: 0,
        publisher,
        attest_sigs: []
    };
    const base = Buffer.byteLength(buildAnchorV3Payload(bundle), 'utf8');
    return base - 1 + String(count).length + (count * ANCHOR_SIG_PAIR_BYTES);
}

function placeArchiveOnGroups(groups, archive, publisher, attestSigCount){
    const entries = (groups || []).map(group => ({ group, archive: null }));
    if(archive === null || entries.length === 0) return entries;

    const groupSizes = entries.map(entry => groupBytes(entry.group, publisher, attestSigCount));
    const archiveBytes = archiveSectionBytes({
        ...archive,
        archive_count: 1,
        sections: entries[0].group
    });
    const carrier = chooseArchiveGroup(groupSizes, archiveBytes);
    if(carrier >= 0) entries[carrier].archive = archive;
    return entries;
}

module.exports = { placeArchiveOnGroups };
