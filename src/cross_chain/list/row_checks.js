'use strict';

const { allCanonicalInts } = require('../../lib/canonical_int.js');
const { ALLOWED_CHAINS } = require('../bridge/constants.js');
const { isCanonicalOrder, listDelta } = require('./canonical.js');
const { LIST_CANONICAL_INT_FIELDS } = require('./constants.js');

function arraysEqual(left, right) {
    return Array.isArray(left) && Array.isArray(right) &&
        left.length === right.length && left.every((value, index) => value === right[index]);
}

function listRowShapeOk(row, network) {
    if (!allCanonicalInts(row, LIST_CANONICAL_INT_FIELDS)) return false;

    const listType = Number(row.list_type);
    const seq = Number(row.seq);
    return row.network === network &&
        ALLOWED_CHAINS.includes(row.home_chain) &&
        (listType === 1 || listType === 2) &&
        seq >= 1 &&
        row.kind === (seq === 1 ? 'full' : 'delta') &&
        typeof row.members_hash === 'string' &&
        /^[0-9a-f]{64}$/.test(row.members_hash) &&
        (row.meta_hash == null || row.meta_hash === '' ||
            (typeof row.meta_hash === 'string' && /^[0-9a-f]{64}$/.test(row.meta_hash)));
}

function listTransportOk(row, readMembers, prevMembers) {
    if (!row) return false;

    let added;
    let removed;
    try {
        added = JSON.parse(row.added);
        removed = JSON.parse(row.removed);
    } catch (_) {
        return false;
    }

    if (!isCanonicalOrder(added) || !isCanonicalOrder(removed)) return false;

    const seq = Number(row.seq);
    if (seq === 1) return arraysEqual(added, readMembers) && removed.length === 0;
    if (seq < 2 || !Array.isArray(prevMembers) || !Array.isArray(readMembers)) return false;

    const expected = listDelta(prevMembers, readMembers);
    return arraysEqual(added, expected.added) && arraysEqual(removed, expected.removed);
}

module.exports = { listRowShapeOk, listTransportOk };
