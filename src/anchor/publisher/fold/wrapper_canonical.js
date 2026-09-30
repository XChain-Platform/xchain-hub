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

function foldArchiveSuffix(archive){
    return ['MATCH_BATCH_SEQ', 'MATCH_COUNT', 'BATCH_CRC32', 'TOTAL_CHUNKS']
        .map(name => '|' + String(archiveField(archive, name))).join('');
}

function extendWrapperCanonicalBase(base, sectionIndex, archive){
    if(archive === null || archive === undefined) return base;
    const wrapperIndex = archiveField(archive, 'WRAPPER_SECTION_INDEX');
    return Number(wrapperIndex) === Number(sectionIndex) ? base + foldArchiveSuffix(archive) : base;
}

module.exports = { foldArchiveSuffix, extendWrapperCanonicalBase };
