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
 * XChain Hub - parsing for the dated .sql files under src/sql/migrations/.
 *
 * Pure functions, no I/O, so the runner in sql_migrations.js and its tests share
 * one reading of a file. Not a Database mixin: nothing here is installed on the
 * prototype.
 *
 * A file is named YYYY-MM-DD-slug.sql and sorts by name. Its first comment lines
 * may carry one directive line:
 *
 *   -- xchain:migration mode=auto [on-error=warn|fail] [gate=ENV_NAME]
 *
 *   on-error  fail (default) stops the boot and leaves the file unrecorded, so the
 *             next boot retries it. warn logs the failing statement with the text
 *             to run by hand, keeps going and records the file, for steps whose
 *             column or key is not needed to serve (the old best-effort helpers).
 *   gate      the file runs only while the named hub setting equals '1'. A closed
 *             gate skips the file WITHOUT recording it, so each boot asks again.
 *
 ********************************************************************/

'use strict';

const FILE_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.sql$/;
const DIRECTIVE = /^--\s*xchain:migration\s+(.*)$/;

function parseDirective(sql){
    const options = { mode: 'auto', onError: 'fail', gate: null };
    for(const raw of String(sql).split('\n')){
        const line = raw.trim();
        if(line === '' || !line.startsWith('--')) break;
        const match = line.match(DIRECTIVE);
        if(!match) continue;
        for(const pair of match[1].trim().split(/\s+/)){
            const eq = pair.indexOf('=');
            if(eq < 1) throw new Error('Malformed migration directive: ' + pair);
            const key = pair.slice(0, eq);
            const value = pair.slice(eq + 1);
            if(key === 'mode'){
                if(value !== 'auto') throw new Error('Unsupported migration mode: ' + value);
                options.mode = value;
            } else if(key === 'on-error'){
                if(value !== 'warn' && value !== 'fail') throw new Error('Unsupported on-error: ' + value);
                options.onError = value;
            } else if(key === 'gate'){
                if(!/^[A-Z][A-Z0-9_]*$/.test(value)) throw new Error('Malformed migration gate: ' + value);
                options.gate = value;
            } else
                throw new Error('Unknown migration directive key: ' + key);
        }
        return options;
    }
    return options;
}

// Statements end at a semicolon that closes a line; `--` comment lines are dropped
// first because a comment may itself contain a semicolon.
function splitStatements(sql){
    const body = String(sql).split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
    return body.split(/;[ \t]*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
}

function parseMigrationFile(name, sql){
    if(!FILE_NAME.test(name)) throw new Error('Not a dated migration file name: ' + name);
    const options = parseDirective(sql);
    const statements = splitStatements(sql);
    if(statements.length === 0) throw new Error('Migration file has no statements: ' + name);
    return { name, ...options, statements };
}

function isMigrationFileName(name){
    return FILE_NAME.test(name);
}

module.exports = { parseMigrationFile, splitStatements, parseDirective, isMigrationFileName };
