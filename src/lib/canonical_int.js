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
 **********************************************************************
 *
 * XChain Hub - canonical integer spelling guard
 *
 * Every hub consensus engine signs its row's integer fields VERBATIM
 * (`String(r.field)` inside _canonicalMatch) but re-checks them NUMERICALLY
 * (`Number(a) === Number(b)`), and every downstream verifier rebuilds the
 * canonical from a NORMALIZED integer: the XCALL/XMATCH mirrors round-trip
 * through BIGINT columns, and the ATTEST relay legs are re-parsed with
 * parseInt() off the wire. So a Byzantine leader can propose an equivalent
 * spelling ("041", "+41", " 41", 4.1e1, or null for a field with a `|| 0`
 * fallback), pass follower validation, collect an honest quorum over bytes
 * containing that spelling, and leave a finalized row whose signatures no
 * verifier can ever reproduce. The row still exists, so the engine's own
 * _rowExists/duplicate guards never re-relay it: the call is stranded for good.
 *
 * The guard is deliberately on the FOLLOWER side and fail-closed. It leaves the
 * signed canonical format untouched, so it needs no activation flag and no
 * coordinated change in the indexer verifiers; an honest leader already builds
 * these fields with Number(), so an honest round never sees it fire.
 *
 **********************************************************************/

'use strict';

// True iff `v`'s RAW spelling is the canonical base-10 integer that every
// verifier will re-derive. Checked on the raw value, never on Number(v):
// coercing first both hides the spelling under test and silently rounds a
// BIGINT-sized field (gas_limit) past 2^53.
function isCanonicalInt(v){
    let s;
    if(typeof v === 'number'){
        // A JSON number is only ever re-serialized canonically when it is a safe
        // integer; 1e21 stringifies to '1e+21' and anything past MAX_SAFE_INTEGER
        // has already lost the digits the BIGINT column would keep.
        if(!Number.isSafeInteger(v)) return false;
        s = String(v);
    } else if(typeof v === 'string'){
        s = v;
    } else {
        return false;   // null / undefined / bigint / boolean / object: never an honest row's integer
    }
    if(!/^-?[0-9]+$/.test(s)) return false;   // rejects '+41', ' 41', '4_1', '4.1e1', ''
    if(s === '-0') return false;
    if(/^-?0[0-9]/.test(s)) return false;     // rejects leading zeros: '041', '-007'
    return String(BigInt(s)) === s;
}

// True iff every named field of `row` carries a canonical integer spelling.
// Callers pass exactly the INT/BIGINT-backed fields that enter their signed
// canonical; decimal amount fields (bcmath strings), addresses, ticks, methods,
// payloads, chains, statuses and hashes are compared as strings and must NOT be
// listed here.
function allCanonicalInts(row, fields){
    if(!row) return false;
    for(let f of fields){
        if(!isCanonicalInt(row[f])) return false;
    }
    return true;
}

module.exports = { isCanonicalInt, allCanonicalInts };
