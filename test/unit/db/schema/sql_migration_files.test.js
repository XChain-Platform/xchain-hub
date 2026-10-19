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

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { expect } = require('chai');

const {
    migrationMode,
    listDatedMigrations
} = require('../../../../src/db/schema/sql_migration_files.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const LOCAL_PATH = path.resolve(__dirname, '../../../../src/db/schema/sql_migration_files.js');
const DECODER_PATH = path.resolve(
    __dirname,
    '../../../../../xchain-decoder/src/db/migration_statements.js'
);

function withTempDir(run){
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-sql-migrations-'));
    try { return run(dir); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function bodyLines(source, signature){
    const signatureAt = source.indexOf(signature);
    if(signatureAt === -1) throw new Error('Function signature not found: ' + signature);
    const open = source.indexOf('{', signatureAt + signature.length);
    let depth = 1;
    let close = open + 1;
    while(depth && close < source.length){
        if(source[close] === '{') depth++;
        if(source[close] === '}') depth--;
        close++;
    }
    if(depth) throw new Error('Unclosed function body: ' + signature);
    return source.slice(open + 1, close - 1)
        .split('\n')
        .map(line => line.replace(/^\s+/, ''));
}

describe('sql migration file helpers', function () {
    describe('migrationMode()', function () {
        it('reads an auto tag after a long leading comment banner', function () {
            const banner = Array.from({ length: 80 }, (_, i) => '-- banner line ' + i).join('\n');
            expect(migrationMode(banner + '\n\n-- xchain:migration mode=auto\nCREATE TABLE t (id INT);'))
                .to.equal('auto');
        });

        it('ignores a tag after the first SQL statement', function () {
            expect(migrationMode('CREATE TABLE t (id INT);\n-- xchain:migration mode=auto'))
                .to.equal('manual');
        });

        it('defaults an untagged migration to manual', function () {
            expect(migrationMode('-- banner\nCREATE TABLE t (id INT);')).to.equal('manual');
        });

        it('keeps its body line-for-line equal to the decoder implementation', function () {
            if(!skipOrFail(this, siblingCheckout(__dirname, DECODER_PATH),
                'the decoder migrationMode twin guard')) return;
            const local = fs.readFileSync(LOCAL_PATH, 'utf8');
            const decoder = fs.readFileSync(DECODER_PATH, 'utf8');
            expect(bodyLines(local, 'function migrationMode(raw)'))
                .to.deep.equal(bodyLines(decoder, 'migrationMode(raw)'));
        });
    });

    describe('listDatedMigrations()', function () {
        it('returns SQL basenames in lexical order', function () {
            withTempDir(dir => {
                fs.writeFileSync(path.join(dir, '2026-10-03-third.sql'), 'SELECT 3;\n');
                fs.writeFileSync(path.join(dir, 'README.txt'), 'ignored\n');
                fs.writeFileSync(path.join(dir, '2026-02-01-first.sql'), 'SELECT 1;\n');
                fs.writeFileSync(path.join(dir, '2026-10-02-second.sql'), 'SELECT 2;\n');
                expect(listDatedMigrations(dir)).to.deep.equal([
                    '2026-02-01-first.sql',
                    '2026-10-02-second.sql',
                    '2026-10-03-third.sql'
                ]);
            });
        });

        it('returns an empty list when the directory does not exist', function () {
            withTempDir(dir => {
                expect(listDatedMigrations(path.join(dir, 'absent'))).to.deep.equal([]);
            });
        });

        it('refuses an undated SQL filename and names it in the error', function () {
            withTempDir(dir => {
                fs.writeFileSync(path.join(dir, 'migration.sql'), 'SELECT 1;\n');
                expect(() => listDatedMigrations(dir)).to.throw(/migration\.sql/);
            });
        });
    });
});
