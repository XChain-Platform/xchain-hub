'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { parseMigrationFile, isMigrationFileName } = require('../../../../src/db/schema/sql_migration_file.js');

const SQL_DIR = path.resolve(__dirname, '../../../../src/sql');
const DIR = path.join(SQL_DIR, 'migrations');

const files = fs.readdirSync(DIR).sort().map(name => ({
    name, sql: fs.readFileSync(path.join(DIR, name), 'utf8')
}));
const parsed = Object.fromEntries(files.map(f => [f.name, parseMigrationFile(f.name, f.sql)]));
const tableDdl = table => fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');

describe('src/sql/migrations files', function () {
    it('are all dated .sql names that parse', function () {
        expect(files.length).to.be.greaterThan(0);
        for (const f of files) expect(isMigrationFileName(f.name), f.name).to.equal(true);
    });

    it('carry no manual-mode tag, which the runner would reject', function () {
        for (const f of files) expect(f.sql, f.name).not.to.include('mode=manual');
    });

    it('gates only the oracle tick widen, and sorts the dedup before the widen', function () {
        const gated = Object.values(parsed).filter(p => p.gate).map(p => p.name);
        expect(gated).to.deep.equal(['2026-10-19-oracle-prices-widen-tick.sql']);
        expect(parsed['2026-10-19-oracle-prices-widen-tick.sql'].gate).to.equal('XCHAIN_HUB_ORACLE_TICK_MIRRORS_WIDENED');
        const names = Object.keys(parsed);
        expect(names.indexOf('2026-10-19-dedup-and-add-unique-keys.sql'))
            .to.be.lessThan(names.indexOf('2026-10-19-widen-unique-keys.sql'));
    });

    it('fail the boot for the required keys and mirror columns only', function () {
        expect(parsed['2026-10-19-dedup-and-add-unique-keys.sql'].onError).to.equal('fail');
        expect(parsed['2026-10-19-widen-unique-keys.sql'].onError).to.equal('fail');
        expect(parsed['2026-10-19-nullable-mirror-columns.sql'].onError).to.equal('fail');
        expect(parsed['2026-10-19-timestamp-columns-to-datetime.sql'].onError).to.equal('warn');
    });

    it('retype 48 timestamp columns to the definition the table DDL declares', function () {
        const stmts = parsed['2026-10-19-timestamp-columns-to-datetime.sql'].statements;
        expect(stmts).to.have.length(48);
        for (const s of stmts) {
            const m = s.match(/^ALTER TABLE `([^`]+)` MODIFY `([^`]+)` (.+)$/);
            expect(m, s).not.to.equal(null);
            const ddl = tableDdl(m[1]).replace(/\s+/g, ' ');
            expect(ddl, m[1] + '.' + m[2]).to.include(m[2] + ' ' + m[3]);
        }
    });

});

describe('src/sql/migrations files, key and retype statements', function () {
    it('re-key the price fence in a single ALTER', function () {
        const stmts = parsed['2026-10-19-price-fence-primary-key.sql'].statements;
        expect(stmts).to.deep.equal([
            'ALTER TABLE `price_ingest_watermarks` DROP PRIMARY KEY, ADD PRIMARY KEY (`network`, `source_chain`)'
        ]);
        expect(tableDdl('price_ingest_watermarks')).to.match(/PRIMARY KEY\s*\(\s*network\s*,\s*source_chain\s*\)/);
    });

    it('widen each unique key to the columns the table DDL declares', function () {
        const stmts = parsed['2026-10-19-widen-unique-keys.sql'].statements;
        const finals = stmts.map(s => s.match(/^ALTER TABLE `([^`]+)` ADD UNIQUE KEY IF NOT EXISTS `([^`]+)` (\(.+\))$/))
            .filter(m => m && !m[2].endsWith('_widening'));
        expect(finals).to.have.length(3);
        for (const m of finals) {
            const ddl = tableDdl(m[1]).replace(/\s+/g, ' ');
            const inline = 'UNIQUE KEY ' + m[2] + ' ' + m[3];
            const standalone = 'CREATE UNIQUE INDEX ' + m[2] + ' ON ' + m[1] + ' ' + m[3];
            expect(ddl.replace(/ +/g, ' ').includes(inline) || ddl.replace(/ +/g, ' ').includes(standalone), m[2]).to.equal(true);
        }
    });

    it('backfill the archive round qualifier before the reward key is widened', function () {
        const stmts = parsed['2026-10-19-widen-unique-keys.sql'].statements;
        expect(stmts[0]).to.equal("UPDATE validator_rewards SET round_qualifier = block_index WHERE reward_type = 'anchor_archive' " +
            'AND round_qualifier = 0 AND block_index IS NOT NULL AND block_index > 0');
        expect(stmts[1]).to.match(/validator_rewards.*uq_reward_widening/);
    });

    it('convert both governance voting deadline columns to DATETIME', function () {
        const stmts = parsed['2026-10-19-enum-charset-and-voting-window-widens.sql'].statements;
        for (const column of ['voting_start', 'voting_end'])
            expect(stmts).to.include('ALTER TABLE `governance_proposals` MODIFY `' + column + '` DATETIME NOT NULL');
    });

    it('dedup keeping the lowest id before each unique key is added', function () {
        const stmts = parsed['2026-10-19-dedup-and-add-unique-keys.sql'].statements;
        expect(stmts).to.have.length(6);
        for (let i = 0; i < stmts.length; i += 2) {
            expect(stmts[i]).to.match(/^DELETE t1 FROM (\w+) t1 INNER JOIN \1 t2 WHERE t1\.id > t2\.id/);
            expect(stmts[i + 1]).to.match(/ADD UNIQUE KEY IF NOT EXISTS/);
        }
    });
});
