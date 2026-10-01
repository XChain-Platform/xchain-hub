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
 * XChain Hub - folded ANCHOR wrapper canonical
 *
 ********************************************************************/

'use strict';

function archiveField(archive, name){
    return archive[name] !== undefined ? archive[name] : archive[name.toLowerCase()];
}

// Embed the batch CRC32 lower-case; every ANCHOR archive canonical builder calls this.
function canonicalBatchCrc(crc){
    return String(crc).toLowerCase();
}

function foldArchiveSuffix(archive){
    const field = name => String(archiveField(archive, name));
    return '|' + [field('MATCH_BATCH_SEQ'), field('MATCH_COUNT'),
        canonicalBatchCrc(archiveField(archive, 'BATCH_CRC32')), field('TOTAL_CHUNKS')].join('|');
}

function extendWrapperCanonicalBase(base, sectionIndex, archive){
    if(archive === null || archive === undefined) return base;
    const wrapperIndex = archiveField(archive, 'WRAPPER_SECTION_INDEX');
    return Number(wrapperIndex) === Number(sectionIndex) ? base + foldArchiveSuffix(archive) : base;
}

module.exports = { canonicalBatchCrc, foldArchiveSuffix, extendWrapperCanonicalBase };
