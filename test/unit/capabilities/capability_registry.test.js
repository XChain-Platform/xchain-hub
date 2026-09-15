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

const sinon              = require('sinon');
const { expect }         = require('chai');
const proxyquire         = require('proxyquire');
const { DB_METHODS }     = require('../../helpers/mockHub');

// ────────────────────────────────────────────────────────────────────────────
// Stub out capabilities/index.js so we don't hit real self-tests
// ────────────────────────────────────────────────────────────────────────────

let selfTestStubs;
let CapabilityRegistry;

function loadModule(selfTestResults) {
    selfTestStubs = {};
    let CAPS = ['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node'];
    for (let cap of CAPS) {
        selfTestStubs[cap] = {
            selfTest: sinon.stub().resolves(
                selfTestResults && selfTestResults[cap] !== undefined
                    ? selfTestResults[cap]
                    : { ok: true, reason: null }
            )
        };
    }
    CapabilityRegistry = proxyquire('../../../src/validators/capability_registry', {
        '../capabilities/index.js': selfTestStubs
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Make a hub with a connection-returning DB stub
// ────────────────────────────────────────────────────────────────────────────

function makeDb() {
    let conn = {
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    };
    // DB_METHODS carries the named query methods the src/db mixins install. The
    // registry's statements now live in db/validators.js and take the connection as
    // their first argument, so the double needs the real methods: each one calls
    // conn.query, and the stub below still sees the same SQL with the same args.
    return {
        ...DB_METHODS,
        _conn: conn,
        getConnection: sinon.stub().resolves(conn)
    };
}

function makeHub(overrides) {
    let db = overrides && overrides.db ? overrides.db : makeDb();
    return {
        db,
        p2pConfig: overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        _db: db
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

function registerRegistryActiveSuite() {
describe('isActive()', function () {
        it('returns false when no row exists', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.isActive('pk', 'price');
            expect(result).to.be.false;
        });

        it('returns true when all three flags are truthy', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([{ qualified: 1, self_test_ok: 1, enabled: 1 }]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.isActive('pk', 'price');
            expect(result).to.be.true;
        });

        it('returns false when any flag is falsy', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([{ qualified: 1, self_test_ok: 0, enabled: 1 }]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.isActive('pk', 'price');
            expect(result).to.be.false;
        });
    });
}

function registerRegistryEnabledSuite() {
describe('setEnabled()', function () {
        it('persists enabled flag with correct sql', async function () {
            loadModule();
            let db  = makeDb();
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            await reg.setEnabled('pk', 'cross_chain', false);
            let [sql, vals] = db._conn.query.firstCall.args;
            expect(sql).to.match(/INSERT INTO validator_capabilities/);
            expect(vals[1]).to.equal('cross_chain');
            expect(vals[2]).to.equal(0);
        });

        it('throws for unknown capability', async function () {
            loadModule();
            let hub = makeHub();
            let reg = new CapabilityRegistry(hub);
            let threw = false;
            try { await reg.setEnabled('pk', 'bogus', true); }
            catch (e) { threw = true; expect(e.message).to.include('unknown capability'); }
            expect(threw).to.be.true;
        });
    });
}

function registerRegistrySelfTestResultSuite() {
describe('setSelfTestResult()', function () {
        it('persists self-test result with correct sql', async function () {
            loadModule();
            let db  = makeDb();
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            await reg.setSelfTestResult('pk', 'attestation', true, 'all good');
            let [sql, vals] = db._conn.query.firstCall.args;
            expect(sql).to.match(/INSERT INTO validator_capabilities/);
            expect(vals[1]).to.equal('attestation');
            expect(vals[2]).to.equal(1);
            expect(vals[3]).to.equal('all good');
        });

        it('releases connection on error', async function () {
            loadModule();
            let db  = makeDb();
            db._conn.query.rejects(new Error('db error'));
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            try { await reg.setSelfTestResult('pk', 'price', false, null); } catch (_) {}
            expect(db._conn.release.calledOnce).to.be.true;
        });
    });
}

function registerRegistryQualificationSuite() {
describe('setQualification()', function () {
        it('calls the DB with correct parameters for a known capability', async function () {
            loadModule();
            let db  = makeDb();
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            await reg.setQualification('PUBKEY01', 'price', true, 500);
            expect(db.getConnection.calledOnce).to.be.true;
            let [sql, vals] = db._conn.query.firstCall.args;
            expect(sql).to.match(/INSERT INTO validator_capabilities/);
            expect(vals[0]).to.equal('pubkey01'); // lowercased
            expect(vals[1]).to.equal('price');
            expect(vals[2]).to.equal(1);
            expect(vals[3]).to.equal(500);
        });

        it('releases the connection even when query throws', async function () {
            loadModule();
            let db  = makeDb();
            db._conn.query.rejects(new Error('db error'));
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let threw = false;
            try { await reg.setQualification('pk', 'price', true, 0); }
            catch (_) { threw = true; }
            expect(threw).to.be.true;
            expect(db._conn.release.calledOnce).to.be.true;
        });

        it('throws for an unknown capability', async function () {
            loadModule();
            let hub = makeHub();
            let reg = new CapabilityRegistry(hub);
            let threw = false;
            try { await reg.setQualification('pk', 'badcap', true, 0); }
            catch (e) { threw = true; expect(e.message).to.include('unknown capability'); }
            expect(threw).to.be.true;
        });
    });
}

function registerRegistryGovernanceSuite() {
describe('applyGovernanceChange()', function () {
        it('updates the in-memory MIN_STAKE for a known capability', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { CAPABILITIES: { price: { MIN_STAKE: '1000' } } } });
            let reg = new CapabilityRegistry(hub);
            reg.applyGovernanceChange('price', 'MIN_STAKE', '99999');
            expect(reg.getMinStake('price')).to.equal('99999');
        });

        it('creates a new config entry if the capability had none', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { CAPABILITIES: {} } });
            let reg = new CapabilityRegistry(hub);
            reg.applyGovernanceChange('cross_chain', 'MIN_STAKE', '5000');
            expect(reg.getMinStake('cross_chain')).to.equal('5000');
        });

        it('throws for an unknown capability', function () {
            loadModule();
            let hub = makeHub();
            let reg = new CapabilityRegistry(hub);
            expect(() => reg.applyGovernanceChange('unknown', 'MIN_STAKE', '0')).to.throw('unknown capability');
        });
    });
}

function registerRegistryDisabledSuite() {
describe('isDisabledByOperator()', function () {
        it('returns false for capabilities not in DISABLED_CAPABILITIES', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { DISABLED_CAPABILITIES: ['price'] } });
            let reg = new CapabilityRegistry(hub);
            expect(reg.isDisabledByOperator('oracle_publish')).to.be.false;
        });

        it('returns true for capabilities in the opt-out list', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { DISABLED_CAPABILITIES: ['oracle_publish'] } });
            let reg = new CapabilityRegistry(hub);
            expect(reg.isDisabledByOperator('oracle_publish')).to.be.true;
        });
    });
}

function registerRegistryMinStakeSuite() {
describe('getMinStake()', function () {
        it('returns null when capability has no config entry', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { CAPABILITIES: {} } });
            let reg = new CapabilityRegistry(hub);
            expect(reg.getMinStake('price')).to.be.null;
        });

        it('returns "0" when entry has no MIN_STAKE key', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { CAPABILITIES: { price: {} } } });
            let reg = new CapabilityRegistry(hub);
            expect(reg.getMinStake('price')).to.equal('0');
        });

        it('returns the configured MIN_STAKE string', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { CAPABILITIES: { attestation: { MIN_STAKE: '25000' } } } });
            let reg = new CapabilityRegistry(hub);
            expect(reg.getMinStake('attestation')).to.equal('25000');
        });
    });
}

function registerRegistryCapabilitiesSuite() {
describe('getCapabilities()', function () {
        it('returns all five known capabilities', function () {
            loadModule();
            let hub = makeHub();
            let reg = new CapabilityRegistry(hub);
            expect(reg.getCapabilities()).to.deep.equal(['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node']);
        });

        it('returns a copy (mutations do not affect internal state)', function () {
            loadModule();
            let hub = makeHub();
            let reg = new CapabilityRegistry(hub);
            let caps = reg.getCapabilities();
            caps.push('bogus');
            expect(reg.getCapabilities()).to.have.length(5);
        });
    });
}

function registerRegistryConstructorSuite() {
describe('constructor', function () {
        it('loads KNOWN_CAPABILITIES from module export', function () {
            loadModule();
            let { KNOWN_CAPABILITIES } = require('../../../src/validators/capability_registry');
            expect(KNOWN_CAPABILITIES).to.deep.equal(['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node']);
        });

        it('seeds capConfig from p2pConfig.CAPABILITIES', function () {
            loadModule();
            let hub = makeHub({
                p2pConfig: {
                    CAPABILITIES: { price: { MIN_STAKE: '5000' } }
                }
            });
            let reg = new CapabilityRegistry(hub);
            expect(reg.getMinStake('price')).to.equal('5000');
        });

        it('seeds disabled set from DISABLED_CAPABILITIES', function () {
            loadModule();
            let hub = makeHub({
                p2pConfig: { DISABLED_CAPABILITIES: ['price', 'cross_chain'] }
            });
            let reg = new CapabilityRegistry(hub);
            expect(reg.isDisabledByOperator('price')).to.be.true;
            expect(reg.isDisabledByOperator('attestation')).to.be.false;
        });
    });
}

describe('CapabilityRegistry', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    registerRegistryConstructorSuite();

    // ── getCapabilities ──────────────────────────────────────────────────────

    registerRegistryCapabilitiesSuite();

    // ── getMinStake ──────────────────────────────────────────────────────────

    registerRegistryMinStakeSuite();

    // ── isDisabledByOperator ─────────────────────────────────────────────────

    registerRegistryDisabledSuite();

    // ── applyGovernanceChange ───────────────────────────────────────────────

    registerRegistryGovernanceSuite();

    // ── setQualification ────────────────────────────────────────────────────

    registerRegistryQualificationSuite();

    // ── setSelfTestResult ────────────────────────────────────────────────────

    registerRegistrySelfTestResultSuite();

    // ── setEnabled ───────────────────────────────────────────────────────────

    registerRegistryEnabledSuite();

    // ── isActive ─────────────────────────────────────────────────────────────

    registerRegistryActiveSuite();

    // ── getActiveValidators ──────────────────────────────────────────────────

});
