'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const migrations = require('../../../../src/db/schema/migrations.js');

const migrationPath = path.resolve(
    __dirname, '../../../../src/sql/migrations/2026-10-19-enum-charset-and-voting-window-widens.sql');

function parseAlterStatements(sql) {
    return sql.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('ALTER TABLE '))
        .map(line => {
            const match = line.match(/^ALTER TABLE `([^`]+)` MODIFY `([^`]+)` (.+);$/);
            expect(match, 'valid column MODIFY: ' + line).not.to.equal(null);
            return { table: match[1], column: match[2], columnDef: match[3] };
        });
}

describe('enum, charset and voting window SQL migration', function () {
    it('matches runtime column migration calls in order', async function () {
        const recorded = [];
        const recorder = new Proxy(recorded, {
            get: function (target, helper) {
                return async function (...args) {
                    if(helper === 'migrateEnumColumn') {
                        const values = args[2].map(value => `'${value}'`).join(',');
                        target.push({
                            table: args[0],
                            column: args[1],
                            columnDef: `ENUM(${values}) ${args[3]}`
                        });
                    }
                    if(helper === 'migrateColumnType' || helper === 'migrateColumnCharset') {
                        target.push({ table: args[0], column: args[1], columnDef: args[3] });
                    }
                };
            }
        });

        await migrations.runCapabilityAndCheckpointMigrations.call(recorder);
        await migrations.runColumnAndFenceMigrations.call(recorder);

        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = parseAlterStatements(sql);

        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(recorded).to.have.length(5);
        expect(statements).to.have.length(5);
        expect(statements).to.deep.equal(recorded);
    });
});
