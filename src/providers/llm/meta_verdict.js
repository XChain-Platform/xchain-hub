/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const META_MIN_CORROBORATION = 2;

// One deterministic verdict shared by leader selection and follower adoption.
// `expectedN` is the responsible-set bound; a lone ok proposal under a bound
// above one is unreplicated and never corroborated.
function metaVerdict(proposals, meta, approved, expectedN) {
    if(typeof meta !== 'string' || meta === '') return 'reject_unapproved';
    const allowed = approved instanceof Set ? approved : new Set(Array.isArray(approved) ? approved : []);
    if(!allowed.has(meta)) return 'reject_unapproved';
    if(proposals.length === 1 && (Number(expectedN) || 0) > 1) return 'uncorroborated';
    if(proposals.length > 1){
        const agreeing = proposals.filter(p => p && typeof p.meta === 'string' && p.meta === meta).length;
        if(agreeing < META_MIN_CORROBORATION) return 'uncorroborated';
    }
    return 'ok';
}

module.exports = metaVerdict;
