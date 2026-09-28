'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon      = require('sinon');
const { expect } = require('chai');

const observability = require('../../../../src/observability');
const Database      = require('../../../../src/db');

function fakeMigration(liveType = 'timestamp', options = {}){
    const calls = [];
    const db = {
        query: sinon.stub().callsFake(async (sql, params) => {
            calls.push({ sql, params });
            if(sql.startsWith('SELECT DATA_TYPE')) return [{ DATA_TYPE: liveType }];
            if(sql.startsWith('ALTER TABLE') && options.alterError) throw options.alterError;
            if(sql.startsWith('SET SESSION') && params[0] === 30 && options.restoreError)
                throw options.restoreError;
            return undefined;
        }),
        release: sinon.stub().resolves(),
        destroy: sinon.stub().resolves()
    };
    const context = {
        dbName: 'hub_test',
        connectionPoolParams: { queryTimeout: 30000 },
        getConnection: sinon.stub().resolves(db)
    };
    return { calls, context, db };
}

async function migrate(context){
    return Database.prototype.migrateColumnType.call(
        context, 'events', 'created_at', 'datetime', 'DATETIME NOT NULL'
    );
}

let logger;

function installTimeoutEnvironmentHooks(){
    let originalTimeout;
    let hadOriginalTimeout;
    beforeEach(function () {
        hadOriginalTimeout = Object.prototype.hasOwnProperty.call(process.env, 'MIGRATE_QUERY_TIMEOUT');
        originalTimeout = process.env.MIGRATE_QUERY_TIMEOUT;
        delete process.env.MIGRATE_QUERY_TIMEOUT;
        logger = observability.getLogger();
        sinon.stub(logger, 'info');
        sinon.stub(logger, 'error');
    });

    afterEach(function () {
        sinon.restore();
        if(hadOriginalTimeout) process.env.MIGRATE_QUERY_TIMEOUT = originalTimeout;
        else delete process.env.MIGRATE_QUERY_TIMEOUT;
    });
}

describe('migrateColumnType() configured statement timeout', function () {
    installTimeoutEnvironmentHooks();

    it('uses one hour for the ALTER and restores the pool timeout before release', async function () {
        const { calls, context, db } = fakeMigration();

        await migrate(context);

        expect(calls.map(call => call.sql.split(' ')[0])).to.deep.equal(['SELECT', 'SET', 'ALTER', 'SET']);
        expect(calls[1]).to.deep.equal({ sql: 'SET SESSION max_statement_time = ?', params: [3600] });
        expect(calls[3]).to.deep.equal({ sql: 'SET SESSION max_statement_time = ?', params: [30] });
        expect(db.release.calledOnce).to.equal(true);
        expect(db.release.calledAfter(db.query)).to.equal(true);
    });

    it('honors zero and 900000 milliseconds while still restoring 30 seconds', async function () {
        for(const [configured, expectedSeconds] of [['0', 0], ['900000', 900]]){
            process.env.MIGRATE_QUERY_TIMEOUT = configured;
            const { calls, context } = fakeMigration();

            await migrate(context);

            expect(calls.filter(call => call.sql.startsWith('SET SESSION')).map(call => call.params[0]))
                .to.deep.equal([expectedSeconds, 30]);
        }
    });

    it('falls back to one hour for empty, non-numeric, and negative values', async function () {
        for(const configured of ['', 'not-a-number', '-1']){
            process.env.MIGRATE_QUERY_TIMEOUT = configured;
            const { calls, context } = fakeMigration();

            await migrate(context);

            expect(calls[1].params).to.deep.equal([3600]);
        }
    });

    it('restores no limit when the pool has no runtime timeout', async function () {
        const { calls, context } = fakeMigration();
        delete context.connectionPoolParams;

        await migrate(context);

        expect(calls[3].params).to.deep.equal([0]);
    });
});

describe('migrateColumnType() failure handling', function () {
    installTimeoutEnvironmentHooks();

    it('restores and releases after a swallowed ALTER failure', async function () {
        const { calls, context, db } = fakeMigration('timestamp', { alterError: new Error('alter failed') });

        await migrate(context);

        expect(calls.map(call => call.sql.split(' ')[0])).to.deep.equal(['SELECT', 'SET', 'ALTER', 'SET']);
        expect(calls[3].params).to.deep.equal([30]);
        expect(logger.error.calledOnce).to.equal(true);
        expect(db.release.calledOnce).to.equal(true);
    });

    it('does not change the session timeout when the live type already matches', async function () {
        const { calls, context, db } = fakeMigration('datetime');

        await migrate(context);

        expect(calls).to.have.lengthOf(1);
        expect(calls[0].sql).to.match(/^SELECT DATA_TYPE/);
        expect(db.release.calledOnce).to.equal(true);
    });

    it('destroys instead of releasing a connection whose timeout cannot be restored', async function () {
        const { context, db } = fakeMigration('timestamp', { restoreError: new Error('restore failed') });

        await migrate(context);

        expect(db.destroy.calledOnce).to.equal(true);
        expect(db.release.called).to.equal(false);
        expect(logger.error.calledOnce).to.equal(true);
    });
});
