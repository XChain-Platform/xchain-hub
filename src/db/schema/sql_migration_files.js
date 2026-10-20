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
 * Reading helpers for dated SQL migration files under src/sql/migrations.
 *
 * migrationMode is the same function the decoder's migration runner uses
 * (xchain-decoder/src/db/migration_statements.js), kept line for line so a hub
 * file and a decoder file carry one tag grammar. listDatedMigrations names the
 * files a runner would apply, in the order it would apply them.
 */
'use strict';

const fs   = require('fs');

const DATED_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

// Read a migration file's `-- xchain:migration mode=auto|manual` header tag.
// Defaults to 'manual' when absent (conservative: unknown DDL never auto-runs).
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

// The *.sql basenames in dir, sorted lexically (apply order). A missing
// directory is an empty list; an undated name is an error, because the dated
// prefix is what makes lexical order the authorship order.
function listDatedMigrations(dir){
    let names;
    try{
        names = fs.readdirSync(dir);
    }catch(e){
        if(e.code === 'ENOENT') return [];
        throw e;
    }
    const files = names.filter((n) => n.endsWith('.sql')).sort();
    for(const file of files){
        if(!DATED_PREFIX.test(file)){
            throw new Error('listDatedMigrations: migration "' + file + '" in ' + dir + ' is not dated. ' +
                'Every migration filename must start with a YYYY-MM-DD- prefix so it applies in authorship order.');
        }
    }
    return files;
}

module.exports = { migrationMode, listDatedMigrations };
