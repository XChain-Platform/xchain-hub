'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Test code belongs under test/, never under src/. Lanes kept landing
// self-tests inside production modules (a node:test import behind
// `require.main === module`, a chai acceptance file beside the code it
// covers), and nothing refused them at push time. This suite parses every
// file under src/ and fails on:
//   - an import, dynamic import or require of node:test, node:assert,
//     assert, mocha or chai (or any of their subpaths)
//   - a globalThis.it / globalThis.describe call anywhere
//   - a bare it( / describe( call at module level, where mocha registers
//     suites
//   - a `require.main === module` block that registers tests
// A `require.main === module` block on its own is a command-line entry point
// (src/db/migration/migrate.js has one) and stays allowed.
//
// The scan is AST based, so lookalikes in comments, strings and methods such
// as `helper.describe()` never trip it.

const assert = require('assert');
const acorn = require('acorn');
const fs = require('fs');
const path = require('path');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..', 'src');
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);

const TEST_MODULES = ['node:test', 'node:assert', 'assert', 'mocha', 'chai'];

// Calls that register tests or hooks when made inside a require.main block,
// whether bare (`test(...)`) or through a module object (`nodeTest.test(...)`).
const REGISTRATION_CALLS = new Set([
    'describe', 'it', 'test', 'suite', 'before', 'after', 'beforeEach', 'afterEach'
]);

// Bare calls refused at module level anywhere in src.
const MODULE_LEVEL_CALLS = new Set(['describe', 'it']);

// Files allowed to hold test code, with the number of findings each may have.
// The backlog this guard landed with has all moved under test/, so the list
// is empty and may only stay so: any finding in any src file fails, and an
// entry whose file has been cleaned fails as stale.
const KNOWN_VIOLATIONS = {};

function sourceFiles(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(target));
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
            files.push(target);
        }
    }
    return files;
}

function stringValue(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0].value.cooked;
    }
    return null;
}

function isTestModule(name) {
    if (typeof name !== 'string') return false;
    return TEST_MODULES.some(base => name === base || name.startsWith(base + '/'));
}

function propertyName(member) {
    if (member.computed) return stringValue(member.property);
    return member.property.type === 'Identifier' ? member.property.name : null;
}

function isRequireCall(node) {
    return node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length >= 1;
}

function isGlobalObjectTestCall(node) {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false;
    const object = node.callee.object;
    if (object.type !== 'Identifier') return false;
    if (object.name !== 'globalThis' && object.name !== 'global') return false;
    return MODULE_LEVEL_CALLS.has(propertyName(node.callee));
}

function registrationName(node) {
    if (node.type !== 'CallExpression') return null;
    const callee = node.callee;
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression') return propertyName(callee);
    return null;
}

function isRequireMain(node) {
    return node.type === 'MemberExpression' &&
        node.object.type === 'Identifier' &&
        node.object.name === 'require' &&
        propertyName(node) === 'main';
}

function isModuleIdentifier(node) {
    return node.type === 'Identifier' && node.name === 'module';
}

function isRequireMainTest(node) {
    if (!node || node.type !== 'BinaryExpression') return false;
    if (!['===', '=='].includes(node.operator)) return false;
    return (isRequireMain(node.left) && isModuleIdentifier(node.right)) ||
        (isModuleIdentifier(node.left) && isRequireMain(node.right));
}

function isFunctionNode(node) {
    return node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression';
}

function parse(source) {
    const options = {
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        ecmaVersion: 'latest',
        locations: true
    };
    try {
        return acorn.parse(source, Object.assign({ sourceType: 'script' }, options));
    } catch (scriptError) {
        return acorn.parse(source, Object.assign({ sourceType: 'module' }, options));
    }
}

// Returns one { line, reason } per finding in `source`.
function inspectSource(source) {
    const ast = parse(source);
    const violations = [];

    function report(node, reason) {
        violations.push({ line: node.loc.start.line, reason });
    }

    // functionDepth counts enclosing functions; inMainBlock is true inside
    // the branch guarded by a `require.main === module` test.
    function visit(node, functionDepth, inMainBlock) {
        if (!node || typeof node.type !== 'string') return;

        if (node.type === 'ImportDeclaration' && isTestModule(stringValue(node.source))) {
            report(node, 'imports ' + stringValue(node.source));
        }
        if (node.type === 'ImportExpression' && isTestModule(stringValue(node.source))) {
            report(node, 'imports ' + stringValue(node.source));
        }
        if (isRequireCall(node) && isTestModule(stringValue(node.arguments[0]))) {
            report(node, 'requires ' + stringValue(node.arguments[0]));
        }
        if (isGlobalObjectTestCall(node)) {
            report(node, 'calls ' + node.callee.object.name + '.' + propertyName(node.callee));
        }
        if (functionDepth === 0 && node.type === 'CallExpression' &&
            node.callee.type === 'Identifier' && MODULE_LEVEL_CALLS.has(node.callee.name)) {
            report(node, 'calls ' + node.callee.name + '() at module level');
        }
        if (inMainBlock && REGISTRATION_CALLS.has(registrationName(node))) {
            report(node, 'registers a test inside a require.main block');
        }

        const isGuard = (node.type === 'IfStatement' || node.type === 'ConditionalExpression') &&
            isRequireMainTest(node.test);
        const childDepth = isFunctionNode(node) ? functionDepth + 1 : functionDepth;

        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc') continue;
            const childInMain = inMainBlock || (isGuard && key === 'consequent');
            if (Array.isArray(value)) {
                for (const child of value) visit(child, childDepth, childInMain);
            } else if (value && typeof value.type === 'string') {
                visit(value, childDepth, childInMain);
            }
        }
    }

    visit(ast, 0, false);
    return violations;
}

const FORBIDDEN_SOURCES = [
    ["const test = require('node:test');", 'node:test require'],
    ["const assert = require('node:assert');", 'node:assert require'],
    ["const assert = require('node:assert/strict');", 'node:assert subpath require'],
    ["const assert = require('assert');", 'assert require'],
    ["const assert = require('assert/strict');", 'assert subpath require'],
    ["const Mocha = require('mocha');", 'mocha require'],
    ["const { expect } = require('chai');", 'chai require'],
    ['const { expect } = require(`chai`);', 'chai template-literal require'],
    ["import test from 'node:test';", 'node:test import'],
    ["import { describe } from 'mocha';", 'mocha import'],
    ["import { expect } from 'chai';", 'chai import'],
    ["async function f() { await import('node:assert/strict'); }", 'node:assert dynamic import'],
    ["async function f() { await import('chai'); }", 'chai dynamic import'],
    ["globalThis.it('case', () => {});", 'globalThis.it call'],
    ["globalThis.describe('suite', () => {});", 'globalThis.describe call'],
    ["globalThis['describe']('suite', () => {});", 'computed globalThis.describe call'],
    ["function later() { globalThis.it('case', () => {}); }", 'globalThis.it call inside a function'],
    ["describe('suite', () => {});", 'module-level describe call'],
    ["it('case', () => {});", 'module-level it call'],
    ["if (process.env.X) { describe('suite', () => {}); }", 'describe call in a module-level block'],
    ["const t = require.main === module ? require('node:test') : null;", 'require.main-gated node:test require'],
    ["if (require.main === module) nodeTest.test('case', () => {});", 'require.main block calling node:test'],
    ["if (module === require.main) { test('case', () => {}); }", 'reversed require.main block calling test'],
    ["if (require.main === module) { describe('suite', function () { it('case', () => {}); }); }",
        'require.main block registering a suite']
];

// Counts findings per src-relative file and lists each one for the failure
// message.
function scanSourceTree() {
    const found = {};
    const details = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
        const relative = path.relative(SOURCE_ROOT, file).split(path.sep).join('/');
        const violations = inspectSource(fs.readFileSync(file, 'utf8'));
        if (violations.length === 0) continue;
        found[relative] = violations.length;
        for (const violation of violations) {
            details.push(relative + ':' + violation.line + ' ' + violation.reason);
        }
    }
    return { found, details };
}

describe('production source test-code boundary', function () {
    for (const [source, label] of FORBIDDEN_SOURCES) {
        it('rejects a ' + label, function () {
            assert.ok(inspectSource(source).length > 0, source);
        });
    }

    it('allows a command-line require.main entry block', function () {
        const source = [
            'async function main(argv) { return argv.length; }',
            'if (require.main === module) {',
            '    main(process.argv.slice(2)).then(code => process.exit(code), err => {',
            '        console.error(err && err.message ? err.message : err);',
            '        process.exit(1);',
            '    });',
            '}'
        ].join('\n');
        assert.deepStrictEqual(inspectSource(source), []);
    });

    it('ignores lookalikes in comments, strings, methods and nested helpers', function () {
        const source = [
            "// describe('suite') and require('chai')",
            "const text = \"require('node:test')\";",
            'helper.describe();',
            'const assertLike = require(\'./assert_helpers\');',
            'const notAssert = require(\'assertive\');',
            'function walk(it) { return it(); }'
        ].join('\n');
        assert.deepStrictEqual(inspectSource(source), []);
    });

    it('parses ES module syntax as well as CommonJS', function () {
        assert.deepStrictEqual(inspectSource("import fs from 'fs';\nexport default fs;"), []);
        assert.deepStrictEqual(inspectSource('return;'), []);
    });

    it('keeps test code out of src beyond the known backlog', function () {
        // Parsing every src file takes seconds on a loaded host.
        this.timeout(60000);
        const { found, details } = scanSourceTree();
        const regressions = Object.keys(found)
            .filter(file => found[file] > (KNOWN_VIOLATIONS[file] || 0))
            .map(file => file + ' has ' + found[file] + ' findings, allowed ' +
                (KNOWN_VIOLATIONS[file] || 0));
        assert.deepStrictEqual(regressions, [],
            'test code under src/; move it under test/:\n' + details.join('\n'));

        const stale = Object.keys(KNOWN_VIOLATIONS)
            .filter(file => (found[file] || 0) < KNOWN_VIOLATIONS[file])
            .map(file => file + ' now has ' + (found[file] || 0) + ' findings, listed ' +
                KNOWN_VIOLATIONS[file]);
        assert.deepStrictEqual(stale, [],
            'KNOWN_VIOLATIONS may only shrink; lower or remove these entries');
    });
});
