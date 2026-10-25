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
 * State checkpoint engine - supersession field fill and gate refusal.
 *
 * Pure decisions for completed replay rules and supersession gating.
 *
 ********************************************************************/

'use strict';

const { hasSupersedeFields } = require('./supersede_suffix.js');

function replayWindowFor(rules, requireWitness = true) {
    if(!rules || !rules.replay || rules.replay.state !== 'replayed') return null;

    const replay = rules.replay;
    const hasWitnessFields = Object.prototype.hasOwnProperty.call(replay, 'witness') ||
        Object.prototype.hasOwnProperty.call(replay, 'changed');
    if((requireWitness || hasWitnessFields) &&
       (replay.witness !== 'passed' || replay.changed !== true)) return null;

    const rawTarget = replay.target;
    if(typeof rawTarget !== 'number' && typeof rawTarget !== 'string') return null;
    if(typeof rawTarget === 'string' && rawTarget.trim() === '') return null;

    const target = Number(rawTarget);
    if(!Number.isSafeInteger(target) || target < 0) return null;
    const rawReplayTo = replay.replay_to;
    if(typeof rawReplayTo !== 'number' && typeof rawReplayTo !== 'string') return null;
    if(typeof rawReplayTo === 'string' && rawReplayTo.trim() === '') return null;
    const replayTo = Number(rawReplayTo);
    if(!Number.isSafeInteger(replayTo) || replayTo < target) return null;
    if(typeof rules.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(rules.digest)) return null;

    return { target, replay_to: replayTo, rules_digest: rules.digest.toLowerCase() };
}

function supersedeFieldsFor(rules, finalizedRows) {
    const replayWindow = replayWindowFor(rules, false);
    if(!replayWindow || !Array.isArray(finalizedRows)) return null;

    const disagrees = finalizedRows.some((row) => {
        if(!row) return false;
        const rawDigest = row.effective_rules_digest != null
            ? row.effective_rules_digest : row.rules_digest;
        return typeof rawDigest !== 'string' ||
            rawDigest.toLowerCase() !== replayWindow.rules_digest;
    });
    if(!disagrees) return null;

    return {
        supersedes_from: replayWindow.target,
        rules_digest: replayWindow.rules_digest,
    };
}

function supersedeGateRefusal(cp, gateActive) {
    return hasSupersedeFields(cp) && gateActive !== true ? 'supersede_below_gate' : null;
}

module.exports = { replayWindowFor, supersedeFieldsFor, supersedeGateRefusal };
