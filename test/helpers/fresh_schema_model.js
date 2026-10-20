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
 * The schema a fresh hub ends up with, read straight off the src/sql CREATE
 * TABLE files bootstrap creates its tables from, as the same information_schema
 * rows the migration runner reads from a live database. A test hands these rows
 * to the end-state check to ask what a fresh install would make of a migration.
 *
 * Only what the end-state check reads is modelled: each column's data type,
 * column type, declared character set and character length, and each index's
 * name, uniqueness and key columns in order, whether the index is declared in
 * the CREATE TABLE body or by a CREATE INDEX statement after it.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const strip = (sql) => Database.prototype.stripSqlLineComments.call(null, sql);

function topLevel(text){
    const out = [];
    let depth = 0, quote = null, cur = '';
    for(const ch of text){
        if(quote){ cur += ch; if(ch === quote) quote = null; continue; }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; cur += ch; continue; }
        if(ch === '(') depth++;
        if(ch === ')') depth--;
        if(ch === ',' && depth === 0){ out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if(cur.trim()) out.push(cur.trim());
    return out;
}

const bare = (s) => s.replace(/`/g, '').trim().toLowerCase();
const keyCols = (list) => list.split(',').map(c => bare(c).replace(/\(\s*\d+\s*\)$/, '')).filter(Boolean);

function columnRow(table, line, tableCharset){
    const m = line.match(/^`?(\w+)`?\s+([\s\S]+)$/);
    if(!m) throw new Error('unparsed column line in ' + table + ': ' + line);
    const def = m[2].trim();
    const dt = def.match(/^(\w+)/)[1].toLowerCase();
    const enumBody = def.match(/^ENUM\s*\(([^)]*)\)/i);
    const len = def.match(/^(?:VAR)?CHAR\s*\(\s*(\d+)\s*\)/i);
    const cs = def.match(/\bCHARACTER\s+SET\s+(\w+)/i);
    const textual = /char|text|enum/.test(dt);
    return {
        t: table, c: m[1], dt,
        ct: enumBody ? 'enum(' + enumBody[1].replace(/\s+/g, '') + ')' : def.split(/\s+/)[0].toLowerCase(),
        cs: cs ? cs[1].toLowerCase() : (textual ? tableCharset : null),
        len: len ? Number(len[1]) : null
    };
}

// Index of the ')' that closes the '(' just before `from`, outside quotes.
function matchingParen(sql, from){
    let depth = 1, quote = null;
    for(let i = from; i < sql.length; i++){
        const ch = sql[i];
        if(quote){ if(ch === quote) quote = null; continue; }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; continue; }
        if(ch === '(') depth++;
        if(ch === ')' && --depth === 0) return i;
    }
    throw new Error('unbalanced CREATE TABLE');
}

function indexRows(table, name, unique, cols){
    return cols.map(c => ({ t: table, i: name, c, nu: unique ? 0 : 1 }));
}

// One CREATE TABLE file into column and index rows.
function tableRows(file){
    const sql = strip(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
    const head = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(/i);
    if(!head) return { columns: [], indexes: [] };
    const table = head[1];
    const open = head.index + head[0].length;
    const close = matchingParen(sql, open);
    const body = sql.slice(open, close);
    const tail = sql.slice(close + 1).split(';')[0];
    const charset = (tail.match(/CHARSET\s*=?\s*(\w+)/i) || [])[1];
    const tableCharset = charset ? charset.toLowerCase() : null;
    const columns = [], indexes = [];
    for(const part of topLevel(body)){
        let k;
        if((k = part.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i))) indexes.push(...indexRows(table, 'PRIMARY', true, keyCols(k[1])));
        else if((k = part.match(/^(?:CONSTRAINT\s+\S+\s+)?UNIQUE\s+(?:KEY|INDEX)?\s*`?(\w*)`?\s*\(([^)]*)\)/i))){
            const cols = keyCols(k[2]);
            indexes.push(...indexRows(table, k[1] || cols[0], true, cols));
        }
        else if((k = part.match(/^(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i))) indexes.push(...indexRows(table, k[1], false, keyCols(k[2])));
        else if(/^(?:CHECK|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL)\b/i.test(part)) continue;
        else {
            const row = columnRow(table, part, tableCharset);
            columns.push(row);
            if(/\bPRIMARY\s+KEY\b/i.test(part)) indexes.push(...indexRows(table, 'PRIMARY', true, [bare(row.c)]));
            else if(/\bUNIQUE\b/i.test(part)) indexes.push(...indexRows(table, row.c, true, [bare(row.c)]));
        }
    }
    // Indexes the file declares as statements after the table, CREATE [UNIQUE] INDEX.
    const standalone = /CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(([^)]*)\)/gi;
    let k;
    while((k = standalone.exec(sql)) !== null) indexes.push(...indexRows(k[3], k[2], !!k[1], keyCols(k[4])));
    return { columns, indexes };
}

// Every src/sql table, as { columns, indexes } information_schema-shaped rows.
function freshSchemaRows(){
    const out = { columns: [], indexes: [] };
    for(const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql')).sort()){
        const rows = tableRows(file);
        out.columns.push(...rows.columns);
        out.indexes.push(...rows.indexes);
    }
    return out;
}

// A column's definition as its src/sql CREATE TABLE declares it, name and
// comments dropped and whitespace collapsed; null when the table does not declare it.
function declaredColumnDefinition(table, column){
    const file = path.join(SQL_DIR, table + '.sql');
    if(!fs.existsSync(file)) return null;
    const cols = Database.prototype.parseExpectedColumns.call(Database.prototype, fs.readFileSync(file, 'utf8')) || [];
    const hit = cols.find(c => c.name.toLowerCase() === String(column).toLowerCase());
    return hit ? hit.definition.replace(/^`?\w+`?\s+/, '').replace(/\s+/g, ' ').trim() : null;
}

// An index as src/sql declares it, { columns, unique }, or null when it does not.
function declaredIndex(table, name){
    const rows = freshSchemaRows().indexes.filter(r =>
        r.t.toLowerCase() === String(table).toLowerCase() && r.i.toLowerCase() === String(name).toLowerCase());
    if(rows.length === 0) return null;
    return { columns: rows.map(r => r.c.toLowerCase()), unique: rows.every(r => r.nu === 0) };
}

module.exports = { freshSchemaRows, declaredColumnDefinition, declaredIndex, SQL_DIR };
