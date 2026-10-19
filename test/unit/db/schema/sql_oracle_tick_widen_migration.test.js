'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const columns = require('../../../../src/db/schema/columns.js');

const FLAG = 'XCHAIN_HUB_ORACLE_TICK_MIRRORS_WIDENED';
const definitionPath = path.resolve(__dirname, '../../../../src/sql/oracle_prices.sql');
const migrationPath = path.resolve(
    __dirname, '../../../../src/sql/migrations/2026-10-19-oracle-prices-widen-tick.sql');

function parseAlterStatements(sql) {
    return sql.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('ALTER TABLE '))
        .map(line => {
            const match = line.match(/^ALTER TABLE `([^`]+)` MODIFY `([^`]+)` (.+);$/);
            expect(match, 'valid column MODIFY: ' + line).not.to.equal(null);
            return { line, table: match[1], column: match[2], columnDef: match[3] };
        });
}

function declaredTickDefinition() {
    const sql = fs.readFileSync(definitionPath, 'utf8');
    const match = sql.match(/^\s*tick\s+([^,]+),/m);
    expect(match, 'oracle_prices.tick definition').not.to.equal(null);
    return match[1];
}

describe('oracle tick width SQL migration', function () {
    it('matches the gated runtime migration and canonical table definition', async function () {
        const calls = [];
        const recorder = new Proxy({}, {
            get: function (target, helper) {
                return async function (...args) {
                    if(helper === 'migrateColumnLength') calls.push(args);
                };
            }
        });
        const priorFlag = process.env[FLAG];

        process.env[FLAG] = '1';
        try {
            await columns.migrateOracleTickWidth.call(recorder);
        } finally {
            if(priorFlag === undefined) delete process.env[FLAG];
            else process.env[FLAG] = priorFlag;
        }

        const sql = fs.readFileSync(migrationPath, 'utf8');
        const statements = parseAlterStatements(sql);
        const definition = declaredTickDefinition();

        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(sql).to.include(FLAG);
        expect(calls).to.have.length(1);
        expect(statements).to.have.length(1);
        const recordedLine = `ALTER TABLE \`${calls[0][0]}\` MODIFY \`${calls[0][1]}\` ${calls[0][3]};`;
        expect(statements[0].line).to.equal(recordedLine);
        expect(statements[0].columnDef).to.equal(definition);
    });
});
