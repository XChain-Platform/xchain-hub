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
const ProviderRegistry   = require('../../../src/validators/provider_registry');
const { DB_METHODS } = require('../../helpers/mockHub.js');


function makeHub(overrides) {
    let net = overrides && overrides.network !== undefined ? overrides.network : 'mainnet';
    return {
        p2pConfig: net ? { HUB_NETWORK: net } : null,
        network:   net,
        db:        overrides && overrides.db ? overrides.db : {
            getConfigRowsByModule: sinon.stub().resolves([])
        }
    };
}

function row(paramName, value, coin) {
    return { coin: coin || 'Bitcoin', param_name: paramName, param_value: value };
}


function installSuiteHooks1() {
    afterEach(function () {
            sinon.restore();
        });
}

const fs   = require('fs');

const path = require('path');

const REPO_ROOT = (function () {
            let dir = __dirname;
            while (!fs.existsSync(path.join(dir, 'package.json'))) {
                const up = path.dirname(dir);
                if (up === dir) throw new Error('no package.json above ' + __dirname);
                dir = up;
            }
            return dir;
        })();

const MIRROR = path.join(path.dirname(REPO_ROOT),
            'xchain-indexer', 'src', 'attestation', 'providerRegistry.js');

// ── cross-repo genesis-floor parity ─────────────────────────────
// min_stake_xchain became consensus input when the responsible-set derivation
// started dropping below-floor sources at/above STAKE_WEIGHTED_QUORUM. The
// indexer resolves the same value from its OWN shipped copy
// (xchain-indexer/src/attestation/providerRegistry.js PROVIDERS), because it
// mirrors no hub governance table and cannot read this one. Two copies of a
// consensus number need a guard tying them together, or a well-meant edit to
// one silently splits the responsible set.
//
// Anchored here because the hub DECLARES the value (governance loads into this
// registry) and the indexer mirrors it; same direction as the oracle-band and
// xcall-constant cross-repo gates. Sibling policy matches them too: a missing
// checkout skips, and XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip.
describe('ProviderRegistry', function () {
    installSuiteHooks1();
describe('provider stake floors agree with the indexer mirror', function () {
it('the indexer ships the identical genesis floor for every provider', function () {
            if (!fs.existsSync(MIRROR)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('provider stake-floor parity gate cannot run: xchain-indexer ' +
                        'providerRegistry.js missing at ' + MIRROR +
                        '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
                this.skip();
                return;
            }
            // Fresh read: a module cached by an earlier suite would hide an on-disk edit.
            const resolved = require.resolve(MIRROR);
            delete require.cache[resolved];
            const theirs = require(resolved).PROVIDERS;

            const ours = ProviderRegistry.DEFAULTS;
            expect(Object.keys(theirs).sort(), 'the two repos disagree on which providers exist')
                .to.deep.equal(Object.keys(ours).sort());
            for (const id of Object.keys(ours)) {
                expect(ProviderRegistry.normalizeMinStakeXchain(theirs[id].min_stake_xchain),
                    'indexer min_stake_xchain for "' + id + '" drifted from the hub genesis value; ' +
                    'a responsible-set fork, not a cosmetic difference')
                    .to.equal(ProviderRegistry.normalizeMinStakeXchain(ours[id].min_stake_xchain));
            }
        });
it('every shipped provider actually declares a floor', function () {
            // A provider with no floor resolves null, which every consensus caller
            // fails closed on: it would make that provider unservable at/above the gate.
            for (const [id, def] of Object.entries(ProviderRegistry.DEFAULTS))
                expect(ProviderRegistry.normalizeMinStakeXchain(def.min_stake_xchain),
                    'provider "' + id + '" ships no usable min_stake_xchain').to.not.be.null;
        });
});
});
