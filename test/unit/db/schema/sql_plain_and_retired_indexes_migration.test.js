'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const migrations = require('../../../../src/db/schema/migrations.js');

const migrationPath = path.resolve(
    __dirname, '../../../../src/sql/migrations/2026-10-19-plain-and-retired-indexes.sql');

function parseAlterStatements(sql) {
    return sql.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('ALTER TABLE '))
        .map(line => {
            const add = line.match(
                /^ALTER TABLE `([^`]+)` ADD INDEX IF NOT EXISTS `([^`]+)` (\(.+\));$/);
            if(add) return { helper: 'migrateIndex', args: add.slice(1) };

            const drop = line.match(
                /^ALTER TABLE `([^`]+)` DROP INDEX IF EXISTS `([^`]+)`;$/);
            expect(drop, 'valid plain-index ALTER: ' + line).not.to.equal(null);
            return { helper: 'dropIndexIfExists', args: drop.slice(1) };
        });
}

describe('plain and retired indexes SQL migration', function () {
    it('matches runtime index calls in order', async function () {
        const recorded = [];
        const recorder = new Proxy(Object.create(null), {
            get: function (target, helper) {
                if(helper in target) return target[helper];
                return async function (...args) {
                    if(helper === 'migrateIndex' || helper === 'dropIndexIfExists')
                        recorded.push({ helper, args });
                };
            }
        });

        await migrations.runRewardKeyMigrations.call(recorder);
        await migrations.runCapabilityAndCheckpointMigrations.call(recorder);
        await migrations.runColumnAndFenceMigrations.call(recorder);

        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = parseAlterStatements(sql);

        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements).to.have.length(7);
        expect(statements).to.deep.equal(recorded);
    });
});
