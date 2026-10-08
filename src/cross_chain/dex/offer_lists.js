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
 * XChain Hub - DEX offer-list enforcement
 *
 * Resolve each offer's chain-local allow and block lists at the source tip that
 * supplied the open book, then apply them to the counterparty payout address.
 *
 ********************************************************************/

'use strict';

const registry = require('../../consensus/gate_registry.js');

const CROSS_CHAIN_OFFER_LIST_ENFORCEMENT =
    'cross_chain/dex/offer_lists.CROSS_CHAIN_OFFER_LIST_ENFORCEMENT';
const OFFER_LIST_STATE = Symbol('crossChainOfferListState');
const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function setState(offer, state){
    Object.defineProperty(offer, OFFER_LIST_STATE, {
        value: state,
        configurable: true,
        writable: true
    });
}

function listReference(offer, field){
    if(!Object.prototype.hasOwnProperty.call(offer, field)) return null;
    let value = offer[field];
    if(value === null || value === 0 || value === '0') return { attached: false };
    if(typeof value === 'number'){
        if(!Number.isSafeInteger(value) || value <= 0) return null;
        return { attached: true, id: value };
    }
    if(typeof value !== 'string' || !CANONICAL_POSITIVE_INTEGER.test(value)) return null;
    let id = Number(value);
    return Number.isSafeInteger(id) ? { attached: true, id } : null;
}

function validMembersAnswer(answer){
    return !!answer && !answer.error && (answer.type === 0 || answer.type === '0') &&
        Array.isArray(answer.members) &&
        answer.members.every(member => typeof member === 'string' && member.length > 0);
}

async function readMembers(engine, offer, id, cache){
    let coin = String(offer.home_coin || '');
    let block = Number(offer.home_block);
    if(!coin || !Number.isSafeInteger(block) || block < 0) return null;
    let key = coin + ':' + block + ':' + id;
    if(!cache.has(key)){
        cache.set(key, (async () => {
            try {
                let answer = await engine.indexerCall(coin, 'getlistat', {
                    list_index: id,
                    block
                });
                return validMembersAnswer(answer) ? answer.members.slice() : null;
            } catch(_e){
                return null;
            }
        })());
    }
    return cache.get(key);
}

async function prepareOne(engine, offer, cache){
    let allow = listReference(offer, 'allow_list');
    let block = listReference(offer, 'block_list');
    if(!allow || !block){
        setState(offer, { enforced: true, valid: false });
        return;
    }
    let allowMembers = allow.attached ? await readMembers(engine, offer, allow.id, cache) : null;
    let blockMembers = block.attached ? await readMembers(engine, offer, block.id, cache) : null;
    setState(offer, {
        enforced: true,
        valid: (!allow.attached || allowMembers !== null) &&
               (!block.attached || blockMembers !== null),
        allowAttached: allow.attached,
        blockAttached: block.attached,
        allowMembers,
        blockMembers
    });
}

async function prepareOfferLists(engine, offers, snapshotBlock){
    let list = Array.isArray(offers) ? offers : [];
    let cache = new Map();
    await Promise.all(list.map(async offer => {
        let active;
        try {
            active = registry.activeAt(
                CROSS_CHAIN_OFFER_LIST_ENFORCEMENT,
                offer.home_network,
                null,
                Number(snapshotBlock),
                null
            ) === true;
        } catch(_e){
            setState(offer, { enforced: true, valid: false });
            return;
        }
        if(!active){
            setState(offer, { enforced: false, valid: true });
            return;
        }
        await prepareOne(engine, offer, cache);
    }));
}

function oneSideAllows(offer, counterparty){
    let state = offer && offer[OFFER_LIST_STATE];
    if(!state || !state.enforced) return true;
    if(!state.valid) return false;
    if(!state.allowAttached && !state.blockAttached) return true;
    let payout = counterparty && counterparty.get_address;
    if(typeof payout !== 'string' || payout.length === 0) return false;
    if(state.allowAttached && !state.allowMembers.includes(payout)) return false;
    if(state.blockAttached && state.blockMembers.includes(payout)) return false;
    return true;
}

function offerPairAllowed(a, b){
    let aState = a && a[OFFER_LIST_STATE];
    let bState = b && b[OFFER_LIST_STATE];
    if(!aState && !bState) return true;
    if((aState && aState.enforced) !== (bState && bState.enforced)) return false;
    return oneSideAllows(a, b) && oneSideAllows(b, a);
}

module.exports = {
    CROSS_CHAIN_OFFER_LIST_ENFORCEMENT,
    prepareOfferLists,
    offerPairAllowed
};
