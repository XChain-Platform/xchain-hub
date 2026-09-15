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
// Extra OracleRound tests covering branches not already exercised by
// the existing OracleRound.test.js:
//   - stop() clears all timers
//   - handleMessage: invalid round, late submission, duplicate sender,
//     max submissions, invalid prices, known validator pubkey → DB persist path
//   - scheduleFinalization: fallback-suppression branch
//   - pruneSubmissions: old round eviction
//   - persistSubmissions: null pubkey fallback

const sinon             = require('sinon');
const { expect }        = require('chai');
const proxyquire        = require('proxyquire');
const { createMockHub } = require('../../../helpers/mockHub');
const { pubkeyForTestSender } = require('../../../helpers/fixtures');



    let hub, pm, or, mockPriceFetcher, OracleRound;


        const fs   = require('fs');

        const path = require('path');


        // Brace-match the `const p2pConfig = P2P_VALIDATOR_ADDR ? { ... }` literal.
        function p2pConfigLiteral() {
            const src = fs.readFileSync(path.join(__dirname, '../../../../src/api.js'), 'utf8');
            const at  = src.indexOf('const p2pConfig = P2P_VALIDATOR_ADDR ? {');
            expect(at, 'p2pConfig literal not found in src/api.js').to.not.equal(-1);
            const open = src.indexOf('{', at);
            let depth = 0;
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
            }
            throw new Error('unbalanced p2pConfig literal in src/api.js');
        }

function registerOracleroundExtraCoverage1Hooks() {

    beforeEach(function () {
        mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };

        OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () { return mockPriceFetcher; }
        });

        hub = createMockHub({ p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' } });
        pm  = hub._peerManager;
        or  = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
        // Clean up any timers
        if (or.roundTimer)        { clearInterval(or.roundTimer); or.roundTimer = null; }
        if (or.initialRoundTimer) { clearTimeout(or.initialRoundTimer); or.initialRoundTimer = null; }
        if (or.boundaryTimer)     { clearTimeout(or.boundaryTimer); or.boundaryTimer = null; }
        if (or.finalizationTimers) { for (let t of or.finalizationTimers.values()) clearTimeout(t); or.finalizationTimers.clear(); }
    });
}

function registerOracleMaxSubmissionsPerRound2Tests1() {

        it('the key is present in the api.js p2pConfig literal', function () {
            expect(p2pConfigLiteral()).to.match(/\n\s*ORACLE_MAX_SUBMISSIONS_PER_ROUND\s*:/,
                'OracleRound reads this off hub.p2pConfig; absent from the literal it is permanently '
                + 'undefined and the per-round submission cap is un-tunable');
        });

        it('is passed through unparsed so the consumer owns the parse and the default', function () {
            const line = /ORACLE_MAX_SUBMISSIONS_PER_ROUND\s*:\s*([^\n,]+)/.exec(p2pConfigLiteral());
            expect(line, 'ORACLE_MAX_SUBMISSIONS_PER_ROUND not wired').to.not.equal(null);
            expect(line[1].trim()).to.equal('hubConfig.ORACLE_MAX_SUBMISSIONS_PER_ROUND',
                'a parseInt(...) || 200 tidy-up here forks the default into two files and lets the '
                + 'api.js copy eat values (0, negatives) that OracleRound.js handles deliberately');
        });

        it('an operator-supplied cap reaches the ingest guard', function () {
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_MAX_SUBMISSIONS_PER_ROUND: '25' }
            }));
            expect(fresh.maxSubmissionsPerRound).to.equal(25);
        });

        it('an explicit 0 falls back to the default rather than stalling the round', function () {
            // 0 is not a "disable" here (contrast the retention knob): the cap gates
            // ingest, so honouring 0 would drop every peer submission silently.
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_MAX_SUBMISSIONS_PER_ROUND: '0' }
            }));
            expect(fresh.maxSubmissionsPerRound).to.equal(200);
        });

        it('garbage, negative and absent values fall back to the default', function () {
            for (const bad of ['nonsense', '-5', '', undefined]) {
                const fresh = new OracleRound(createMockHub({
                    p2pConfig: { ORACLE_MAX_SUBMISSIONS_PER_ROUND: bad }
                }));
                expect(fresh.maxSubmissionsPerRound, 'value ' + JSON.stringify(bad)).to.equal(200);
            }
        });

}

describe('OracleRound (extra coverage)', function () {
    registerOracleroundExtraCoverage1Hooks();



    // ── ORACLE_MAX_SUBMISSIONS_PER_ROUND is actually reachable ─
    //
    // Same dead-knob mechanism as ORACLE_SUBMISSIONS_RETENTION_ROUNDS above: the key
    // was missing from the api.js p2pConfig literal, so this.config.ORACLE_MAX_
    // SUBMISSIONS_PER_ROUND was undefined on every deployment and the 200 default
    // won no matter what the operator exported. The consumer-side assertions passed
    // even then, so the source-side shape check is the half that matters.
    describe('ORACLE_MAX_SUBMISSIONS_PER_ROUND wiring', function () {
        registerOracleMaxSubmissionsPerRound2Tests1();
    });
});
