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

const registry = require('../../consensus/gate_registry.js');
const { isCanonicalOrder, listMembersHash, listMetaHash } = require('./canonical.js');
const { hasValidListMeta } = require('./version_plan.js');

const LIST_META_GATE_KEY = 'list_meta_activation.LIST_META_ACTIVATION';

function canonicalPositiveInteger(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
    return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) &&
        Number.isSafeInteger(Number(value));
}

function canonicalArray(value) {
    if (Array.isArray(value)) return isCanonicalOrder(value) ? value : null;
    if (typeof value !== 'string') return null;

    try {
        const parsed = JSON.parse(value);
        return isCanonicalOrder(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function archivedListMetaRefusal(row) {
    const active = registry.activeAt(
        LIST_META_GATE_KEY,
        row.network,
        'BTC',
        Number(row.snapshot_block),
        null
    );
    if (!active) {
        if (row.name != null || row.description != null || row.meta_hash != null) {
            return 'metadata is present below activation';
        }
        return null;
    }
    if (!hasValidListMeta(row)) return 'metadata fields are invalid';
    if (row.meta_hash !== listMetaHash(row.name, row.description)) {
        return 'metadata hash mismatch';
    }
    return null;
}

function archivedListRowRefusal(row) {
    if (!row || !canonicalPositiveInteger(row.seq)) {
        return 'seq is not a canonical positive integer';
    }

    const seq = Number(row.seq);
    if (row.kind !== (seq === 1 ? 'full' : 'delta')) return 'kind disagrees with seq';

    const added = canonicalArray(row.added);
    if (!added) return 'added is not a canonical JSON array';

    const removed = canonicalArray(row.removed);
    if (!removed) return 'removed is not a canonical JSON array';

    if (seq === 1 && listMembersHash(added) !== row.members_hash) {
        return 'full row members hash mismatch';
    }
    return archivedListMetaRefusal(row);
}

module.exports = { archivedListRowRefusal };
