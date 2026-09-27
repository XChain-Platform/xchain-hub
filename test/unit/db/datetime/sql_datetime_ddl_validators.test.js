'use strict';

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const DEFINITIONS = {
    'slash_proposals.sql':       ['created_at'],
    'state_checkpoints.sql':     ['created_at'],
    'swap_records.sql':          ['created_at', 'updated_at'],
    'telemetry_pings.sql':       ['created_at'],
    'validator_capabilities.sql': ['self_test_at', 'created_at', 'updated_at'],
    'validator_rewards.sql':     ['created_at'],
    'validators.sql':            ['created_at', 'updated_at'],
};

function readDefinition(file) {
    const filename = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', file);
    return fs.readFileSync(filename, 'utf8')
        .replace(/--.*$/gm, '')
        .split('\n')
        .map(line => line.trim())
        .join('\n');
}

describe('fresh-install datetime DDL', function () {
    for (const [file, columns] of Object.entries(DEFINITIONS)) {
        describe(file, function () {
            const definition = readDefinition(file);

            it('declares no column with the TIMESTAMP type', function () {
                expect(definition).not.to.match(/^[A-Za-z_][A-Za-z0-9_]*\s+TIMESTAMP\b/im);
            });

            for (const column of columns) {
                it('declares ' + column + ' as DATETIME', function () {
                    expect(definition).to.match(new RegExp('^' + column + '\\s+DATETIME\\b', 'im'));
                });
            }
        });
    }
});
