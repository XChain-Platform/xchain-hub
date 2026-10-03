'use strict';

const sinon = require('sinon');
const { expect } = require('chai');

const Database = require('../../../src/db');

describe('list_snapshots metadata migration', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects when a required schema-9 metadata ALTER fails', async function () {
        const alterError = new Error('fixture ALTER denied');
        const connection = {
            query: sinon.stub(),
            release: sinon.stub().resolves()
        };
        connection.query.onFirstCall().resolves([{ c: 'id' }]);
        connection.query.onSecondCall().rejects(alterError);

        const db = Object.create(Database.prototype);
        db.dbName = 'fixture_hub';
        db.getConnection = sinon.stub().resolves(connection);

        let failure = null;
        try {
            await db.migrateAddNullableColumn(
                'list_snapshots', 'meta_hash', 'CHAR(64) NULL', true);
        } catch (error) {
            failure = error;
        }

        expect(failure, 'required metadata ALTER must stop schema-9 startup').to.equal(alterError);
        expect(connection.release.calledOnce).to.equal(true);
    });
});
