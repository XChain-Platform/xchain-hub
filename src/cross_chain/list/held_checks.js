'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

function heldMetaHash(value) {
    return value === undefined || value === null || value === '' ? '' : value;
}

function heldRowVerdict({ row, heldAtSeq, latestHeldSeq, prevOriginBlock }) {
    const seq = row && row.seq;
    if (!Number.isInteger(seq) || seq < 1) return 'refuse';

    if (heldAtSeq && typeof heldAtSeq === 'object') {
        return heldAtSeq.snapshot_id === row.snapshot_id &&
            heldAtSeq.members_hash === row.members_hash &&
            heldMetaHash(heldAtSeq.meta_hash) === heldMetaHash(row.meta_hash) ?
            'pass' : 'refuse';
    }

    const latest = Number(latestHeldSeq) || 0;
    if (seq <= latest) return 'refuse';
    if (seq > latest + 1) return 'abstain';
    if (seq === 1) return 'pass';
    if (typeof prevOriginBlock !== 'number' || !Number.isFinite(prevOriginBlock)) return 'abstain';
    if (!(Number(row.origin_block) > Number(prevOriginBlock))) return 'refuse';
    return 'pass';
}

module.exports = { heldRowVerdict };
