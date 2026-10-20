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
 * XChain Hub - the end state a dated migration file leaves, read off its own
 * statements, and the check of that end state against a live schema.
 *
 * The runner baselines a pending file (records it as applied, runs nothing) when
 * the database already holds everything the file would produce. A fresh hub gets
 * that shape from the src/sql CREATE TABLE files, and a deployed hub got it from
 * the boot-time steps these files replaced, so both record the files without a
 * statement run, while a hub that is genuinely behind keeps the file pending.
 *
 * The plan is derived from the SQL rather than restated beside it, so a file and
 * its baseline check cannot drift apart. Only the statement shapes below are
 * understood; any other statement makes the file unplannable, and an unplannable
 * file is never baselined, so a runbook-style file always waits for an operator.
 *
 * Pure functions over plain data: the runner reads information_schema and hands
 * the rows in, so this file holds no SQL of its own to run.
 *
 ********************************************************************/

'use strict';

const NAME = '`?(\\w+)`?';

// Statement and clause shapes the planner understands.
const ALTER_TABLE    = new RegExp('^ALTER\\s+TABLE\\s+' + NAME + '\\s+([\\s\\S]+)$', 'i');
const MODIFY_COLUMN  = new RegExp('^MODIFY\\s+(?:COLUMN\\s+)?' + NAME + '\\s+([\\s\\S]+)$', 'i');
const ADD_COLUMN     = new RegExp('^ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + NAME + '\\s+[\\s\\S]+$', 'i');
const ADD_INDEX      = new RegExp('^ADD\\s+(UNIQUE\\s+)?(?:INDEX|KEY)\\s+(IF\\s+NOT\\s+EXISTS\\s+)?' + NAME + '\\s*\\(([^)]*)\\)$', 'i');
const DROP_INDEX     = new RegExp('^DROP\\s+(?:INDEX|KEY)\\s+(?:IF\\s+EXISTS\\s+)?' + NAME + '$', 'i');
const DROP_PRIMARY   = /^DROP\s+PRIMARY\s+KEY$/i;
const ADD_PRIMARY    = /^ADD\s+PRIMARY\s+KEY\s*\(([^)]*)\)$/i;
// Row-level steps that serve the DDL beside them: the dedup before a unique key and
// the backfill before a widened one. They change rows, not shape, so they carry no
// end state of their own; the key they prepare for stands for them.
const DATA_STATEMENT = /^(?:DELETE|UPDATE)\b/i;

// Split on commas outside parentheses and quotes, so ENUM('a','b') and a key's
// column list stay one clause.
function topLevelClauses(text){
    const out = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for(const ch of text){
        if(quote){ current += ch; if(ch === quote) quote = null; continue; }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; current += ch; continue; }
        if(ch === '(') depth++;
        if(ch === ')') depth--;
        if(ch === ',' && depth === 0){ out.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if(current.trim() !== '') out.push(current.trim());
    return out;
}

// "(a, `b`, c(20))" style column list to bare lowercased names in key order.
function keyColumns(list){
    return String(list).split(',')
        .map(s => s.trim().replace(/`/g, '').replace(/\(\s*\d+\s*\)$/, '').toLowerCase())
        .filter(Boolean);
}

// What a MODIFY's restated definition says the live column must read back as: the
// same idempotence tests the boot-time helpers applied before issuing their ALTER.
function columnExpectation(definition){
    const def = String(definition).trim();
    const typeMatch = def.match(/^(\w+)/);
    const expect = { dataType: typeMatch ? typeMatch[1].toLowerCase() : null };
    if(expect.dataType === 'enum'){
        const body = def.match(/^ENUM\s*\(([^)]*)\)/i);
        expect.enumValues = body ? (body[1].match(/'((?:[^']|'')*)'/g) || []).map(v => v.slice(1, -1).toLowerCase()) : [];
    }
    const length = def.match(/^(?:VAR)?CHAR\s*\(\s*(\d+)\s*\)/i);
    if(length) expect.minLength = Number(length[1]);
    const charset = def.match(/\bCHARACTER\s+SET\s+(\w+)/i);
    if(charset) expect.charset = charset[1].toLowerCase();
    return expect;
}

function noteIndex(plan, table, name, change){
    const key = table + '.' + name;
    const prior = plan.indexes.get(key);
    const droppedEarlier = !!(prior && prior.dropped);
    plan.indexes.set(key, Object.assign({ table, name, dropped: droppedEarlier }, change));
}

// One ALTER clause into the plan; false when the clause is not a known shape.
function planClause(plan, table, clause){
    let m;
    if((m = clause.match(MODIFY_COLUMN))){
        plan.columns.push({ table, column: m[1].toLowerCase(), expect: columnExpectation(m[2]) });
        return true;
    }
    if((m = clause.match(ADD_COLUMN))){
        plan.columns.push({ table, column: m[1].toLowerCase(), expect: {} });
        return true;
    }
    if((m = clause.match(ADD_INDEX))){
        const name = m[3].toLowerCase();
        const prior = plan.indexes.get(table + '.' + name);
        // IF NOT EXISTS is satisfied by the name alone, unless this file dropped that
        // name first: then the ADD always builds, and its column list is the end state.
        const exact = !m[2] || !!(prior && prior.dropped);
        noteIndex(plan, table, name, { present: true, unique: !!m[1], columns: keyColumns(m[4]), exact });
        return true;
    }
    if((m = clause.match(DROP_INDEX))){
        noteIndex(plan, table, m[1].toLowerCase(), { present: false, dropped: true });
        return true;
    }
    if(DROP_PRIMARY.test(clause)){
        noteIndex(plan, table, 'primary', { present: false, dropped: true });
        return true;
    }
    if((m = clause.match(ADD_PRIMARY))){
        noteIndex(plan, table, 'primary', { present: true, unique: true, columns: keyColumns(m[1]), exact: true });
        return true;
    }
    return false;
}

// The end state of a file's statements: the columns it restates or adds, and the
// last word it says about each index it touches. Statements it cannot read are
// collected in `unknown`, which makes the plan unusable as a baseline witness.
function planEndState(statements){
    const plan = { columns: [], indexes: new Map(), unknown: [] };
    for(const raw of statements){
        const stmt = String(raw).replace(/\s+/g, ' ').trim();
        if(stmt === '') continue;
        if(DATA_STATEMENT.test(stmt)) continue;
        const alter = stmt.match(ALTER_TABLE);
        if(!alter){ plan.unknown.push(stmt); continue; }
        const table = alter[1].toLowerCase();
        for(const clause of topLevelClauses(alter[2]))
            if(!planClause(plan, table, clause)) plan.unknown.push(stmt);
    }
    return plan;
}

// information_schema rows into the shape unmetEndState reads: per table, its
// columns by name and its indexes by name with their key columns in order.
function schemaModel(columnRows, indexRows){
    const tables = new Map();
    const tableOf = (name) => {
        const key = String(name).toLowerCase();
        if(!tables.has(key)) tables.set(key, { columns: new Map(), indexes: new Map() });
        return tables.get(key);
    };
    for(const r of columnRows || []){
        tableOf(r.t).columns.set(String(r.c).toLowerCase(), {
            dataType:  String(r.dt || '').toLowerCase(),
            columnType: String(r.ct || '').toLowerCase(),
            charset:   r.cs == null ? null : String(r.cs).toLowerCase(),
            maxLength: r.len == null ? null : Number(r.len)
        });
    }
    for(const r of indexRows || []){
        const indexes = tableOf(r.t).indexes;
        const name = String(r.i).toLowerCase();
        if(!indexes.has(name)) indexes.set(name, { columns: [], unique: true });
        const index = indexes.get(name);
        index.columns.push(String(r.c).toLowerCase());
        if(Number(r.nu) !== 0) index.unique = false;
    }
    return tables;
}

function columnShortfall(live, expect){
    if(expect.dataType && live.dataType !== expect.dataType) return 'is ' + live.dataType + ', not ' + expect.dataType;
    for(const v of expect.enumValues || [])
        if(live.columnType.indexOf("'" + v + "'") === -1) return 'lacks ENUM value ' + v;
    if(expect.minLength != null && !(live.maxLength >= expect.minLength))
        return 'holds ' + live.maxLength + ' characters, not ' + expect.minLength;
    if(expect.charset && live.charset !== expect.charset) return 'is ' + live.charset + ', not ' + expect.charset;
    return null;
}

function indexShortfall(live, want){
    if(!want.present) return live ? 'is still present' : null;
    if(!live) return 'is absent';
    if(want.unique && !live.unique) return 'is not unique';
    if(want.exact && live.columns.join(',') !== want.columns.join(','))
        return 'covers (' + live.columns.join(', ') + '), not (' + want.columns.join(', ') + ')';
    return null;
}

// Every way the live schema falls short of the plan, as readable lines. An empty
// list means the file's end state already holds; an unplannable or empty plan
// never reads as satisfied, so it can never be baselined.
function unmetEndState(plan, model){
    if(plan.unknown.length > 0) return ['unrecognized statement: ' + plan.unknown[0].slice(0, 120)];
    if(plan.columns.length === 0 && plan.indexes.size === 0) return ['the file states no schema end state'];
    const unmet = [];
    for(const want of plan.columns){
        const table = model.get(want.table);
        const live = table && table.columns.get(want.column);
        if(!live){ unmet.push(want.table + '.' + want.column + ' is absent'); continue; }
        const why = columnShortfall(live, want.expect);
        if(why) unmet.push(want.table + '.' + want.column + ' ' + why);
    }
    for(const want of plan.indexes.values()){
        const table = model.get(want.table);
        const why = indexShortfall(table && table.indexes.get(want.name), want);
        if(why) unmet.push(want.table + ' index ' + want.name + ' ' + why);
    }
    return unmet;
}

module.exports = { planEndState, schemaModel, unmetEndState, columnExpectation, keyColumns };
