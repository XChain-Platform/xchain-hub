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

const {
    isCanonicalOrder,
    listMembersHash,
    applyListDelta
} = require('./canonical.js');

function deriveListSnapshotId(network, homeChain, homeListIndex, seq, snapshotBlock) {
    const text = [
        'XLISTSHARE',
        network,
        `${homeChain}:${homeListIndex}`,
        seq,
        snapshotBlock
    ].join('|');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function foldListChain(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;

    let members = null;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.seq !== i + 1) return null;

        if (i === 0) {
            if (row.kind !== 'full' || !isCanonicalOrder(row.added) ||
                !Array.isArray(row.removed) || row.removed.length !== 0) return null;
            members = row.added.slice();
        } else {
            if (row.kind !== 'delta') return null;
            members = applyListDelta(members, row.added, row.removed);
            if (members === null) return null;
        }

        if (listMembersHash(members) !== row.members_hash) return null;
    }
    return members;
}

module.exports = { deriveListSnapshotId, foldListChain };
