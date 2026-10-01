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

const { listMembersHash } = require('./canonical.js');

function createFoldCache(max = 64) {
    const entriesByChain = new Map();
    const oldestFirst = [];

    function find(homeChain, homeListIndex) {
        return entriesByChain.get(homeChain)?.get(homeListIndex);
    }

    function remove(entry) {
        const chainEntries = entriesByChain.get(entry.homeChain);
        chainEntries.delete(entry.homeListIndex);
        if (chainEntries.size === 0) entriesByChain.delete(entry.homeChain);
        oldestFirst.splice(oldestFirst.indexOf(entry), 1);
    }

    function store(homeChain, homeListIndex, lastSeq, latestHash, members) {
        const existing = find(homeChain, homeListIndex);
        if (existing) remove(existing);
        if (!(max > 0)) return;

        const entry = { homeChain, homeListIndex, lastSeq, latestHash, members };
        let chainEntries = entriesByChain.get(homeChain);
        if (!chainEntries) {
            chainEntries = new Map();
            entriesByChain.set(homeChain, chainEntries);
        }
        chainEntries.set(homeListIndex, entry);
        oldestFirst.push(entry);
        if (oldestFirst.length > max) remove(oldestFirst[0]);
    }

    function get(homeChain, homeListIndex, lastSeq, latestHash, fold) {
        const cached = find(homeChain, homeListIndex);
        if (cached && Number(cached.lastSeq) === Number(lastSeq) &&
            cached.latestHash === latestHash) return cached.members;

        try {
            const members = fold();
            if (!Array.isArray(members) || listMembersHash(members) !== latestHash) return null;
            store(homeChain, homeListIndex, lastSeq, latestHash, members);
            return members;
        } catch {
            return null;
        }
    }

    return { get, size: () => oldestFirst.length };
}

function numericBlock(value) {
    if (!['number', 'string', 'bigint'].includes(typeof value) ||
        (typeof value === 'string' && value.trim() === '')) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function listsDue(entries, originBlock) {
    if (!Array.isArray(entries)) return [];
    const origin = numericBlock(originBlock);
    if (origin === null) return [];
    return entries.filter(entry => {
        const shareBlock = entry !== null && typeof entry === 'object' ?
            numericBlock(entry.share_block) : null;
        return shareBlock !== null && shareBlock <= origin;
    });
}

module.exports = { createFoldCache, listsDue };
