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
 * Shared fixtures for the engine scrape-series tests: a real registry, a
 * sample reader, and source checks that tie a fake engine's field names to
 * the fields the real engine assigns.
 *
 **********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { installObservability } = require('../../src/observability');

const SRC = path.resolve(__dirname, '../../src');

// A real process registry with metrics on, as installMetrics builds it.
function realObservability(){
    return installObservability(null, { service: 'xchain-hub', env: { METRICS_ENABLED: 'true' } });
}

// The rendered value of one sample, or null when that sample is absent.
function sample(text, name, labels = ''){
    const escaped = (name + labels).replace(/[{}"=,]/g, (c) => '\\' + c);
    const m = text.match(new RegExp('^' + escaped + ' (\\S+)$', 'm'));
    return m ? Number(m[1]) : null;
}

// Every .js source under one src subdirectory, concatenated.
function sourceUnder(rel){
    const out = [];
    const walk = (dir) => {
        for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
            const file = path.join(dir, entry.name);
            if(entry.isDirectory()) walk(file);
            else if(entry.name.endsWith('.js')) out.push(fs.readFileSync(file, 'utf8'));
        }
    };
    walk(path.join(SRC, rel));
    return out.join('\n');
}

// True when the source assigns or increments this.<field>.
function assignsField(source, field){
    return new RegExp('this\\.' + field + '\\s*(=[^=]|\\+\\+|\\+=)').test(source);
}

// True when the source defines a method of that name.
function definesMethod(source, name){
    return new RegExp('\\b' + name + '\\s*\\([^)]*\\)\\s*\\{').test(source);
}

module.exports = { realObservability, sample, sourceUnder, assignsField, definesMethod };
