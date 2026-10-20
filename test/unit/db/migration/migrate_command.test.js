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

// The operator migrate command: it applies manual files, names a missing connection
// variable before connecting, refuses an unknown argument, and closes the pool.

const sinon      = require('sinon');
const { expect } = require('chai');
const { main, parseArgs, connectionFromEnv } = require('../../../../src/db/migration/migrate.js');

const ENV = { HUB_DB_HOST: 'h', HUB_DB_PORT: '3306', HUB_DB_NAME: 'hubdb', HUB_DB_USER: 'u', HUB_DB_SECRET: 's' };

function fakeDatabase(result) {
    const made = [];
    class FakeDatabase {
        constructor(...args) { this.args = args; this.runDatedMigrations = sinon.stub().resolves(result); this.close = sinon.stub().resolves(); made.push(this); }
    }
    return { FakeDatabase, made };
}

describe('migrate command', function () {
    beforeEach(function () { sinon.stub(console, 'log'); sinon.stub(console, 'error'); });
    afterEach(function () { sinon.restore(); });

    it('parses repeatable --file targets and refuses anything else', function () {
        expect(parseArgs([])).to.deep.equal({ only: null });
        expect(parseArgs(['--file', 'a.sql', '--file', 'b.sql'])).to.deep.equal({ only: ['a.sql', 'b.sql'] });
        expect(() => parseArgs(['--apply'])).to.throw(/Unknown argument --apply/);
    });

    it('names a missing connection variable', function () {
        const env = Object.assign({}, ENV);
        delete env.HUB_DB_NAME;
        expect(() => connectionFromEnv(env)).to.throw(/HUB_DB_NAME/);
    });

    it('runs the dated migrations with manual files included, then closes', async function () {
        const { FakeDatabase, made } = fakeDatabase({ applied: ['x.sql'], baselined: [], pending: [], lockSkipped: false });
        expect(await main(['--file', 'x.sql'], ENV, FakeDatabase)).to.equal(0);
        expect(made[0].args).to.deep.equal(['h', '3306', 'hubdb', 'u', 's']);
        expect(made[0].runDatedMigrations.calledOnceWithExactly({ includeManual: true, only: ['x.sql'] })).to.equal(true);
        expect(made[0].close.calledOnce).to.equal(true);
    });

    it('exits 1 when another process holds the migration lock', async function () {
        const { FakeDatabase, made } = fakeDatabase({ applied: [], baselined: [], pending: [], lockSkipped: true });
        expect(await main([], ENV, FakeDatabase)).to.equal(1);
        expect(made[0].close.calledOnce).to.equal(true);
    });
});
