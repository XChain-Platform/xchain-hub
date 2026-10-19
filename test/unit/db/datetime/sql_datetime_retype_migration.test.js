'use strict';

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const { DATETIME_COLUMNS } = require('../../../../src/db/schema/datetime_columns.js');

const MIGRATION = path.join(
    __dirname,
    '..', '..', '..', '..',
    'src', 'sql', 'migrations', '2026-10-19-timestamp-columns-to-datetime.sql'
);

function parseAlterStatements(source) {
    return source.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('ALTER TABLE '))
        .map((line) => {
            const match = line.match(/^ALTER TABLE `([^`]+)` MODIFY `([^`]+)` (.+);$/);
            expect(match, line).not.to.equal(null);
            return { table: match[1], column: match[2], columnDef: match[3] };
        });
}

describe('manual datetime retype migration', function () {
    const source = fs.readFileSync(MIGRATION, 'utf8');

    it('is tagged for manual application', function () {
        expect(source).to.include('-- xchain:migration mode=manual');
    });

    it('matches all 48 datetime columns one to one in list order', function () {
        const statements = parseAlterStatements(source);
        expect(statements).to.have.lengthOf(48);
        expect(DATETIME_COLUMNS).to.have.lengthOf(48);
        expect(statements).to.deep.equal(DATETIME_COLUMNS.map(entry => ({
            table: entry.table,
            column: entry.column,
            columnDef: entry.columnDef,
        })));
    });
});
