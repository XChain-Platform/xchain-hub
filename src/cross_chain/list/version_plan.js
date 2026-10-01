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

const {
    isCanonicalOrder,
    listMembersHash,
    listDelta
} = require('./canonical.js');
const { LIST_SHARE_MAX_MEMBERS } = require('./constants.js');

function makeVersion(read, originBlock, seq, kind, added, removed) {
    return {
        list_type: read.type,
        seq,
        kind,
        added,
        removed,
        members_hash: read.hash,
        origin_block: originBlock
    };
}

function planListVersion({ read, originBlock, held }) {
    if (read.type !== 1 && read.type !== 2) return { refuse: 'type' };
    if (!isCanonicalOrder(read.members)) return { refuse: 'order' };
    if (listMembersHash(read.members) !== read.hash) return { refuse: 'hash' };
    if (read.members.length > LIST_SHARE_MAX_MEMBERS) return { decline: 'max-members' };

    if (held.lastSeq === 0) {
        return {
            version: makeVersion(read, originBlock, 1, 'full', read.members.slice(), [])
        };
    }

    if (Number(held.latest.list_type) !== Number(read.type)) return { refuse: 'list-type' };
    if (read.hash === held.latest.members_hash) return { unchanged: true };

    const folded = held.fold();
    if (folded === null || listMembersHash(folded) !== held.latest.members_hash) {
        return { refuse: 'fold' };
    }
    if (!(Number(originBlock) > Number(held.latest.origin_block))) {
        return { refuse: 'origin-block' };
    }

    const { added, removed } = listDelta(folded, read.members);
    return {
        version: makeVersion(read, originBlock, held.lastSeq + 1, 'delta', added, removed)
    };
}

module.exports = { planListVersion };
