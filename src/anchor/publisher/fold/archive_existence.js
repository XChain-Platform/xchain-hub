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
 * ANCHOR publisher - folded archive existence key
 *
 ********************************************************************/

'use strict';

// The getarchiveanchor content key for a folded archive: the wrapper checkpoint it
// rides on plus the batch's own commitment, scoped to this publisher's address so a
// copied head never reads as our own spend. A request carrying no content-key field
// is the indexer's publisher-sequence lookup, whose reply names no head at all.
function foldArchiveAnchorRequest(archiveSection, author){
    if(!author) throw new Error('no DOGE_ADDRESS configured');
    let cp = archiveSection.cp || {};
    return {
        chain: String(cp.chain), network: String(cp.network),
        block_index: Number(cp.block_index), checkpoint_seq: Number(cp.checkpoint_seq),
        batch_crc32: String(archiveSection.crc).toLowerCase(),
        match_count: Number(archiveSection.count),
        author: String(author)
    };
}

// True only for the head this publisher built: same wrapper checkpoint, content,
// chunk geometry, batch seq and author as the request.
function foldArchiveRowMatches(row, requested, archiveSection){
    return row.match_batch_seq != null &&
        Number(row.match_batch_seq) === Number(archiveSection.batchSeq) &&
        String(row.author) === requested.author &&
        String(row.checkpoint_chain) === requested.chain &&
        String(row.checkpoint_network) === requested.network &&
        Number(row.block_index) === requested.block_index &&
        Number(row.checkpoint_seq) === requested.checkpoint_seq &&
        String(row.batch_crc32).toLowerCase() === requested.batch_crc32 &&
        Number(row.match_count) === requested.match_count &&
        Number(row.total_chunks) === (archiveSection.chunks || []).length;
}

module.exports = { foldArchiveAnchorRequest, foldArchiveRowMatches };
