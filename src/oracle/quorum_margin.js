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
 * XChain Hub - Oracle quorum margin
 *
 * For one finalized oracle round, reports whether the quorum that finalized it
 * would still have held with any single signer missing (oneFaultTolerant).
 *
 *   count mode  : signers - 1 >= bftQuorum(N), the same threshold the round used.
 *   stake mode  : for every signing source, dropping that source's keys still
 *                 passes meetsStakeThreshold. A source counts once however many of
 *                 its keys signed, so the fault unit is the source.
 *
 * Read-only: nothing here feeds back into consensus.
 *
 ********************************************************************/

'use strict';

const swq = require('../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../lib/bft_quorum.js');

// round: { weighted: bool, validators: [{ pubkey, source, weight }], signers: iterable of pubkeys }
function computeQuorumMargin(round){
    let validators = (round && Array.isArray(round.validators)) ? round.validators : [];
    let signers = Array.from(new Set((round && round.signers) ? Array.from(round.signers) : []));
    let weighted = !!(round && round.weighted);
    let result = { mode: weighted ? 'stake' : 'count', met: false, oneFaultTolerant: false, signers: signers.length };

    if(weighted){
        result.met = swq.meetsStakeThreshold(validators, signers);
        if(!result.met) return result;
        let sourceOf = new Map(validators.map(v => [String(v.pubkey).toLowerCase(), v.source]));
        let sources = new Set(signers.map(pk => sourceOf.get(String(pk).toLowerCase())));
        result.oneFaultTolerant = Array.from(sources).every(src =>
            swq.meetsStakeThreshold(validators, signers.filter(pk => sourceOf.get(String(pk).toLowerCase()) !== src)));
        return result;
    }

    let quorum = bftQuorumOrSingle(validators.length, 1);
    result.quorum = quorum;
    result.met = signers.length >= quorum;
    result.oneFaultTolerant = result.met && (signers.length - 1) >= quorum;
    return result;
}

module.exports = { computeQuorumMargin };
