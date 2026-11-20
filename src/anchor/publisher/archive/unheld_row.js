/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ANCHOR publisher - unheld archive row verification
 *
 ********************************************************************/

'use strict';

function comparable(row){
    const out = Object.assign({}, row);
    delete out.id;
    delete out.validator_signatures;
    return out;
}

// The integer form indexer recovery requires of an archived column: a non-negative safe number.
function archivedInteger(value){
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// id is a per-hub cursor, so the compare leaves it out; recovery still rejects a row whose id is
// not an integer, so a co-signer checks its shape instead of its value.
function archivedIdRefusal(row){
    return archivedInteger(row && row.id) ? null : 'has a malformed id';
}

// validator_signatures is left out of comparisons, but recovery requires a string.
function archivedSignaturesRefusal(row){
    return row && typeof row.validator_signatures === 'string'
        ? null : 'has malformed validator_signatures';
}

function reserializeRefusal(row, serialized){
    if(JSON.stringify(comparable(serialized)) !== JSON.stringify(comparable(row)))
        return 'does not re-serialize unchanged with no held row';
    return null;
}

// Return why an unheld row is not the shape the archive builder emits, or null.
// Require unsigned status and key lists to match all row kinds that carry status.
function unheldRowRefusal(row, serialized, statuses){
    const shape = reserializeRefusal(row, serialized);
    if(shape) return shape;
    if(!statuses.includes(row.status))
        return 'is ' + row.status + ' with no held row';
    return null;
}

// The price tables key coin_pair under a case-insensitive, trailing-space-padded collation, so two
// spellings of one pair are one database key. Compare keys through this fold, never raw strings.
function priceKeyFold(row){
    return JSON.stringify([Number(row.round_number), String(row.coin_pair).replace(/ +$/, '').toLowerCase()]);
}

function samePriceKey(first, second){
    return priceKeyFold(first) === priceKeyFold(second);
}

module.exports = {
    comparable, archivedInteger, archivedIdRefusal, archivedSignaturesRefusal,
    reserializeRefusal, unheldRowRefusal, priceKeyFold, samePriceKey
};
