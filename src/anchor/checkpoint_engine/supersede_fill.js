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

function supersedeFieldsFor(rules, finalizedRows) {
    if(!rules || !rules.replay || rules.replay.state !== 'replayed') return null;

    const rawTarget = rules.replay.target;
    if(typeof rawTarget !== 'number' && typeof rawTarget !== 'string') return null;
    if(typeof rawTarget === 'string' && rawTarget.trim() === '') return null;

    const target = Number(rawTarget);
    if(!Number.isSafeInteger(target) || target < 0) return null;
    if(typeof rules.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(rules.digest)) return null;

    const digest = rules.digest.toLowerCase();
    const alreadyUsed = Array.isArray(finalizedRows) && finalizedRows.some((row) =>
        row && typeof row.rules_digest === 'string' && row.rules_digest.toLowerCase() === digest);
    if(alreadyUsed) return null;

    return { supersedes_from: target, rules_digest: digest };
}

function supersedeGateRefusal(cp, gateActive) {
    return hasSupersedeFields(cp) && gateActive !== true ? 'supersede_below_gate' : null;
}

module.exports = { supersedeFieldsFor, supersedeGateRefusal };
