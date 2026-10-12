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
 * XChain Hub - Mirror Signer-Set Rank
 *
 * The replace rule for a mirrored response whose signer set differs from the
 * stored one: a set made of lower-ranked members of the round's responsible set
 * wins, so every hub converges on the same stored set whatever order it hears
 * them in. Pure and unwired; signatures are checked by the caller.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // Positions of the pubkeys in the responsible set (rank order), ascending, or
    // null when any pubkey is outside the set or repeats.
    signerRankVector(pubkeys, responsible){
        if (!Array.isArray(pubkeys) || !Array.isArray(responsible)) return null;
        const rank = new Map();
        responsible.forEach((pk, i) => {
            const k = String(pk).toLowerCase();
            if (!rank.has(k)) rank.set(k, i);
        });
        const out = [];
        const seen = new Set();
        for (const pk of pubkeys){
            if (typeof pk !== 'string') return null;
            const k = pk.toLowerCase();
            if (seen.has(k) || !rank.has(k)) return null;
            seen.add(k);
            out.push(rank.get(k));
        }
        return out.sort((a, b) => a - b);
    },

    // True only when the incoming set is valid, holds exactly `redundancy` members
    // and its rank vector is lexicographically lower than the stored one (a strict
    // prefix is lower; an invalid stored set loses; equal is not better).
    isRankBetterSignerSet(incoming, stored, responsible, redundancy){
        const inc = module.exports.signerRankVector(incoming, responsible);
        if (inc === null || inc.length !== redundancy) return false;
        const sto = module.exports.signerRankVector(stored, responsible);
        if (sto === null) return true;
        const n = Math.min(inc.length, sto.length);
        for (let i = 0; i < n; i++){
            if (inc[i] !== sto[i]) return inc[i] < sto[i];
        }
        return inc.length < sto.length;
    },
};
