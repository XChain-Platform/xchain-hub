'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The hub AUTHORS the attestation_responses row, so it is the first place a
// finalized ATTEST response can be lost. AttestationResponseMirror stores the
// provider body decoded as UTF-8 and response_hash over the bytes the responsible
// set signed. On a utf8mb3 column a 4-byte character fails that INSERT with errno
// 1366 under STRICT_TRANS_TABLES, and a server that truncates instead leaves a body
// that no longer hashes to response_hash, so the row verifies on no node. The
// on-chain twins the mirror stands in for (attests.response_payload, attests.meta on
// the indexer) are utf8mb4, so these two columns must be as well.
//
// Two arms, one per path a deployed hub can take:
//   DEFINITION - src/sql/attestation_responses.sql declares the charset, which is
//                what verifyTables gives a hub whose table does not exist yet.
//   MIGRATION  - the dated widen under src/sql/migrations restates it, which is the ONLY
//                thing that reaches a hub whose table already exists: alterTableForDrift
//                adds a missing column and never restates an existing one. The runner
//                keeps that file pending on any hub still on utf8mb3.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const files = require('../../../../src/db/schema/sql_migration_files.js');
const { planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');

const DEF_PATH = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'attestation_responses.sql');
const MIGRATIONS = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
const WIDEN_FILE = '2026-10-19-enum-charset-and-voting-window-widens.sql';

// The columns that hold provider bytes. provider_id is deliberately absent: a mirror row
// exists only for a round that reached quorum, which requires a governance-registered
// provider, so no provider-chosen identifier reaches it.
const PROVIDER_BYTE_COLUMNS = ['response_payload', 'meta'];

// A Database over stubbed mariadb + fs, matching db.coverage.test.js.
// The declared charset of one column in the definition file, or null when it declares none
// (in which case it inherits the table's utf8mb3 tail).
function declaredCharset(column) {
    const sql  = fs.readFileSync(DEF_PATH, 'utf8');
    const line = sql.split('\n').find(l => new RegExp('^\\s*`?' + column + '`?\\s+[A-Z]', 'i').test(l));
    expect(line, 'attestation_responses.' + column + ' is no longer declared').to.exist;
    const m = /CHARACTER\s+SET\s+(\w+)/i.exec(line.replace(/--.*$/, ''));
    return m ? m[1].toLowerCase() : null;
}

// The widen file's provider-byte statements against a live table at the given charset.
function charsetShortfall(liveCharset) {
    const statements = files.splitMigrationStatements(files.readMigration(MIGRATIONS, WIDEN_FILE))
        .filter(s => /`attestation_responses`/.test(s));
    const columns = PROVIDER_BYTE_COLUMNS.map(c => ({ t: 'attestation_responses', c, dt: c === 'meta' ? 'text' : 'mediumtext', cs: liveCharset }));
    return { statements, unmet: unmetEndState(planEndState(statements), schemaModel(columns, [])) };
}

function registerCharsetMigrationSuite() {
describe('the dated widen (what a deployed hub gets)', function () {
        it('restates both provider-byte columns as utf8mb4', function () {
            const { statements } = charsetShortfall('utf8mb4');
            expect(statements).to.have.lengthOf(PROVIDER_BYTE_COLUMNS.length);
            for (const column of PROVIDER_BYTE_COLUMNS)
                expect(statements.some(s => s.includes('`' + column + '`') && /CHARACTER SET utf8mb4/.test(s)), column).to.equal(true);
        });
        it('stays pending on a hub whose columns are still utf8mb3', function () {
            expect(charsetShortfall('utf8mb3').unmet).to.have.lengthOf(PROVIDER_BYTE_COLUMNS.length);
        });
        it('is baselined on a hub already at utf8mb4', function () {
            expect(charsetShortfall('utf8mb4').unmet).to.deep.equal([]);
        });
    });
}

function registerCharsetDefinitionSuite() {
describe('the definition (what a fresh hub gets from verifyTables)', function () {
        for (const column of PROVIDER_BYTE_COLUMNS) {
            it(column + ' is declared utf8mb4', function () {
                expect(declaredCharset(column)).to.equal('utf8mb4');
            });
        }

        it('control: a column that carries no provider bytes stays on the table tail', function () {
            // signer_pubkeys is hex the hub composes itself. If this ever reads utf8mb4 the
            // check above has stopped distinguishing anything.
            expect(declaredCharset('signer_pubkeys')).to.equal(null);
        });
    });
}

describe('attestation_responses holds every provider body the on-chain path holds', function () {

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'error');
    });
    afterEach(() => sinon.restore());

    registerCharsetDefinitionSuite();
    registerCharsetMigrationSuite();

});
