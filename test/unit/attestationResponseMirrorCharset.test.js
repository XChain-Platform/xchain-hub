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
//   MIGRATION  - runMigrations widens it, which is the ONLY thing that reaches a hub
//                whose table already exists: alterTableForDrift adds a missing column
//                and never restates an existing one.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const DEF_PATH = path.join(__dirname, '..', '..', 'src', 'sql', 'attestation_responses.sql');

// The columns that hold provider bytes. provider_id is deliberately absent: a mirror row
// exists only for a round that reached quorum, which requires a governance-registered
// provider, so no provider-chosen identifier reaches it.
const PROVIDER_BYTE_COLUMNS = ['response_payload', 'meta'];

// A Database over stubbed mariadb + fs, matching db.coverage.test.js.
function makeDb() {
    const mockConn = {
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
        end:     sinon.stub().resolves()
    };
    const mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
    const Database = proxyquire('../../src/db', {
        mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
        fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
        path:    require('path')
    });
    return { db: new Database('localhost', 3306, 'test_db', 'user', 'pass'), mockConn };
}

// The declared charset of one column in the definition file, or null when it declares none
// (in which case it inherits the table's utf8mb3 tail).
function declaredCharset(column) {
    const sql  = fs.readFileSync(DEF_PATH, 'utf8');
    const line = sql.split('\n').find(l => new RegExp('^\\s*`?' + column + '`?\\s+[A-Z]', 'i').test(l));
    expect(line, 'attestation_responses.' + column + ' is no longer declared').to.exist;
    const m = /CHARACTER\s+SET\s+(\w+)/i.exec(line.replace(/--.*$/, ''));
    return m ? m[1].toLowerCase() : null;
}

describe('attestation_responses holds every provider body the on-chain path holds', function () {

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'error');
    });
    afterEach(() => sinon.restore());

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

    describe('runMigrations (what a deployed hub gets)', function () {
        it('widens both provider-byte columns to utf8mb4', async function () {
            const { db } = makeDb();
            sinon.stub(db, '_migrateUniqueKey').resolves();
            sinon.stub(db, '_migrateIndex').resolves();
            sinon.stub(db, '_migrateEnumColumn').resolves();
            sinon.stub(db, '_migrateColumnType').resolves();
            const widen = sinon.stub(db, '_migrateColumnCharset').resolves();

            await db.runMigrations();

            for (const column of PROVIDER_BYTE_COLUMNS) {
                const call = widen.getCalls().find(c => c.args[1] === column);
                expect(call, column + ' is not widened on a deployed hub').to.exist;
                expect(call.args[0]).to.equal('attestation_responses');
                expect(call.args[2]).to.equal('utf8mb4');
                // The restated column must match the definition file, or the two schema
                // paths converge on different shapes.
                expect(call.args[3]).to.include('CHARACTER SET utf8mb4');
                expect(call.args[3]).to.include('COLLATE utf8mb4_general_ci');
                expect(call.args[3]).to.not.match(/NOT\s+NULL/i);
            }
            expect(widen.getCall(0).args[3]).to.match(/^MEDIUMTEXT\b/);
            expect(widen.getCall(1).args[3]).to.match(/^TEXT\b/);
        });
    });

    describe('_migrateColumnCharset', function () {
        it('issues the MODIFY when the live column is still utf8mb3', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ CHARACTER_SET_NAME: 'utf8mb3' }]).onCall(1).resolves([]);
            await db._migrateColumnCharset('attestation_responses', 'meta', 'utf8mb4',
                'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
            expect(mockConn.query.callCount).to.equal(2);
            expect(mockConn.query.getCall(1).args[0])
                .to.equal('ALTER TABLE `attestation_responses` MODIFY `meta` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
            expect(mockConn.release.called).to.be.true;
        });

        it('no-ops on a hub already at the target charset', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ CHARACTER_SET_NAME: 'utf8mb4' }]);
            await db._migrateColumnCharset('attestation_responses', 'meta', 'utf8mb4', 'TEXT CHARACTER SET utf8mb4');
            expect(mockConn.query.callCount).to.equal(1);
            expect(mockConn.release.called).to.be.true;
        });

        it('no-ops when the table does not exist yet (the CREATE TABLE covers it)', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([]);
            await db._migrateColumnCharset('attestation_responses', 'meta', 'utf8mb4', 'TEXT CHARACTER SET utf8mb4');
            expect(mockConn.query.callCount).to.equal(1);
        });

        it('logs the hand-run statement and releases rather than taking the boot down', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ CHARACTER_SET_NAME: 'utf8mb3' }])
                          .onCall(1).rejects(new Error('alter failed'));
            await db._migrateColumnCharset('attestation_responses', 'meta', 'utf8mb4',
                'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
            expect(console.error.calledWithMatch(/MIGRATION FAILED: attestation_responses\.meta/)).to.be.true;
            expect(console.error.calledWithMatch(/ALTER TABLE `attestation_responses` MODIFY `meta`/)).to.be.true;
            expect(mockConn.release.called).to.be.true;
        });
    });
});
