/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The file-level half of the platform code-style rules, for editors and
 * `npm run lint`.
 *
 * This is a vendored copy of the platform's shared preset, taken by copy
 * because a public clone has no platform tree beside it to import from. Core
 * rules only, no plugins, so its one dependency is eslint ^9. Refresh it by
 * re-copying the preset; a local edit here is drift.
 *
 * The pre-push structure check depends on neither eslint nor this file. The
 * two agree on the rules, and the check is what binds; this file is the fast,
 * advisory feedback a writer gets in the editor.
 */
'use strict';

const src = {
    files: ['src/**/*.js'],
    languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'commonjs',
        globals: {
            require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', Buffer: 'readonly',
            __dirname: 'readonly', __filename: 'readonly', console: 'readonly', setTimeout: 'readonly',
            clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
            URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
        },
    },
    rules: {
        // Naming: camelCase everywhere except property keys, which carry
        // protocol fields and DB columns through one-to-one.
        camelcase: ['error', { properties: 'never', ignoreDestructuring: true, ignoreImports: true }],
        'no-underscore-dangle': ['error', { enforceInMethodNames: true, allowAfterThis: false, allowFunctionParams: false }],
        // Logging: one logger. Entry points override this below.
        'no-console': 'error',
        // Module shape: requires at the top, environment in config.js only,
        // one export shape per file.
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
            {
                selector: 'MemberExpression[object.name="process"][property.name="env"]',
                message: 'environment is read in config.js only (CODE-STYLE.md, Module shape)',
            },
        ],
        'prefer-const': 'error',
        'no-var': 'error',
        eqeqeq: ['error', 'smart'],
    },
};

const configAndEntry = {
    files: ['src/config.js', 'src/api.js', 'src/migrate.js', 'src/index.js', 'bin/**/*.js'],
    rules: {
        'no-console': 'off',
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

const tests = {
    files: ['test/**/*.js'],
    languageOptions: src.languageOptions,
    rules: {
        camelcase: src.rules.camelcase,
        'no-underscore-dangle': src.rules['no-underscore-dangle'],
        'prefer-const': 'error',
        'no-var': 'error',
    },
};

module.exports = [src, configAndEntry, tests];
