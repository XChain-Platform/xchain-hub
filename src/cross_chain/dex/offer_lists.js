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
 **********************************************************************
 *
 * XChain Hub - DEX Offer List Rules
 *
 * Pure allow-list and block-list admission rules for already-resolved list answers.
 *
 ********************************************************************/

function attachedListIds(offer){
    if(offer === null || typeof offer !== 'object') return [];

    let attached = [];
    for(let field of ['allow_list', 'block_list']){
        let value = offer[field];
        if(value === null || value === undefined) continue;
        let id = Number(value);
        if(id !== 0) attached.push({ field, id });
    }
    return attached;
}

function resolvedMembers(answer){
    if(answer === null || typeof answer !== 'object' || 'error' in answer || answer.type !== 2 ||
       !Array.isArray(answer.members) || answer.members.length === 0 ||
       !answer.members.every(member => typeof member === 'string' && member.length > 0)) return null;
    return answer.members.slice();
}

function offerListVerdict(offer, answers, taker){
    let attached = attachedListIds(offer);
    if(attached.length === 0) return { admitted: true, reason: null };
    if(typeof taker !== 'string' || taker.length === 0){
        return { admitted: false, reason: 'taker address missing' };
    }

    for(let list of attached){
        let allow = list.field === 'allow_list';
        let members = resolvedMembers(answers && answers[allow ? 'allow' : 'block']);
        if(members === null){
            return { admitted: false, reason: allow ? 'allow list unresolved' : 'block list unresolved' };
        }
        if(allow && !members.includes(taker)){
            return { admitted: false, reason: 'taker not on allow list' };
        }
        if(!allow && members.includes(taker)){
            return { admitted: false, reason: 'taker on block list' };
        }
    }
    return { admitted: true, reason: null };
}

module.exports = { attachedListIds, resolvedMembers, offerListVerdict };
