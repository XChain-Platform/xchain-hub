'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const migrations = require('../../../../src/db/schema/columns.js');

const migrationPath = path.resolve(
    __dirname, '../../../../src/sql/migrations/2026-10-19-nullable-mirror-columns.sql');

function parseAlterStatements(sql) {
    return sql.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('ALTER TABLE '))
        .map(line => {
            const match = line.match(
                /^ALTER TABLE `([^`]+)` ADD COLUMN IF NOT EXISTS `([^`]+)` (.+);$/);
            expect(match, 'valid nullable-column ALTER: ' + line).not.to.equal(null);
            return { table: match[1], column: match[2], columnDef: match[3] };
        });
}

describe('nullable mirror columns SQL migration', function () {
    it('matches admission and archive bookkeeping calls in order', async function () {
        const recorded = [];
        const recorder = {
            migrateAddNullableColumn: async function (table, column, columnDef) {
                recorded.push({ table, column, columnDef });
            }
        };

        await migrations.migrateAdmissionColumns.call(recorder);
        await migrations.migrateArchiveBookkeepingColumns.call(recorder);

        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = parseAlterStatements(sql);

        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements).to.have.length(38);
        expect(statements).to.deep.equal(recorded);
    });
});
