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
 ********************************************************************/

'use strict';

function readParenthesized(text, from){
    text = String(text);
    let open = Number(from) || 0;
    while(/\s/.test(text[open] || '')) open++;
    if(text[open] !== '(') return { complete: false, body: null };
    let depth = 1;
    let quote = null;
    for(let i = open + 1; i < text.length; i++){
        const ch = text[i];
        if(quote){
            if(ch === '\\' && quote !== '`'){ i++; continue; }
            if(ch === quote){
                if(text[i + 1] === quote) i++;
                else quote = null;
            }
            continue;
        }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; continue; }
        if(ch === '(') depth++;
        else if(ch === ')' && --depth === 0)
            return { complete: true, body: text.slice(open + 1, i), end: i + 1 };
    }
    return { complete: false, body: null };
}

module.exports = { readParenthesized };
