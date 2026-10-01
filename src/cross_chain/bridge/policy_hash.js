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
 * XChain Hub - Bridge policy hash
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

function policyHashText(allow, block, sleeping, refs){
    const part = (label, list, ref) => {
        if(ref !== null && ref !== undefined) return [label, 'REF', String(ref)];
        if(list === null || list === undefined) return [label, '-'];
        return [label, String(list.length)].concat(list.map(String));
    };
    return part('ALLOW', allow, refs && refs.allow)
        .concat(part('BLOCK', block, refs && refs.block))
        .concat(['SLEEP', sleeping ? '1' : '0'])
        .join('|');
}

function policyHash(allow, block, sleeping, refs){
    const text = policyHashText(allow, block, sleeping, refs);
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { policyHashText, policyHash };
