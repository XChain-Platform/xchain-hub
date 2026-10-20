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
 * test/unit/db/schema/sql_migration_files.test.js
 *
 * The dated-migration reading helpers: the mode tag grammar, the lexical
 * listing, and a twin check that the mode reader stays the decoder's.
 */
'use strict';
const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { migrationMode, listDatedMigrations } = require('../../../../src/db/schema/sql_migration_files.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const DECODER_DIR = process.env.XCHAIN_DECODER_DIR ||
    path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-decoder');
const DECODER_FILE = path.join(DECODER_DIR, 'src', 'db', 'migration_statements.js');
const LOCAL_FILE = path.join(__dirname, '..', '..', '..', '..', 'src', 'db', 'schema', 'sql_migration_files.js');

// The lines between a function's opening line and its closing brace at the
// opener's indentation, leading whitespace trimmed.
function bodyLines(source, opener){
    const lines = source.split('\n');
    const start = lines.findIndex((l) => opener.test(l));
    if(start === -1) throw new Error('opener not found: ' + opener);
    const indent = lines[start].match(/^\s*/)[0];
    const body = [];
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i].startsWith(indent + '}')) return body;
        body.push(lines[i].trim());
    }
    throw new Error('closing brace not found for ' + opener);
}

describe('sql_migration_files', function(){
    describe('migrationMode', function(){
        it('reads a tag that sits after a long license banner', function(){
            const banner = Array.from({ length: 40 }, (_, i) => '-- banner line ' + i).join('\n');
            expect(migrationMode(banner + '\n-- xchain:migration mode=auto\nCREATE TABLE t (id INT);\n')).to.equal('auto');
        });
        it('ignores a tag that follows the first statement', function(){
            expect(migrationMode('CREATE TABLE t (id INT);\n-- xchain:migration mode=auto\n')).to.equal('manual');
        });
        it('defaults an untagged file to manual', function(){
            expect(migrationMode('-- just a comment\nCREATE TABLE t (id INT);\n')).to.equal('manual');
        });
        it('reads an explicit manual tag', function(){
            expect(migrationMode('-- xchain:migration mode=manual\nALTER TABLE t ADD c INT;\n')).to.equal('manual');
        });
    });

    describe('listDatedMigrations', function(){
        let dir;
        before(function(){
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-migration-files-'));
        });
        after(function(){
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('returns the .sql basenames sorted lexically and skips other files', function(){
            const sub = fs.mkdtempSync(path.join(dir, 'sorted-'));
            for(const n of ['2026-10-02-b.sql', '2026-09-30-a.sql', '2026-10-02-a.sql', 'notes.txt']){
                fs.writeFileSync(path.join(sub, n), '');
            }
            expect(listDatedMigrations(sub)).to.deep.equal(['2026-09-30-a.sql', '2026-10-02-a.sql', '2026-10-02-b.sql']);
        });
        it('returns an empty list when the directory does not exist', function(){
            expect(listDatedMigrations(path.join(dir, 'missing'))).to.deep.equal([]);
        });
        it('refuses an undated name and names the file', function(){
            const sub = fs.mkdtempSync(path.join(dir, 'undated-'));
            fs.writeFileSync(path.join(sub, '2026-10-02-ok.sql'), '');
            fs.writeFileSync(path.join(sub, '20261002_bad.sql'), '');
            expect(() => listDatedMigrations(sub)).to.throw(/20261002_bad\.sql/);
        });
    });

    describe('twin of the decoder migrationMode', function(){
        before(function(){
            skipOrFail(this, siblingCheckout(__dirname, DECODER_FILE), 'the decoder migrationMode twin check');
        });
        it('has the same body as xchain-decoder migration_statements migrationMode, line for line', function(){
            const decoder = bodyLines(fs.readFileSync(DECODER_FILE, 'utf8'), /^\s*migrationMode\(raw\)\s*\{/);
            const local = bodyLines(fs.readFileSync(LOCAL_FILE, 'utf8'), /^\s*function migrationMode\(raw\)\s*\{/);
            expect(local).to.deep.equal(decoder);
        });
    });
});
