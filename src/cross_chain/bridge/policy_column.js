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
 * XChain Hub - Bridge policy column codec
 *
 ********************************************************************/

'use strict';

const { parseListRef } = require('./list_ref.js');

function parsePolicyColumn(raw, refsAllowed){
    if(raw == null) return null;

    let value;
    try {
        value = JSON.parse(raw);
    } catch(err){
        return undefined;
    }

    if(Array.isArray(value)) return value.map(String);
    if(typeof value === 'string' && refsAllowed === true && parseListRef(value)){
        return { ref: value };
    }
    return undefined;
}

function policyColumnText(side){
    if(side === null) return null;
    if(Array.isArray(side)) return JSON.stringify(side);
    if(side && typeof side === 'object' && parseListRef(side.ref)){
        return JSON.stringify(side.ref);
    }
    throw new TypeError('Invalid bridge policy column value');
}

module.exports = { parsePolicyColumn, policyColumnText };
