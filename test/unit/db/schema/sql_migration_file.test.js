'use strict';

const { expect } = require('chai');
const {
    parseMigrationFile, splitStatements, parseDirective, isMigrationFileName
} = require('../../../../src/db/schema/sql_migration_file.js');

describe('sql migration file parsing', function () {
    it('accepts only dated .sql names', function () {
        expect(isMigrationFileName('2026-10-19-widen-unique-keys.sql')).to.equal(true);
        expect(isMigrationFileName('widen.sql')).to.equal(false);
        expect(isMigrationFileName('2026-10-19-x.txt')).to.equal(false);
    });

    it('defaults to auto, fail-on-error and no gate', function () {
        expect(parseDirective('-- a note\nSELECT 1;')).to.deep.equal({ mode: 'auto', onError: 'fail', gate: null });
    });

    it('reads on-error and gate from the directive', function () {
        const sql = '-- title\n-- xchain:migration mode=auto on-error=warn gate=SOME_FLAG\n\nSELECT 1;';
        expect(parseDirective(sql)).to.deep.equal({ mode: 'auto', onError: 'warn', gate: 'SOME_FLAG' });
    });

    it('rejects manual mode and unknown keys', function () {
        expect(() => parseDirective('-- xchain:migration mode=manual\nSELECT 1;')).to.throw('Unsupported migration mode');
        expect(() => parseDirective('-- xchain:migration speed=fast\nSELECT 1;')).to.throw('Unknown migration directive key');
        expect(() => parseDirective('-- xchain:migration gate=lower\nSELECT 1;')).to.throw('Malformed migration gate');
    });

    it('splits on line-ending semicolons and drops comments, even ones holding a semicolon', function () {
        const sql = '-- note; with semicolon\nALTER TABLE a ADD x INT;\n-- mid\nUPDATE a SET x = 1 WHERE y = \'a;b\';\n';
        expect(splitStatements(sql)).to.deep.equal([
            'ALTER TABLE a ADD x INT',
            "UPDATE a SET x = 1 WHERE y = 'a;b'"
        ]);
    });

    it('refuses an empty file and a bad name', function () {
        expect(() => parseMigrationFile('2026-10-19-empty.sql', '-- nothing\n')).to.throw('no statements');
        expect(() => parseMigrationFile('bad.sql', 'SELECT 1;')).to.throw('Not a dated migration file name');
    });
});
