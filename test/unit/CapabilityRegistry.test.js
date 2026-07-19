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
    CapabilityRegistry = proxyquire('../../src/CapabilityRegistry', {
        './capabilities/index.js': selfTestStubs
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
    return {
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

describe('CapabilityRegistry', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('loads KNOWN_CAPABILITIES from module export', function () {
            loadModule();
            let { KNOWN_CAPABILITIES } = require('../../src/CapabilityRegistry');
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

    // ── getCapabilities ──────────────────────────────────────────────────────

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

    // ── getMinStake ──────────────────────────────────────────────────────────

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

    // ── isDisabledByOperator ─────────────────────────────────────────────────

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

    // ── _applyGovernanceChange ───────────────────────────────────────────────

    describe('_applyGovernanceChange()', function () {
        it('updates the in-memory MIN_STAKE for a known capability', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { CAPABILITIES: { price: { MIN_STAKE: '1000' } } } });
            let reg = new CapabilityRegistry(hub);
            reg._applyGovernanceChange('price', 'MIN_STAKE', '99999');
            expect(reg.getMinStake('price')).to.equal('99999');
        });

        it('creates a new config entry if the capability had none', function () {
            loadModule();
            let hub = makeHub({ p2pConfig: { CAPABILITIES: {} } });
            let reg = new CapabilityRegistry(hub);
            reg._applyGovernanceChange('cross_chain', 'MIN_STAKE', '5000');
            expect(reg.getMinStake('cross_chain')).to.equal('5000');
        });

        it('throws for an unknown capability', function () {
            loadModule();
            let hub = makeHub();
            let reg = new CapabilityRegistry(hub);
            expect(() => reg._applyGovernanceChange('unknown', 'MIN_STAKE', '0')).to.throw('unknown capability');
        });
    });

    // ── setQualification ────────────────────────────────────────────────────

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

    // ── setSelfTestResult ────────────────────────────────────────────────────

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

    // ── setEnabled ───────────────────────────────────────────────────────────

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

    // ── isActive ─────────────────────────────────────────────────────────────

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

    // ── getActiveValidators ──────────────────────────────────────────────────

    describe('getActiveValidators()', function () {
        it('returns pubkeys of all active validators', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([{ signing_pubkey: 'pub1' }, { signing_pubkey: 'pub2' }]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.getActiveValidators('attestation');
            expect(result).to.deep.equal(['pub1', 'pub2']);
        });

        it('returns empty array when no validators qualify', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.getActiveValidators('attestation');
            expect(result).to.deep.equal([]);
        });
    });

    // ── getActiveCount ───────────────────────────────────────────────────────

    describe('getActiveCount()', function () {
        it('returns the count from DB', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([{ cnt: 5 }]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let count = await reg.getActiveCount('price');
            expect(count).to.equal(5);
        });

        it('returns 0 when DB returns empty rows', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let count = await reg.getActiveCount('price');
            expect(count).to.equal(0);
        });
    });

    // ── getState ─────────────────────────────────────────────────────────────

    describe('getState()', function () {
        it('returns the row object when found', async function () {
            loadModule();
            let db = makeDb();
            let row = { signing_pubkey: 'pk', capability: 'price', qualified: 1 };
            db._conn.query.resolves([row]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.getState('pk', 'price');
            expect(result).to.equal(row);
        });

        it('returns null when no row exists', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.getState('pk', 'price');
            expect(result).to.be.null;
        });
    });

    // ── getOwnState ──────────────────────────────────────────────────────────

    describe('getOwnState()', function () {
        it('returns all rows for the given pubkey', async function () {
            loadModule();
            let db = makeDb();
            db._conn.query.resolves([
                { capability: 'price', qualified: 1 },
                { capability: 'attestation', qualified: 0 }
            ]);
            let hub = makeHub({ db });
            let reg = new CapabilityRegistry(hub);
            let result = await reg.getOwnState('pk');
            expect(result).to.have.length(2);
        });
    });

    // ── runAllSelfTests ──────────────────────────────────────────────────────

    describe('runAllSelfTests()', function () {
        it('calls selfTest for each known capability and returns results', async function () {
            loadModule({
                price:          { ok: true },
                cross_chain:    { ok: false, reason: 'no chains' },
                oracle_publish: { ok: true },
                attestation:    { ok: true }
            });
            let db  = makeDb();
            let hub = makeHub({ db, p2pConfig: { DISABLED_CAPABILITIES: [] } });
            let reg = new CapabilityRegistry(hub);
            let results = await reg.runAllSelfTests('mypubkey');
            expect(results).to.have.length(5);
            let priceResult = results.find(r => r.capability === 'price');
            expect(priceResult.ok).to.be.true;
            let ccResult = results.find(r => r.capability === 'cross_chain');
            expect(ccResult.ok).to.be.false;
        });

        it('marks ok=false and records reason when selfTest throws', async function () {
            // Override price to throw
            loadModule();
            selfTestStubs.price.selfTest.rejects(new Error('probe threw'));
            let db  = makeDb();
            let hub = makeHub({ db, p2pConfig: { DISABLED_CAPABILITIES: [] } });
            let reg = new CapabilityRegistry(hub);
            let results = await reg.runAllSelfTests('pk');
            let priceResult = results.find(r => r.capability === 'price');
            expect(priceResult.ok).to.be.false;
            expect(priceResult.reason).to.include('probe threw');
        });

        it('marks capability disabled when in DISABLED_CAPABILITIES', async function () {
            loadModule();
            let db  = makeDb();
            let hub = makeHub({ db, p2pConfig: { DISABLED_CAPABILITIES: ['cross_chain'] } });
            let reg = new CapabilityRegistry(hub);
            await reg.runAllSelfTests('pk');
            // The second call to db._conn.query for each cap is setEnabled; capture all calls
            // and verify at least one call sets enabled=0 for cross_chain
            let queries = db._conn.query.args.map(a => JSON.stringify(a));
            let hasDisableCall = queries.some(q => q.includes('cross_chain') && q.includes('0'));
            expect(hasDisableCall).to.be.true;
        });
    });

    // ── Block-anchored MIN_STAKE history (#3703) ──────────────────────────────

    describe('block-anchored MIN_STAKE history', function () {
        function reg(minStake) {
            loadModule();
            return new CapabilityRegistry(makeHub({
                p2pConfig: { CAPABILITIES: { price: { MIN_STAKE: String(minStake) } } }
            }));
        }

        it('getMinStake(cap, N) resolves the threshold effective at block N across boundaries', function () {
            let r = reg('10000');
            r.applyMinStakeActivation('price', 1000, '25000');
            r.applyMinStakeActivation('price', 2000, '5000');
            expect(r.getMinStake('price', 0)).to.equal('10000');     // genesis
            expect(r.getMinStake('price', 999)).to.equal('10000');
            expect(r.getMinStake('price', 1000)).to.equal('25000');  // at activation
            expect(r.getMinStake('price', 1999)).to.equal('25000');
            expect(r.getMinStake('price', 2000)).to.equal('5000');
            expect(r.getMinStake('price', 9999)).to.equal('5000');
            expect(r.getMinStake('price')).to.equal('5000');         // no-block → latest
        });

        it('applyMinStakeActivation is idempotent by activation_block (re-apply replaces, no dup)', function () {
            let r = reg('10000');
            r.applyMinStakeActivation('price', 1000, '25000');
            r.applyMinStakeActivation('price', 1000, '30000'); // same block, corrected value
            expect(r.minStakeHistory.price.filter(e => e.activation_block === 1000)).to.have.length(1);
            expect(r.getMinStake('price', 1000)).to.equal('30000');
        });

        it('out-of-order appends are sorted so resolution stays correct', function () {
            let r = reg('10000');
            r.applyMinStakeActivation('price', 2000, '5000');
            r.applyMinStakeActivation('price', 1000, '25000'); // appended after, lower block
            expect(r.getMinStake('price', 1500)).to.equal('25000');
            expect(r.getMinStake('price', 2500)).to.equal('5000');
        });

        it('rejects an invalid activation_block', function () {
            let r = reg('10000');
            expect(() => r.applyMinStakeActivation('price', -1, '1')).to.throw('invalid activation_block');
            expect(() => r.applyMinStakeActivation('price', 1.5, '1')).to.throw('invalid activation_block');
            expect(() => r.applyMinStakeActivation('bogus', 10, '1')).to.throw('unknown capability');
        });

        it('two hubs fed the identical finalized history resolve identical thresholds at every block', function () {
            let a = reg('10000'), b = reg('10000');
            // Apply the same set of changes in DIFFERENT order (simulating different wall-clock arrival)
            a.applyMinStakeActivation('price', 1000, '25000');
            a.applyMinStakeActivation('price', 3000, '40000');
            b.applyMinStakeActivation('price', 3000, '40000');
            b.applyMinStakeActivation('price', 1000, '25000');
            for (let n of [0, 999, 1000, 2999, 3000, 5000])
                expect(a.getMinStake('price', n)).to.equal(b.getMinStake('price', n));
        });

        it('loadGovernanceHistory skips all MIN_STAKE rows while governance pin is set', async function () {
            // MIN_STAKE_GOVERNANCE_DISABLED is true (pre-launch pin): passed proposals
            // must NOT be applied because the indexer acceptance path uses a frozen
            // constant and applying hub-side would fork quorum N. All blocks resolve
            // to the genesis value regardless of what the DB contains.
            loadModule();
            let db = makeDb();
            db.doQuery = sinon.stub().resolves([
                { parameter: 'CAPABILITY_PRICE_MIN_STAKE', proposed_value: '25000', activation_block: 1000 },
                { parameter: 'CAPABILITY_PRICE_MIN_STAKE', proposed_value: '5000',  activation_block: 2000 },
                { parameter: 'ORACLE_ROUND_INTERVAL',       proposed_value: '900000', activation_block: 1500 } // ignored
            ]);
            let r = new CapabilityRegistry(makeHub({ db, p2pConfig: { CAPABILITIES: { price: { MIN_STAKE: '10000' } } } }));
            await r.loadGovernanceHistory();
            expect(r.getMinStake('price', 999)).to.equal('10000');
            expect(r.getMinStake('price', 1000)).to.equal('10000');
            expect(r.getMinStake('price', 2000)).to.equal('10000');
        });

        it('loadGovernanceHistory is best-effort when the table/doQuery is unavailable', async function () {
            let r = reg('10000'); // makeHub default db has no doQuery
            await r.loadGovernanceHistory();
            expect(r.getMinStake('price', 5000)).to.equal('10000'); // genesis only, no crash
        });
    });

    // -----------------------------------------------------------------
    // L4 determinism: governed MIN_STAKE recompute (spec §6 / validator-test-spec)
    //
    // A governance MIN_STAKE change is block-anchored: getMinStake(cap, N) is a
    // pure function of block height + the finalized history, so every hub
    // RECOMPUTES the same threshold for block N regardless of when (wall-clock)
    // or in what order it applied the change. That determinism is what keeps the
    // qualifying validator set (and quorum N) identical federation-wide across a
    // threshold change. These pin the recompute contract (the MIN_STAKE-recompute
    // half of spec §6 "Determinism (L4)" item 1).
    // -----------------------------------------------------------------
    describe('L4 determinism: governed MIN_STAKE recompute', function () {
        function reg(genesis) {
            loadModule();
            return new CapabilityRegistry(makeHub({
                p2pConfig: { CAPABILITIES: { price: { MIN_STAKE: String(genesis) } } }
            }));
        }

        // A validator qualifies iff its aggregate stake >= the threshold RECOMPUTED
        // for the round's block. This is the same gate CapabilitySnapshot applies;
        // driving it off getMinStake here proves the recompute is stable federation-wide.
        const qualifies = (r, stake, block) =>
            BigInt(stake) >= BigInt(r.getMinStake('price', block));

        it('two hubs recompute an identical threshold at every block after the same governed change', function () {
            const a = reg('10000'), b = reg('10000');
            a.applyMinStakeActivation('price', 5000, '25000');
            b.applyMinStakeActivation('price', 5000, '25000');
            for (const n of [0, 4999, 5000, 5001, 10000])
                expect(a.getMinStake('price', n)).to.equal(b.getMinStake('price', n));
        });

        it('the recomputed qualifying verdict flips at the activation block, identically on both hubs', function () {
            const a = reg('10000'), b = reg('10000');
            // Same finalized change applied in OPPOSITE order (different arrival times).
            a.applyMinStakeActivation('price', 5000, '25000');
            b.applyMinStakeActivation('price', 5000, '25000');
            // A validator staking 20000 qualifies under the 10000 genesis floor, then
            // DROPS OUT the instant the recomputed 25000 threshold activates at 5000.
            for (const n of [4999, 5000, 5001])
                expect(qualifies(a, '20000', n)).to.equal(qualifies(b, '20000', n));
            expect(qualifies(a, '20000', 4999)).to.equal(true);   // under the old floor
            expect(qualifies(a, '20000', 5000)).to.equal(false);  // recomputed out at activation
        });

        it('recompute is order-independent: interleaved multi-change history yields one canonical threshold curve', function () {
            const a = reg('10000'), b = reg('10000');
            // Three governed changes, applied in different orders on each hub.
            a.applyMinStakeActivation('price', 2000, '15000');
            a.applyMinStakeActivation('price', 8000, '5000');
            a.applyMinStakeActivation('price', 5000, '25000');
            b.applyMinStakeActivation('price', 5000, '25000');
            b.applyMinStakeActivation('price', 2000, '15000');
            b.applyMinStakeActivation('price', 8000, '5000');
            for (const n of [0, 1999, 2000, 4999, 5000, 7999, 8000, 12000])
                expect(a.getMinStake('price', n)).to.equal(b.getMinStake('price', n));
        });
    });
});
