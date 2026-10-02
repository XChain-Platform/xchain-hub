'use strict';

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
 ********************************************************************/

const { isCanonicalOrder, listMembersHash } = require('./canonical.js');
const { LIST_SHARE_MAX_MEMBERS } = require('./constants.js');

function nullableMetaValue(value) {
    return value === undefined || value === null ? null : value;
}

function ownReadVerdict({
    row,
    sharedLists,
    homeTip,
    confirmations,
    read,
    heldListType = null,
    metaActive = false
}) {
    if (!Array.isArray(sharedLists) ||
        !Number.isSafeInteger(homeTip) || homeTip < 0 ||
        !Number.isSafeInteger(confirmations) || confirmations < 0 ||
        !read || typeof read !== 'object' ||
        Object.prototype.hasOwnProperty.call(read, 'error') ||
        !Array.isArray(read.members)) return 'abstain';

    const shared = sharedLists.some(entry => entry && typeof entry === 'object' &&
        Number(entry.root_index) === Number(row.home_list_index) &&
        Number(entry.share_block) <= Number(row.origin_block));
    if (!shared) return 'refuse';

    if (Number(row.origin_block) + confirmations > homeTip) return 'refuse';
    if (Number(read.type) !== Number(row.list_type) ||
        (heldListType !== null && Number(read.type) !== Number(heldListType))) return 'refuse';
    if (!isCanonicalOrder(read.members) ||
        read.members.length > LIST_SHARE_MAX_MEMBERS ||
        listMembersHash(read.members) !== row.members_hash) return 'refuse';
    if (!metaActive &&
        (nullableMetaValue(row.name) !== null ||
            nullableMetaValue(row.description) !== null ||
            nullableMetaValue(row.meta_hash) !== null)) return 'refuse';
    const compareMeta = metaActive ||
        (typeof row.meta_hash === 'string' && row.meta_hash.length > 0);
    if (metaActive && typeof row.meta_hash !== 'string') return 'refuse';
    if (compareMeta &&
        (read.meta_hash !== row.meta_hash ||
            nullableMetaValue(read.name) !== nullableMetaValue(row.name) ||
            nullableMetaValue(read.description) !== nullableMetaValue(row.description))) {
        return 'refuse';
    }

    return 'pass';
}

module.exports = { ownReadVerdict };
