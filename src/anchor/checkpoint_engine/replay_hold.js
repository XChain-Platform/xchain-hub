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
 * Pure checkpoint decisions while the indexer replays a superseded range.
 *
 ********************************************************************/

'use strict';

const { supersedeWitnessDecline, checkpointHoldDecline } =
    require('./checkpoint_hold.js');

function indexerReplayOpen(rules){
    const state = rules && rules.replay && rules.replay.state;
    return state === 'pending' || state === 'replaying';
}

function hasSupersedeFields(cp){
    return cp && (cp.supersedes_from != null || cp.rules_digest != null);
}

function supersedeCosignDecline(cp, rules, expectedSupersede){
    if(indexerReplayOpen(rules)) return 'indexer_replaying';

    cp = cp || {};
    if(!hasSupersedeFields(cp)) return null;
    if(!rules || !rules.replay || rules.replay.state !== 'replayed')
        return 'supersede_no_replay';
    if(arguments.length > 2){
        const witnessDecline = supersedeWitnessDecline(rules);
        if(witnessDecline) return witnessDecline;
        if(rules.replay.changed !== true || expectedSupersede == null)
            return 'supersede_no_disagreement';
    }
    if(Number(cp.supersedes_from) !== Number(rules.replay.target))
        return 'supersede_target_mismatch';
    if(String(cp.rules_digest).toLowerCase() !== String(rules.digest).toLowerCase())
        return 'supersede_digest_mismatch';
    return null;
}

function checkpointProposalDecline(cp, own, expectedSupersede){
    const rules = own && own.rules;
    const supersedeDecline = supersedeCosignDecline(
        cp, rules, expectedSupersede);
    return supersedeDecline || checkpointHoldDecline(cp || {}, own || {}, rules);
}

module.exports = {
    indexerReplayOpen,
    hasSupersedeFields,
    supersedeCosignDecline,
    checkpointProposalDecline,
};
