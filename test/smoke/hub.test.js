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

const { expect }       = require('chai');
const { execFileSync } = require('child_process');
const fs               = require('fs');
const path             = require('path');

const testDb           = require('../helpers/testDb');

const API_ENTRY = path.resolve(__dirname, '../../src/api.js');
const SQL_DIR   = path.resolve(__dirname, '../../src/sql');

function schemaTableCount() {
    return fs.readdirSync(SQL_DIR)
        .filter(name => name.endsWith('.sql'))
        .length;
}

// ── Test Suite ───────────────────────────────────────────────────

// Run from the test directory so a caller's root .env cannot replace a variable
// deliberately omitted by an environment-validation case.
function bootHub(env, timeoutMs) {
    let result = { threw: false, stderr: '', status: null, signal: null };
    try {
        execFileSync('node', [API_ENTRY], {
            cwd: __dirname, env: env, timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe']
        });
    } catch (e) {
        result = { threw: true, stderr: (e.stderr || '').toString(), status: e.status, signal: e.signal };
    }
    return result;
}

// ─── SMOKE-HUB-001: Environment Variable Validation ─────────
function environmentValidationSuite() {
        const REQUIRED = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT'];

        // Build a complete valid env set (values don't matter; the process exits before connecting)
        // All values must be truthy: api.js checks !process.env[key] which treats '' as missing
        const validEnv = {
            HUB_DB_HOST: '127.0.0.1',
            HUB_DB_PORT: '3306',
            HUB_DB_NAME: 'smoke_test_dummy',
            HUB_DB_USER: 'root',
            HUB_DB_PASS: 'dummy',
            HUB_PORT:    '19999',
            PATH:        process.env.PATH,
            HOME:        process.env.HOME
        };

        for (const envVar of REQUIRED) {
            it('exits with error when ' + envVar + ' is missing', function () {
                const env = Object.assign({}, validEnv);
                delete env[envVar];

                let boot = bootHub(env, 3000);
                expect(boot.threw, 'process should have exited with non-zero code').to.be.true;
                expect(boot.stderr).to.include(envVar);
            });
        }

        // With every required var present but no HUB_API_KEY, the hub must
        // REFUSE to boot rather than serve an unauthenticated write surface.
        // Run as a real subprocess so this proves the process actually exits,
        // not just that a decision function returned refuse.
        it('refuses to boot with no HUB_API_KEY and no keyless declaration', function () {
            // The auth-posture refusal runs only after api.js has required the
            // whole hub module graph, which takes several seconds on a cold start,
            // so the child gets a generous budget and the test checks it exited
            // on its own rather than being killed by that budget.
            this.timeout(45000);
            let boot = bootHub(validEnv, 40000);
            expect(boot.threw, 'hub should have refused to boot unauthenticated').to.be.true;
            expect(boot.signal, 'hub was killed by the test timeout instead of exiting').to.equal(null);
            expect(boot.status).to.equal(1);
            expect(boot.stderr).to.include('REFUSING TO BOOT');
            expect(boot.stderr).to.include('HUB_ALLOW_UNAUTHENTICATED');
        });
    }

// ─── SMOKE-HUB-002: Database Connection & Schema Init ───────
function databaseInitSuite() {

        before(async function () {
            try { await testDb.setup(); } catch (e) {
                console.warn('MariaDB unavailable: skipping DB smoke tests');
            }
        });

        after(async function () {
            await testDb.teardown();
        });

        it('creates and verifies every table declared in src/sql', async function () {
            if (!testDb.isAvailable()) return this.skip();
            const db = testDb.getDb();
            const rows = await db.doQuery(
                'SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ?',
                [process.env.TEST_DB_NAME || 'xchain_hub_test']
            );
            expect(rows).to.have.lengthOf(schemaTableCount());
        });

        it('circuit breaker is in closed state after init (SMOKE-HUB-009)', function () {
            if (!testDb.isAvailable()) return this.skip();
            const db = testDb.getDb();
            expect(db.circuitState).to.equal('closed');
            expect(db.circuitFailures).to.equal(0);
        });
    }

function hubSmokeSuite() {
    describe('SMOKE-HUB-001: Environment variable validation', environmentValidationSuite);
    describe('SMOKE-HUB-002: Database connection & schema init', databaseInitSuite);
}

describe('Smoke: xchain-hub', hubSmokeSuite);
