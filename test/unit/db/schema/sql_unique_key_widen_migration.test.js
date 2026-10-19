'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const migrations = require('../../../../src/db/schema/migrations.js');
const { ARCHIVE_REWARD_TYPE } = require('../../../../src/anchor/anchor_reward_key.js');

const migrationPath = path.resolve(
    __dirname, '../../../../src/sql/migrations/2026-10-19-widen-unique-keys.sql');

function parseStatements(sql) {
    return sql.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('UPDATE ') || line.startsWith('ALTER TABLE '))
        .map(line => {
            const update = line.match(
                /^UPDATE validator_rewards SET round_qualifier = block_index WHERE reward_type = '([^']+)' AND round_qualifier = 0 AND block_index IS NOT NULL AND block_index > 0;$/);
            if(update) return { helper: 'backfillArchiveRoundQualifier', rewardType: update[1] };

            const add = line.match(
                /^ALTER TABLE `([^`]+)` ADD UNIQUE KEY IF NOT EXISTS `([^`]+)` (\(.+\));$/);
            if(add) return { helper: 'widenUniqueKey', kind: 'add', args: add.slice(1) };

            const drop = line.match(
                /^ALTER TABLE `([^`]+)` DROP INDEX IF EXISTS `([^`]+)`;$/);
            expect(drop, 'valid unique-key widen statement: ' + line).not.to.equal(null);
            return { helper: 'widenUniqueKey', kind: 'drop', args: drop.slice(1) };
        });
}

describe('unique-key widen SQL migration', function () {
    it('matches runtime backfill and widen calls in order', async function () {
        const recorded = [];
        const recorder = new Proxy(Object.create(null), {
            get: function (target, helper) {
                if(helper in target) return target[helper];
                return async function (...args) {
                    if(helper === 'backfillArchiveRoundQualifier') {
                        recorded.push({ helper, rewardType: ARCHIVE_REWARD_TYPE });
                    }
                    if(helper === 'widenUniqueKey') {
                        const [table, indexName, , indexColumns] = args;
                        const wideningName = indexName + '_widening';
                        recorded.push(
                            { helper, kind: 'add', args: [table, wideningName, indexColumns] },
                            { helper, kind: 'drop', args: [table, indexName] },
                            { helper, kind: 'add', args: [table, indexName, indexColumns] },
                            { helper, kind: 'drop', args: [table, wideningName] }
                        );
                    }
                };
            }
        });

        await migrations.runRewardKeyMigrations.call(recorder);
        await migrations.runCapabilityAndCheckpointMigrations.call(recorder);

        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = parseStatements(sql);

        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements).to.have.length(13);
        expect(statements[0]).to.deep.equal({
            helper: 'backfillArchiveRoundQualifier',
            rewardType: ARCHIVE_REWARD_TYPE
        });
        expect(statements).to.deep.equal(recorded);
    });
});
