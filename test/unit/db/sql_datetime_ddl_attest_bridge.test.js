'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const EXPECTED_COLUMNS = {
    'attest_published_batches.sql': ['intent_at', 'sent_at', 'landed_at'],
    'attest_published_requests.sql': ['intent_at', 'sent_at'],
    'attestation_fetch_cache.sql': ['created_at'],
    'attestation_validator_stats.sql': ['checked_at'],
    'attestations.sql': ['created_at', 'updated_at'],
    'bridge_transfers.sql': ['created_at'],
    'capability_snapshots.sql': ['created_at'],
    'configs.sql': ['updated_at'],
};

function uncommentedLines(file) {
    return fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
        .split('\n')
        .map(line => line.replace(/--.*$/, '').trim());
}

describe('attestation and bridge fresh-install DDL datetime columns', function () {
    for (const [file, columns] of Object.entries(EXPECTED_COLUMNS)) {
        describe(file, function () {
            const lines = uncommentedLines(file);

            it('declares no column with the TIMESTAMP type', function () {
                expect(lines.some(line => /^[a-z_][a-z0-9_]*\s+TIMESTAMP\b/i.test(line))).to.equal(false);
            });

            for (const column of columns) {
                it('declares ' + column + ' as DATETIME', function () {
                    const declaration = new RegExp('^' + column + '\\s+DATETIME\\b', 'i');
                    expect(lines.some(line => declaration.test(line))).to.equal(true);
                });
            }
        });
    }
});
