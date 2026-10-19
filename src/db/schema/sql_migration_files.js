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
 **********************************************************************/

'use strict';

const fs = require('fs');

function migrationMode(raw){
        // The mode tag is a leading-prologue directive: it may only sit in the run of
        // blank and `--`-comment lines BEFORE the first SQL statement. Scanning the whole
        // file would let a `mode=auto` token buried in body prose or a data literal arm
        // auto-apply for a destructive migration; a fixed first-N-lines window is too
        // tight, because the multi-line license banner pushes the tag past it and the
        // migration then silently reads as the `manual` default. Anchoring to the
        // prologue keeps both properties at any banner length.
        const lines    = String(raw).split('\n');
        const prologue = [];
        for(const line of lines){
            const trimmed = line.trim();
            if(trimmed === '' || trimmed.startsWith('--')){ prologue.push(line); continue; }
            break;   // first non-blank, non-comment line ends the prologue
        }
        const m = prologue.join('\n').match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
        return m ? m[1].toLowerCase() : 'manual';
}

function listDatedMigrations(dir){
    let files;
    try {
        files = fs.readdirSync(dir).filter(file => file.endsWith('.sql')).sort();
    } catch(error) {
        if(error.code === 'ENOENT') return [];
        throw error;
    }

    for(const file of files){
        if(!/^\d{4}-\d{2}-\d{2}-/.test(file))
            throw new Error('Migration file "' + file + '" must start with a YYYY-MM-DD- prefix.');
    }
    return files;
}

module.exports = { migrationMode, listDatedMigrations };
