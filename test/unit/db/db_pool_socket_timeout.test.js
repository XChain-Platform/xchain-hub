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

// queryTimeout is enforced by the server (SET STATEMENT max_statement_time), so a
// frozen server leaves an in-flight query with no client-side bound. The pool must
// carry a socketTimeout larger than queryTimeout so a dead socket is cut client-side.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

describe('Database pool socketTimeout', function () {
    let Database, mockMariadb, saved;

    beforeEach(function () {
        saved = { s: process.env.DB_SOCKET_TIMEOUT, q: process.env.DB_QUERY_TIMEOUT };
        mockMariadb = { createPool: sinon.stub().returns({ end: sinon.stub().resolves() }) };
        Database = proxyquire('../../../src/db', {
            mariadb: mockMariadb,
            fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
            path:    require('path')
        });
    });

    afterEach(function () {
        for (const [k, v] of [['DB_SOCKET_TIMEOUT', saved.s], ['DB_QUERY_TIMEOUT', saved.q]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    function build() {
        return new Database('127.0.0.1', 3306, 'hubdb', 'u', 'p').connectionPoolParams;
    }

    it('sets a positive socketTimeout greater than queryTimeout', function () {
        delete process.env.DB_SOCKET_TIMEOUT;
        delete process.env.DB_QUERY_TIMEOUT;
        const p = build();
        expect(p.socketTimeout).to.be.a('number').and.greaterThan(0);
        expect(p.socketTimeout).to.be.greaterThan(p.queryTimeout);
    });

    it('keeps socketTimeout above a raised queryTimeout', function () {
        delete process.env.DB_SOCKET_TIMEOUT;
        process.env.DB_QUERY_TIMEOUT = '90000';
        const p = build();
        expect(p.socketTimeout).to.be.greaterThan(90000);
    });

    it('honours the DB_SOCKET_TIMEOUT override', function () {
        process.env.DB_SOCKET_TIMEOUT = '60000';
        expect(build().socketTimeout).to.equal(60000);
    });
});
