'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const migrations = require('../../../../src/db/schema/migrations.js');

const migrationPath = path.resolve(
    __dirname, '../../../../src/sql/migrations/2026-10-19-dedup-and-add-unique-keys.sql');

function parseStatements(sql) {
    return sql.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('DELETE ') || line.startsWith('ALTER TABLE '))
        .map(line => {
            const dedup = line.match(
                /^DELETE t1 FROM ([a-z_]+) t1 INNER JOIN ([a-z_]+) t2 WHERE t1\.id > t2\.id AND (.+);$/);
            if(dedup) {
                expect(dedup[2], 'same table on both sides of dedup join').to.equal(dedup[1]);
                const columns = dedup[3].split(' AND ').map(term => {
                    const match = term.match(/^t1\.([a-z_]+) = t2\.([a-z_]+)$/);
                    expect(match, 'valid dedup column equality: ' + term).not.to.equal(null);
                    expect(match[2], 'same column on both sides of dedup join').to.equal(match[1]);
                    return match[1];
                });
                return { helper: 'migrateUniqueKey', kind: 'dedup', table: dedup[1], columns };
            }

            const unique = line.match(
                /^ALTER TABLE `([^`]+)` ADD UNIQUE KEY IF NOT EXISTS `([^`]+)` (\(.+\));$/);
            expect(unique, 'valid unique-key ALTER: ' + line).not.to.equal(null);
            return {
                helper: 'migrateUniqueKey',
                kind: 'unique',
                table: unique[1],
                indexName: unique[2],
                indexColumns: unique[3],
            };
        });
}

describe('unique-key dedup SQL migration', function () {
    it('matches runtime unique-key calls in order', async function () {
        const recorded = [];
        const recorder = new Proxy(Object.create(null), {
            get: function (target, helper) {
                if(helper in target) return target[helper];
                return async function (...args) {
                    if(helper === 'migrateUniqueKey') recorded.push(args);
                };
            }
        });

        await migrations.runRewardKeyMigrations.call(recorder);
        await migrations.runCapabilityAndCheckpointMigrations.call(recorder);

        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = parseStatements(sql);
        const expected = recorded.flatMap(([table, indexName, indexColumns, columns]) => [
            { helper: 'migrateUniqueKey', kind: 'dedup', table, columns },
            { helper: 'migrateUniqueKey', kind: 'unique', table, indexName, indexColumns },
        ]);

        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements).to.have.length(6);
        expect(statements).to.deep.equal(expected);
    });
});
