'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Regression guards for the validator setup/run findings (2026-05-30 audit).
 * Each of these bugs was SILENT: the node came up and looked healthy while
 * being subtly broken, which is exactly what a permanent regression gate is
 * for. Spec: claude/reports/specs/2026-05-30_validator-test-spec.md (Pillar B);
 * handover: claude/reports/2026-05-30_validator-testing-handover.md §3.2.
 *
 *   F1  mariadb ^3.5.x is ESM-only → require('mariadb') crashed fresh builds.
 *   F3  startCapabilities() was never called → self-test config unreachable.
 *   F4  qualification defaulted to a 0 threshold → unstaked node qualified for
 *       everything. Now FAIL-CLOSED.
 *   F5  DB privilege errors retried forever → startup hung. Now fail-fast.
 *
 * All L1: no coin node, no live DB, no network.
 */

const fs           = require('fs');
const path         = require('path');
const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

describe('Regression: validator setup/run fixes', function () {

    // -----------------------------------------------------------------
    // REG-VAL-001 (F1): mariadb stays on a CommonJS-loadable version.
    // The 3.5.x line is ESM-only; require('mariadb') throws ERR_REQUIRE_ESM
    // there, which broke every fresh `require`-based build (hub/node/indexer/…).
    // -----------------------------------------------------------------
    describe('REG-VAL-001: mariadb is CommonJS-loadable (not ESM-only 3.5.x)', function () {
        it('require("mariadb") loads without ERR_REQUIRE_ESM @regression-p0', function () {
            expect(() => require('mariadb')).to.not.throw();
        });

        it('installed mariadb is < 3.5.0 (the ESM cutover) @regression-p0', function () {
            const v = require('mariadb/package.json').version;
            const [maj, min] = v.split('.').map((n) => parseInt(n, 10));
            expect(maj, `mariadb ${v}`).to.equal(3);
            expect(min, `mariadb ${v} is ESM-only; re-pin to ~3.4.x`).to.be.below(5);
        });

        it('src/db.js (which require()s mariadb) loads under CommonJS @regression-p0', function () {
            expect(() => require('../../src/db')).to.not.throw();
        });
    });

    // -----------------------------------------------------------------
    // REG-VAL-002 (F3): api.js must wire startCapabilities() into bring-up.
    // The bug was that it was never called, so HUB_CAPABILITY_CONFIG self-test
    // config never loaded and every config-bearing capability silently failed.
    // A static guard is the right level: fully booting api.js stands up a
    // server, but the regression is purely "is the call present in start-up".
    // -----------------------------------------------------------------
    describe('REG-VAL-002: api.js wires startCapabilities into bring-up', function () {
        it('src/api.js calls hub.startCapabilities(...) @regression-p0', function () {
            const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
            // strip line comments so a commented-out call does not pass the guard
            const live = src.replace(/^[ \t]*\/\/.*$/gm, '');
            expect(live).to.match(/\.startCapabilities\s*\(/,
                'api.js no longer calls startCapabilities; capability self-tests will not run');
        });
    });

    // -----------------------------------------------------------------
    // REG-VAL-003 (F4): qualification is FAIL-CLOSED. A capability with no
    // configured MIN_STAKE must leave the node NOT qualified, regardless of
    // stake; never default the threshold to 0. The old behavior qualified an
    // unstaked (or any) node for every capability and diverged from the
    // indexer's authoritative governance threshold used to lock quorum N.
    // Drives the REAL XChainHub.refreshOwnQualification + CapabilityRegistry.
    // -----------------------------------------------------------------
    describe('REG-VAL-003: capability qualification is fail-closed', function () {
        const XChainHub         = require('../../src/XChainHub');
        const CapabilityRegistry = require('../../src/CapabilityRegistry');

        // Build a stub hub that exposes exactly what refreshOwnQualification
        // touches, wired to the real registry + real decimal-compare methods.
        function makeHub(capConfig) {
            const registry = new CapabilityRegistry({ p2pConfig: { CAPABILITIES: capConfig }, db: null });
            const setQual  = sinon.stub().resolves();
            registry.setQualification = setQual;
            const hub = {
                identity: { getPubkeyHex: () => 'aa'.repeat(33) },
                capabilityRegistry: registry,
                _broadcastOwnCapabilityState: sinon.stub().resolves(),
                _compareDecimal:    XChainHub.prototype._compareDecimal,
                _parseDecimalParts: XChainHub.prototype._parseDecimalParts
            };
            return { hub, setQual };
        }
        // Last qualification verdict the method persisted for a capability.
        const verdict = (setQual, cap) => {
            const call = setQual.getCalls().reverse().find((c) => c.args[1] === cap);
            return call ? call.args[2] : undefined;
        };

        it('a capability with NO configured MIN_STAKE is never qualified, even with huge stake @regression-p0', async function () {
            // Only `price` has a threshold; the other three are unconfigured.
            const { hub, setQual } = makeHub({ price: { MIN_STAKE: '1000.00000000' } });
            await XChainHub.prototype.refreshOwnQualification.call(hub, '999999.00000000', 500);

            expect(verdict(setQual, 'cross_chain'),  'cross_chain must fail-closed').to.equal(false);
            expect(verdict(setQual, 'oracle_publish'),'oracle_publish must fail-closed').to.equal(false);
            expect(verdict(setQual, 'attestation'),  'attestation must fail-closed').to.equal(false);
            // sanity: the configured one DOES qualify when stake >= threshold
            expect(verdict(setQual, 'price'), 'price should qualify (999999 >= 1000)').to.equal(true);
        });

        it('a zero-stake node qualifies for nothing @regression-p0', async function () {
            const { hub, setQual } = makeHub({ price: { MIN_STAKE: '1000.00000000' } });
            await XChainHub.prototype.refreshOwnQualification.call(hub, '0', 500);
            for (const cap of ['price', 'cross_chain', 'oracle_publish', 'attestation']) {
                expect(verdict(setQual, cap), `${cap} with zero stake`).to.equal(false);
            }
        });

        it('threshold comparison is exact at the boundary @regression-p1', async function () {
            const { hub, setQual } = makeHub({ price: { MIN_STAKE: '1000.00000000' } });
            await XChainHub.prototype.refreshOwnQualification.call(hub, '1000.00000000', 500);
            expect(verdict(setQual, 'price'), 'stake == threshold qualifies').to.equal(true);

            const b = makeHub({ price: { MIN_STAKE: '1000.00000000' } });
            await XChainHub.prototype.refreshOwnQualification.call(b.hub, '999.99999999', 500);
            expect(verdict(b.setQual, 'price'), 'one satoshi short does not qualify').to.equal(false);
        });
    });

    // -----------------------------------------------------------------
    // REG-VAL-004 (F5): DB credential/privilege errors fail FAST. They are not
    // transient, so the connect loop must surface them immediately instead of
    // retrying forever (which hung validator startup). Transient errors
    // (connection refused, DB still booting) must NOT be treated as fatal.
    // -----------------------------------------------------------------
    describe('REG-VAL-004: DB privilege errors fail fast, transient errors do not', function () {
        let Database;
        beforeEach(function () {
            // Mock mariadb so the constructor's createPool() touches no real DB.
            Database = proxyquire('../../src/db', {
                mariadb: { createPool: sinon.stub().returns({ getConnection: sinon.stub(), end: sinon.stub() }) }
            });
        });
        afterEach(function () { sinon.restore(); });

        const FATAL = [
            'ER_ACCESS_DENIED_ERROR',
            'ER_DBACCESS_DENIED_ERROR',
            'ER_SPECIFIC_ACCESS_DENIED_ERROR',
            'ER_PASSWORD_NO_MATCH'
        ];
        const TRANSIENT = ['ECONNREFUSED', 'ETIMEDOUT', 'ER_GET_CONNECTION_TIMEOUT', undefined];

        it('throws immediately on every credential/privilege error code @regression-p0', function () {
            const db = new Database('localhost', 3306, 'hub_test', 'baduser', 'badpass');
            for (const code of FATAL) {
                expect(() => db._failFastIfFatal({ code }, 'connecting'),
                    `${code} should be fatal`).to.throw(/Fatal DB error/);
            }
        });

        it('does NOT throw on transient errors (keeps waiting) @regression-p0', function () {
            const db = new Database('localhost', 3306, 'hub_test', 'user', 'pass');
            for (const code of TRANSIENT) {
                expect(() => db._failFastIfFatal(code ? { code } : null, 'connecting'),
                    `${code} should be transient`).to.not.throw();
            }
        });
    });
});
