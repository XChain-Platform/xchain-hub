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

// Every hub derives a proposal's voting_end and activation floor from the voting period
// and assumes its peers derived the same one, so a local env override may move it on
// regtest only.

const { expect } = require('chai');
const { resolveGovVotingPeriod, DEFAULT_GOV_VOTING_PERIOD_MS } =
    require('../../../../src/validators/governance/voting_period.js');

const WEEK = 604800000;

function run(network, raw) {
    const warnings = [];
    const value = resolveGovVotingPeriod({ HUB_NETWORK: network, GOV_VOTING_PERIOD: raw }, (s) => warnings.push(s));
    return { value, warnings };
}

describe('governance voting period resolution', function () {
    it('defaults to seven days', function () {
        expect(DEFAULT_GOV_VOTING_PERIOD_MS).to.equal(WEEK);
        expect(run('mainnet', undefined).value).to.equal(WEEK);
    });

    it('ignores a differing override off regtest and warns once', function () {
        for (const net of ['mainnet', 'testnet', '']) {
            const r = run(net, '1000');
            expect(r.value, net).to.equal(WEEK);
            expect(r.warnings, net).to.have.length(1);
            expect(r.warnings[0]).to.include('GOV_VOTING_PERIOD=1000');
        }
    });

    it('stays silent off regtest when the override is absent or equals the canonical value', function () {
        for (const raw of [undefined, null, '', String(WEEK)]) {
            const r = run('testnet', raw);
            expect(r.value).to.equal(WEEK);
            expect(r.warnings).to.have.length(0);
        }
    });

    it('honours a positive override on regtest', function () {
        const r = run('regtest', '5000');
        expect(r.value).to.equal(5000);
        expect(r.warnings).to.have.length(0);
    });

    it('rejects a negative or unparseable regtest override', function () {
        for (const raw of ['-1', '0', 'abc']) expect(run('regtest', raw).value, raw).to.equal(WEEK);
    });
});
