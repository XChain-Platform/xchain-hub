'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// The pair-count advisory of the round presence check: a hub that stored a round with fewer finalized
// pairs than another still agrees on the round's status, so the advisory names it without moving the
// digest, the verdict or the exit code.

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { presenceDigest, comparePresence, comparePairCounts } =
    require('../../../../../src/lib/oracle_round_presence.js');

const HUB_A = 'http://hub-a:4000';
const HUB_B = 'http://hub-b:4000';

// One answer over rounds 1..3 whose pair counts come from `counts` (round to finalized pairs).
function answer(counts, statuses) {
    const rounds = [1, 2, 3].map(round => ({
        round, status: (statuses && statuses[round]) || 'finalized',
        finalized_pairs: counts[round] === undefined ? 0 : counts[round]
    }));
    return { from_round: 1, to_round: 3, rounds, missing: [], digest: presenceDigest(rounds) };
}

function loadCli(answers) {
    const post = sinon.stub().callsFake(async url => ({ data: { result: answers[url] } }));
    return proxyquire('../../../../../bin/oracle-round-presence.js', { axios: { post } });
}

describe('round presence pair-count advisory', function () {
    let logs;
    beforeEach(function () {
        logs = [];
        sinon.stub(console, 'log').callsFake(line => logs.push(String(line)));
        sinon.stub(console, 'error');
    });
    afterEach(function () { sinon.restore(); });

    it('names a round that two hubs both finalized with different pair counts', function () {
        const answers = [{ hub: HUB_A, presence: answer({ 1: 36, 2: 36, 3: 36 }) },
            { hub: HUB_B, presence: answer({ 1: 36, 2: 35, 3: 36 }) }];
        expect(comparePairCounts(answers)).to.deep.equal([
            { round: 2, finalized_pairs: { [HUB_A]: 36, [HUB_B]: 35 } }]);
        expect(comparePresence(answers).agreed).to.equal(true);
    });

    it('compares only hubs that finalized the round and stays empty when counts match', function () {
        const matching = [{ hub: HUB_A, presence: answer({ 1: 4, 2: 4, 3: 4 }) },
            { hub: HUB_B, presence: answer({ 1: 4, 2: 4, 3: 4 }) }];
        expect(comparePairCounts(matching)).to.deep.equal([]);
        const oneSkipped = [{ hub: HUB_A, presence: answer({ 1: 4, 2: 4, 3: 4 }) },
            { hub: HUB_B, presence: answer({ 1: 4, 2: 0, 3: 4 }, { 2: 'skipped' }) }];
        expect(comparePairCounts(oneSkipped)).to.deep.equal([]);
        expect(comparePairCounts([{ hub: HUB_A, presence: answer({ 1: 4 }) }])).to.deep.equal([]);
        expect(comparePairCounts(undefined)).to.deep.equal([]);
    });

    it('prints the advisory beside an agreed verdict and keeps the exit code at zero', async function () {
        const cli = loadCli({ [HUB_A]: answer({ 1: 36, 2: 36, 3: 36 }), [HUB_B]: answer({ 1: 36, 2: 35, 3: 36 }) });
        const code = await cli.main({ hubs: [HUB_A, HUB_B], from: 1, to: 3, limit: null, json: false });
        expect(code).to.equal(0);
        const out = logs.join('\n');
        expect(out).to.contain('Agreed');
        expect(out).to.contain('Pair counts differ on 1 round(s)');
        expect(out).to.contain('round 2: ' + HUB_A + '=36  ' + HUB_B + '=35');
    });

    it('carries the advisory in the json report without changing the comparison', async function () {
        const cli = loadCli({ [HUB_A]: answer({ 1: 36, 2: 36, 3: 36 }), [HUB_B]: answer({ 1: 36, 2: 35, 3: 36 }) });
        const code = await cli.main({ hubs: [HUB_A, HUB_B], from: 1, to: 3, limit: null, json: true });
        const report = JSON.parse(logs.join('\n'));
        expect(code).to.equal(0);
        expect(report.comparison).to.deep.equal({ agreed: true, divergent: [], hubs: 2 });
        expect(report.pairAdvisory).to.deep.equal([{ round: 2, finalized_pairs: { [HUB_A]: 36, [HUB_B]: 35 } }]);
    });

    it('prints no advisory line when every finalized round has the same pair count', async function () {
        const same = answer({ 1: 36, 2: 36, 3: 36 });
        const cli = loadCli({ [HUB_A]: same, [HUB_B]: same });
        expect(await cli.main({ hubs: [HUB_A, HUB_B], from: 1, to: 3, limit: null, json: false })).to.equal(0);
        expect(logs.join('\n')).to.not.contain('Pair counts differ');
    });
});
