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
//
// ---------------------------------------------------------------------------
// The zero-confirmation flip: hub-side value-identity suite (D32, spec
// attest-zero-confirmation-flip.md §8, §3.2). No hub test covered the widening
// or mirror maps before this train (D32); this file closes that gap for every
// LOCAL COPY the flip's ONE activation height touches, plus the height's own
// ordering assertion (§3.2 a).
// ---------------------------------------------------------------------------

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local          = require('../../src/attest_zero_conf_activation.js');
const localWidening  = require('../../src/attest_responsible_widening_activation.js');
const localMirror    = require('../../src/attest_response_mirror_activation.js');
const localGates     = require('../../src/rollcall_gates_activation.js');

// Sibling checkout, same resolution convention as ConsensusPrimitiveConformance:
// an explicit env path for CI (actions/checkout cannot write above the workspace),
// falling back to the dev sibling layout. Absent -> skip, unless CI demands it.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const DOCS_DIR = process.env.XCHAIN_DOCS_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-documentation');

const INDEXER_ZC       = path.join(INDEXER_DIR, 'src', 'attest_zero_conf_activation.js');
const INDEXER_WIDENING = path.join(INDEXER_DIR, 'src', 'attest_responsible_widening_activation.js');
const INDEXER_MIRROR   = path.join(INDEXER_DIR, 'src', 'attest_response_mirror_activation.js');
const INDEXER_GATES    = path.join(INDEXER_DIR, 'src', 'rollcall_gates_activation.js');
const CONSTANTS_PATH   = path.join(DOCS_DIR, 'protocol', 'constants.js');

describe('ATTEST zero-conf flip: hub copy value-identity @regression', function () {

    describe('value-identity with the xchain-indexer twins and the documentation canon', function () {
        let idx = null, canon = null;

        before(function () {
            const indexerReady = fs.existsSync(INDEXER_ZC) && fs.existsSync(INDEXER_WIDENING) &&
                fs.existsSync(INDEXER_MIRROR) && fs.existsSync(INDEXER_GATES);
            const canonReady = fs.existsSync(CONSTANTS_PATH);
            if (!indexerReady || !canonReady) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but a required sibling was not found ' +
                        '(indexer twins under ' + INDEXER_DIR + ', canon at ' + CONSTANTS_PATH + ')');
                this.skip();
                return;
            }
            idx = {
                zc:       require(INDEXER_ZC),
                widening: require(INDEXER_WIDENING),
                mirror:   require(INDEXER_MIRROR),
                gates:    require(INDEXER_GATES)
            };
            canon = require(CONSTANTS_PATH);
        });

        // Value-identity, not byte-identity (D32): unlike price_pair_activation these
        // three modules also carry a canon copy in xchain-documentation, and the gates
        // module's regtest entry is env-derived rather than a literal, so a byte compare
        // would fail on a harmless header offset. Every consumer of a divergent map
        // derives a different responsible set, ladder or callback binding block at the
        // flag-day, so VALUES are the property that actually has to hold.
        it('ATTEST_ZERO_CONF_ACTIVATION is value-identical across hub, indexer and canon', function () {
            expect(local.ATTEST_ZERO_CONF_ACTIVATION).to.deep.equal(idx.zc.ATTEST_ZERO_CONF_ACTIVATION);
            expect(local.ATTEST_ZERO_CONF_ACTIVATION).to.deep.equal(canon.ATTEST_ZERO_CONF_ACTIVATION);
        });

        it('ATTEST_RESPONSIBLE_WIDENING_V2 is value-identical across hub, indexer and canon', function () {
            expect(localWidening.ATTEST_RESPONSIBLE_WIDENING_V2).to.deep.equal(idx.widening.ATTEST_RESPONSIBLE_WIDENING_V2);
            expect(localWidening.ATTEST_RESPONSIBLE_WIDENING_V2).to.deep.equal(canon.ATTEST_RESPONSIBLE_WIDENING_V2);
        });

        it('ATTEST_RESPONSIBLE_WIDENING (stage 1) is value-identical across hub, indexer and canon', function () {
            expect(localWidening.ATTEST_RESPONSIBLE_WIDENING).to.deep.equal(idx.widening.ATTEST_RESPONSIBLE_WIDENING);
            expect(localWidening.ATTEST_RESPONSIBLE_WIDENING).to.deep.equal(canon.ATTEST_RESPONSIBLE_WIDENING);
        });

        it('ATTEST_RESPONSIBLE_WIDENING_ACTIVATION is value-identical across hub, indexer and canon', function () {
            expect(localWidening.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION).to.deep.equal(idx.widening.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION);
            expect(localWidening.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION).to.deep.equal(canon.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION);
        });

        it('ATTEST_RESPONSE_MIRROR_ACTIVATION is value-identical across hub, indexer and canon', function () {
            expect(localMirror.ATTEST_RESPONSE_MIRROR_ACTIVATION).to.deep.equal(idx.mirror.ATTEST_RESPONSE_MIRROR_ACTIVATION);
            expect(localMirror.ATTEST_RESPONSE_MIRROR_ACTIVATION).to.deep.equal(canon.ATTEST_RESPONSE_MIRROR_ACTIVATION);
        });

        // Mainnet and testnet only (D30, §8): regtest is env-derived (D64), so it is
        // NOT parity-tested and the module header says so. Comparing it here would make
        // the suite depend on every process sharing an env var, which is not the claim
        // any of the three copies makes.
        it('ROLLCALL_GATES_ACTIVATION.{mainnet,testnet} are value-identical across hub, indexer and canon', function () {
            for (const net of ['mainnet', 'testnet']) {
                expect(localGates.ROLLCALL_GATES_ACTIVATION[net], 'hub vs indexer, ' + net)
                    .to.equal(idx.gates.ROLLCALL_GATES_ACTIVATION[net]);
                expect(localGates.ROLLCALL_GATES_ACTIVATION[net], 'hub vs canon, ' + net)
                    .to.equal(canon.ROLLCALL_GATES_ACTIVATION[net]);
            }
        });
    });

    describe('the null sentinel reads inert', function () {
        it('mainnet is null (unratified), so nothing serves at 0 confirmations there yet', function () {
            expect(local.ATTEST_ZERO_CONF_ACTIVATION.mainnet).to.equal(null);
            expect(local.isZeroConfActive(0, 'mainnet')).to.equal(false);
            expect(local.isZeroConfActive(999999999, 'mainnet')).to.equal(false);
        });

        it('does not coerce null through >=: without the explicit test req >= null reads as req >= 0', function () {
            // The exact hazard the module's own header names: absent the guard, every
            // block of an unratified network would satisfy `req >= 0` and arm the flip
            // on mainnet, the inverse of what the sentinel means.
            expect(local.isZeroConfActive(0, 'mainnet')).to.equal(false);
        });

        it('reads an unknown network as inert rather than height 0', function () {
            expect(local.isZeroConfActive(0, 'not-a-network')).to.equal(false);
            expect(local.isZeroConfActive(0, undefined)).to.equal(false);
        });

        it('fails closed on an unusable request block', function () {
            expect(local.isZeroConfActive(NaN, 'regtest')).to.equal(false);
            expect(local.isZeroConfActive(undefined, 'regtest')).to.equal(false);
            expect(local.isZeroConfActive(null, 'regtest')).to.equal(false);
        });
    });

    describe('isZeroConfActive gates on the request block', function () {
        it('is armed on regtest from genesis', function () {
            expect(local.ATTEST_ZERO_CONF_ACTIVATION.regtest).to.equal(0);
            expect(local.isZeroConfActive(0, 'regtest')).to.equal(true);
            expect(local.isZeroConfActive(1000, 'regtest')).to.equal(true);
        });

        it('is inert on testnet until the operator sizes it (floor 151324, D17)', function () {
            expect(local.ATTEST_ZERO_CONF_ACTIVATION.testnet).to.equal(null);
            expect(local.isZeroConfActive(151324, 'testnet')).to.equal(false);
            expect(local.isZeroConfActive(999999999, 'testnet')).to.equal(false);
        });

        it('gates on the REQUEST block, exactly at the threshold, once armed', function () {
            const zc = Object.assign({}, local.ATTEST_ZERO_CONF_ACTIVATION);
            try {
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = 200000;
                expect(local.isZeroConfActive(199999, 'testnet')).to.equal(false);
                expect(local.isZeroConfActive(200000, 'testnet')).to.equal(true);
                expect(local.isZeroConfActive(200001, 'testnet')).to.equal(true);
            } finally {
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = zc.testnet;
            }
        });
    });

    // §3.2 a: the boot-time ordering assertion, on the CapabilitySnapshot
    // _resolveReorgBuffer pattern. assertZeroConfOrdering requires the mirror and
    // widening modules LAZILY (inside the function, to break a require cycle), so a
    // module-object mutation made before the call is what a lazy re-require would see:
    // require() returns the SAME cached module object on every call in this process.
    describe('assertZeroConfOrdering: the height ordering invariant (§3.2 a, D9)', function () {
        let warnSpy;
        beforeEach(function () { warnSpy = []; });

        function withPatchedWarn(fn) {
            const orig = console.warn;
            console.warn = (...args) => warnSpy.push(args.join(' '));
            try { fn(); } finally { console.warn = orig; }
        }

        it('is a no-op wherever ATTEST_ZERO_CONF_ACTIVATION is null (unratified there)', function () {
            expect(local.ATTEST_ZERO_CONF_ACTIVATION.mainnet).to.equal(null);
            expect(() => local.assertZeroConfOrdering('mainnet')).to.not.throw();
        });

        it('throws on mainnet or testnet when zero-conf is armed below max(mirror, widening)', function () {
            const orig = local.ATTEST_ZERO_CONF_ACTIVATION.testnet;
            try {
                // Real testnet today: widening 150780, mirror 151324, so max is 151324.
                // A synthetic zero-conf height below that is a genuine ordering violation.
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = 100000;
                expect(() => local.assertZeroConfOrdering('testnet')).to.throw(/ATTEST zero-conf/);
                try {
                    local.assertZeroConfOrdering('testnet');
                    expect.fail('expected assertZeroConfOrdering to throw');
                } catch (err) {
                    expect(err.code).to.equal('ZERO_CONF_ORDERING');
                }
            } finally {
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = orig;
            }
            // Restored byte-exact: the invariant holds again with the real heights.
            expect(() => local.assertZeroConfOrdering('testnet')).to.not.throw();
        });

        it('warns rather than throws on regtest for the identical violation shape', function () {
            const orig = local.ATTEST_ZERO_CONF_ACTIVATION.regtest;
            try {
                // Real regtest today: mirror 0, widening 0, so max is 0; -1 is strictly
                // below it and is therefore a genuine (if synthetic) violation.
                local.ATTEST_ZERO_CONF_ACTIVATION.regtest = -1;
                withPatchedWarn(() => {
                    expect(() => local.assertZeroConfOrdering('regtest')).to.not.throw();
                });
                expect(warnSpy.join('\n')).to.match(/ordering violation \(non-strict on regtest\)/);
            } finally {
                local.ATTEST_ZERO_CONF_ACTIVATION.regtest = orig;
            }
            // Restored byte-exact: no NEW warning on the real regtest heights.
            warnSpy.length = 0;
            withPatchedWarn(() => local.assertZeroConfOrdering('regtest'));
            expect(warnSpy).to.deep.equal([]);
        });

        it('throws when the mirror height is unratified but zero-conf is armed', function () {
            const zc = local.ATTEST_ZERO_CONF_ACTIVATION.testnet;
            const mirror = localMirror.ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet;
            try {
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = 200000;
                localMirror.ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet = null;
                expect(() => local.assertZeroConfOrdering('testnet')).to.throw(/unratified/);
            } finally {
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = zc;
                localMirror.ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet = mirror;
            }
        });

        it('throws when the widening height is unratified but zero-conf is armed', function () {
            const zc = local.ATTEST_ZERO_CONF_ACTIVATION.testnet;
            const widening = localWidening.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet;
            try {
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = 200000;
                localWidening.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet = null;
                expect(() => local.assertZeroConfOrdering('testnet')).to.throw(/widenSlots returns 0/);
            } finally {
                local.ATTEST_ZERO_CONF_ACTIVATION.testnet = zc;
                localWidening.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet = widening;
            }
        });
    });
});
