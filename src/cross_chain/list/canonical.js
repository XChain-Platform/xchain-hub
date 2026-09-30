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

const crypto = require('crypto');

function compareMembers(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isCanonicalOrder(list) {
    if (!Array.isArray(list) || list.some(member => typeof member !== 'string')) return false;

    for (let i = 1; i < list.length; i++) {
        if (compareMembers(list[i - 1], list[i]) >= 0) return false;
    }
    return true;
}

function listMembersHash(members) {
    if (!Array.isArray(members)) throw new TypeError('members must be an array');
    const text = ['MEMBERS', String(members.length)].concat(members).join('|');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function listDelta(prev, next) {
    if (!Array.isArray(prev) || !Array.isArray(next)) {
        throw new TypeError('prev and next must be arrays');
    }

    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    const added = [...nextSet].filter(member => !prevSet.has(member)).sort(compareMembers);
    const removed = [...prevSet].filter(member => !nextSet.has(member)).sort(compareMembers);
    return { added, removed };
}

function applyListDelta(prev, added, removed) {
    if (!Array.isArray(prev) || !isCanonicalOrder(added) || !isCanonicalOrder(removed)) return null;

    const prevSet = new Set(prev);
    const addedSet = new Set(added);
    if (added.some(member => prevSet.has(member)) ||
        removed.some(member => !prevSet.has(member) || addedSet.has(member))) return null;

    const result = new Set(prevSet);
    for (const member of removed) result.delete(member);
    for (const member of added) result.add(member);
    return [...result].sort(compareMembers);
}

module.exports = { isCanonicalOrder, listMembersHash, listDelta, applyListDelta };
