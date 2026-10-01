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
 * XChain Hub - Bridge policy list references
 *
 ********************************************************************/

'use strict';

const { ALLOWED_CHAINS } = require('../../anchor/checkpoint_engine/constants.js');

const LIST_REF_PATTERN = /^([A-Z]+):([1-9][0-9]{0,14})$/;

function parseListRef(value, chains = ALLOWED_CHAINS){
    if(typeof value !== 'string') return null;
    const match = LIST_REF_PATTERN.exec(value);
    if(!match || !chains.includes(match[1])) return null;
    return { chain: match[1], index: match[2] };
}

function formatListRef(chain, index){
    return chain + ':' + index;
}

function sideKind(value){
    if(Array.isArray(value)) return 'members';
    if(value == null) return 'none';
    if(parseListRef(value)) return 'ref';
    return 'bad';
}

module.exports = { parseListRef, formatListRef, sideKind };
