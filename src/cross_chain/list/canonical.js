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
const ah = require('../../lib/admission_height.js');
const eq = require('../../consensus/equivocation_header.js');
const registry = require('../../consensus/gate_registry.js');

const LIST_META_GATE_KEY = 'list_meta_activation.LIST_META_ACTIVATION';

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

function listMetaHash(name, description) {
    const noName = name === null || name === undefined;
    const noDescription = description === null || description === undefined;
    if (noName && noDescription) return '';

    const text = ['LISTMETA', name ?? '', description ?? ''].join('|');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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

function deriveListSnapshotId(...args) {
    return require('./chain.js').deriveListSnapshotId(...args);
}

function foldListChain(rows) {
    return require('./chain.js').foldListChain(rows);
}

function listSnapshotCanonical(r, view) {
    const admitBlocks = ah.rowAdmitBlocks(r);
    if (admitBlocks === null) {
        throw new Error('CrossChainListShare: a row must carry an admission map');
    }

    let raw = [
        'XLISTSHARE',
        r.snapshot_id,
        String(r.snapshot_block),
        r.home_chain,
        String(r.home_list_index),
        String(r.list_type),
        String(r.seq),
        r.kind,
        String(r.origin_block),
        String(r.members_hash),
        r.network || ''
    ].join('|');
    raw += ah.admissionCanonicalField(
        'CrossChainListShare', r.network, r.snapshot_block, admitBlocks
    );
    if (registry.activeAt(LIST_META_GATE_KEY, r.network, 'BTC', r.snapshot_block, null)) {
        raw += '|' + (r.meta_hash || '');
    }

    if (eq.isEquivHeaderActive(r.snapshot_block, r.network)) {
        return eq.buildEquivCanonical(
            eq.ENGINE_TAGS.LIST_SHARE,
            r.snapshot_id,
            view != null ? view : 0,
            raw
        );
    }
    return raw;
}

module.exports = {
    isCanonicalOrder,
    listMetaHash,
    listMembersHash,
    listDelta,
    applyListDelta,
    deriveListSnapshotId,
    foldListChain,
    listSnapshotCanonical
};
