'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const acorn = require('acorn');
const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '../../../../src/db/index.js');

describe('database connection retry declarations', function () {
    const source = fs.readFileSync(SOURCE_FILE, 'utf8');
    const methodMatch = source.match(/async getConnection\(\)\{([\s\S]*?)^    \}/m);

    assert.ok(methodMatch, 'getConnection method body is present');
    const methodBody = methodMatch[1];
    const syntaxTree = acorn.parse('async function getConnection(){' + methodBody + '}', {
        ecmaVersion: 'latest'
    });
    const declarations = [];

    function collectDeclarations(node){
        if(!node || typeof node !== 'object')
            return;
        if(node.type === 'VariableDeclaration')
            declarations.push(node);
        for(const child of Object.values(node)){
            if(Array.isArray(child))
                child.forEach(collectDeclarations);
            else
                collectDeclarations(child);
        }
    }

    collectDeclarations(syntaxTree);

    for (const name of ['maxAttempts', 'baseDelay', 'maxDelay', 'delay', 'jitter']) {
        it('declares ' + name + ' with const', function () {
            const matchingDeclarations = declarations.filter(declaration =>
                declaration.declarations.some(declarator =>
                    declarator.id.type === 'Identifier' && declarator.id.name === name
                )
            );

            assert.ok(matchingDeclarations.some(declaration => declaration.kind === 'const'));
            assert.ok(!matchingDeclarations.some(declaration => declaration.kind === 'let'));
        });
    }
});
