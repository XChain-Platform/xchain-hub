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
const { isValidMetaText } = require('./meta_text.js');

function makeVersion(read, originBlock, seq, kind, added, removed, metaActive) {
    const version = {
        list_type: read.type,
        seq,
        kind,
        added,
        removed,
        members_hash: read.hash,
        origin_block: originBlock
    };

    if (metaActive) {
        version.name = read.name ?? null;
        version.description = read.description ?? null;
        version.meta_hash = read.meta_hash;
    }

    return version;
}

function isValidListMetaField(value, maxBytes) {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value.includes('|') || value.includes(';') || value === '-') return false;
    if (Buffer.byteLength(value, 'utf8') > maxBytes) return false;
    return isValidMetaText(value, maxBytes, false);
}

function hasValidListMeta(read) {
    return isValidListMetaField(read.name, 64)
        && isValidListMetaField(read.description, 512)
        && typeof read.meta_hash === 'string';
}

function planListVersion({ read, originBlock, held, metaActive = false }) {
    if (read.type !== 1 && read.type !== 2) return { refuse: 'type' };
    if (!isCanonicalOrder(read.members)) return { refuse: 'order' };
    if (listMembersHash(read.members) !== read.hash) return { refuse: 'hash' };
    if (metaActive && !hasValidListMeta(read)) return { refuse: 'meta' };
    if (read.members.length > LIST_SHARE_MAX_MEMBERS) return { decline: 'max-members' };

    if (held.lastSeq === 0) {
        return {
            version: makeVersion(
                read,
                originBlock,
                1,
                'full',
                read.members.slice(),
                [],
                metaActive
            )
        };
    }

    if (Number(held.latest.list_type) !== Number(read.type)) return { refuse: 'list-type' };
    const membersUnchanged = read.hash === held.latest.members_hash;
    const metaUnchanged = !metaActive
        || read.meta_hash === (held.latest.meta_hash ?? '');
    if (membersUnchanged && metaUnchanged) return { unchanged: true };

    const folded = held.fold();
    if (folded === null || listMembersHash(folded) !== held.latest.members_hash) {
        return { refuse: 'fold' };
    }
    if (!(Number(originBlock) > Number(held.latest.origin_block))) {
        return { refuse: 'origin-block' };
    }

    const { added, removed } = listDelta(folded, read.members);
    return {
        version: makeVersion(
            read,
            originBlock,
            held.lastSeq + 1,
            'delta',
            added,
            removed,
            metaActive
        )
    };
}

module.exports = { planListVersion };
