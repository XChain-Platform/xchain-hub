'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// bin/oracle-round-presence.js, the fleet divergence checker. The lib, the RPC leg
// and XChainHub.getOracleRoundPresence each have their own suite; the one thing
// only this script owns is the orchestration: resolve the round range ONCE, from a
// hub that actually has one, and pin it for every other hub. That was untested, and
// an unconditional `break` on the first hub that merely REPLIED shipped because of
// it: an empty hub answers successfully with a null range, so a freshly resynced
// hub listed first aborted the whole check with exit 2 and nothing was compared.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { presenceDigest } = require('../../src/lib/oracle_round_presence.js');

const HUB_A = 'http://hub-a:4000';
const HUB_B = 'http://hub-b:4000';

// A populated answer over [from, to]; `statuses` overrides individual rounds.
function presence(from, to, statuses) {
    const rounds = [];
    for (let r = from; r <= to; r++) {
        rounds.push({ round: r, status: (statuses && statuses[r]) || 'finalized' });
    }
    return {
        from_round: from,
        to_round: to,
        rounds: rounds,
        missing: rounds.filter(r => r.status === 'missing').map(r => r.round),
        digest: presenceDigest(rounds)
    };
}

// What a hub with no price_snapshots rows returns: a successful RPC result, not an
// error. This is the shape the anchor loop must skip rather than adopt.
function emptyPresence() {
    return { from_round: null, to_round: null, rounds: [], missing: [], digest: null };
}

// Loads the CLI with axios replaced. `answers` maps hub URL to a function of the
// request params returning a presence object, or throwing to simulate an outage.
function loadCli(answers) {
    const post = sinon.stub().callsFake(async (url, body) => {
        const responder = answers[url];
        if (!responder) throw new Error('connect ECONNREFUSED ' + url);
        return { data: { result: responder(body && body.params) } };
    });
    const cli = proxyquire('../../bin/oracle-round-presence.js', { axios: { post: post } });
    return { cli: cli, post: post };
}

function paramsOf(call) {
    return call.args[1].params;
}

{
    let logs;
    let registerparseargs2;
    {
        function readsHubsFromHubsTrimmingAndTest4() {
            const { cli } = loadCli({});
            const opts = cli.parseArgs(['node', 'cli', '--hubs', ' http://a , ,http://b '], {});
            expect(opts.hubs).to.deep.equal(['http://a', 'http://b']);
            expect(opts.from).to.equal(null);
            expect(opts.to).to.equal(null);
            expect(opts.json).to.equal(false);
        }

        function fallsBackToHubRpcUrlsTest5() {
            const { cli } = loadCli({});
            const opts = cli.parseArgs(['node', 'cli'], { HUB_RPC_URLS: 'http://a,http://b' });
            expect(opts.hubs).to.deep.equal(['http://a', 'http://b']);
        }

        function parseargsSuite3() {
            it('reads hubs from --hubs, trimming and dropping empty segments', readsHubsFromHubsTrimmingAndTest4);
            it('falls back to HUB_RPC_URLS when --hubs is absent', fallsBackToHubRpcUrlsTest5);
        }

        registerparseargs2 = function registerSuite() {
            describe('parseArgs()', parseargsSuite3);
        };

    }

    let registerusablerange6;

    {

        function rejectsTheEmptyDbAnswerWhichTest8() {
            const { cli } = loadCli({});
            expect(cli.usableRange(emptyPresence())).to.equal(false);
        }

        function rejectsAHalfNullRangeWhichTest9() {
            const { cli } = loadCli({});
            expect(cli.usableRange({ from_round: 25, to_round: null })).to.equal(false);
        }

        function acceptsAnAnswerCarryingBothBoundsTest10() {
            const { cli } = loadCli({});
            expect(cli.usableRange(presence(25, 27))).to.equal(true);
        }

        function usablerangeSuite7() {
            it('rejects the empty-DB answer, which is a successful response with no range', rejectsTheEmptyDbAnswerWhichTest8);
            it('rejects a half-null range, which would pin to_round: null on every hub', rejectsAHalfNullRangeWhichTest9);
            it('accepts an answer carrying both bounds', acceptsAnAnswerCarryingBothBoundsTest10);
        }

        registerusablerange6 = function registerSuite() {
            describe('usableRange()', usablerangeSuite7);
        };

    }

    let registeranchorResolution11;

    {

        // This regression starts with empty Hub A listed first. Its null range cannot
        // end discovery: the probe must continue, ask Hub B, and use Hub B's available
        // bounds instead of exiting with nothing compared.
        async function skipsAHubThatAnswersWithTest13() {
            const { cli, post } = loadCli({
                [HUB_A]: () => emptyPresence(),
                [HUB_B]: () => presence(25, 27)
            });

            const code = await cli.main(cli.parseArgs(['node', 'cli', '--hubs', HUB_A + ',' + HUB_B], {}));

            // Hub A holds none of rounds 25-27 that hub B holds: that is a real
            // divergence (exit 1), and it is exactly the incident this tool exists
            // to name. What must NOT happen is exit 2 with nothing compared.
            expect(code).to.equal(1);
            expect(logs.join('\n')).to.contain('DIVERGENT on 3 round(s)');

            // Two anchor probes, then one pinned ask per hub, hub A included.
            expect(post.callCount).to.equal(4);
            expect(paramsOf(post.getCall(2))).to.deep.equal({ from_round: 25, to_round: 27 });
            expect(paramsOf(post.getCall(3))).to.deep.equal({ from_round: 25, to_round: 27 });
        }

        async function stopsProbingAsSoonAsOneTest14() {
            const HUB_C = 'http://hub-c:4000';
            const { cli, post } = loadCli({
                [HUB_A]: () => presence(10, 12),
                [HUB_B]: () => presence(10, 12),
                [HUB_C]: () => presence(10, 12)
            });

            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', [HUB_A, HUB_B, HUB_C].join(',')], {}));

            expect(code).to.equal(0);
            // One probe (hub A answered usably), then three pinned asks.
            expect(post.callCount).to.equal(4);
            expect(post.getCall(0).args[0]).to.equal(HUB_A);
        }

        async function givesUpWithExit2OnlyTest15() {
            const { cli } = loadCli({
                [HUB_A]: () => emptyPresence(),
                [HUB_B]: () => emptyPresence()
            });

            const code = await cli.main(cli.parseArgs(['node', 'cli', '--hubs', HUB_A + ',' + HUB_B], {}));

            expect(code).to.equal(2);
            expect(logs.join('\n')).to.contain('No hub returned a usable round range (2 answered empty, 0 unreachable)');
        }

        async function countsAnUnreachableHubSeparatelyFromTest16() {
            const { cli } = loadCli({ [HUB_B]: () => emptyPresence() });   // hub A refuses

            const code = await cli.main(cli.parseArgs(['node', 'cli', '--hubs', HUB_A + ',' + HUB_B], {}));

            expect(code).to.equal(2);
            expect(logs.join('\n')).to.contain('(1 answered empty, 1 unreachable)');
            expect(logs.join('\n')).to.contain(HUB_A + ' did not answer');
        }

        function anchorResolutionSuite12() {
            it('skips a hub that answers with a null range and pins the next hub that has one', skipsAHubThatAnswersWithTest13);
            it('stops probing as soon as one hub reports a usable range', stopsProbingAsSoonAsOneTest14);
            it('gives up with exit 2 only when no hub has a range, and says why', givesUpWithExit2OnlyTest15);
            it('counts an unreachable hub separately from an empty one', countsAnUnreachableHubSeparatelyFromTest16);
        }

        registeranchorResolution11 = function registerSuite() {
            describe('anchor resolution', anchorResolutionSuite12);
        };

    }

    let registerexplicitBounds17;

    {

        async function honoursFromToVerbatimAndIssuesTest19() {
            const { cli, post } = loadCli({
                [HUB_A]: () => presence(25, 27),
                [HUB_B]: () => presence(25, 27)
            });

            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', HUB_A + ',' + HUB_B, '--from', '25', '--to', '27'], {}));

            expect(code).to.equal(0);
            expect(post.callCount).to.equal(2);
            expect(paramsOf(post.getCall(0))).to.deep.equal({ from_round: 25, to_round: 27 });
            expect(paramsOf(post.getCall(1))).to.deep.equal({ from_round: 25, to_round: 27 });
        }

        // An unvalidated bound is worse than a rejected one: Number('oops') is NaN and
        // JSON.stringify writes NaN as null, so every hub silently resolves its OWN
        // upper bound and the run still prints an agreed/divergent verdict over
        // ranges that never match. The pinned range is the whole point of the tool.
        async function rejectsAnInvalidExplicitBoundWithTest20() {
            for (const argv of [['--from', '25', '--to', 'oops'],
                                ['--from', 'oops', '--to', '27'],
                                ['--from', '-1', '--to', '27'],
                                ['--from', '2.5', '--to', '27'],
                                ['--limit', '0'],
                                ['--from', '27', '--to', '25']]) {
                const { cli, post } = loadCli({
                    [HUB_A]: () => presence(25, 27),
                    [HUB_B]: () => presence(25, 27)
                });
                const code = await cli.main(cli.parseArgs(
                    ['node', 'cli', '--hubs', HUB_A + ',' + HUB_B].concat(argv), {}));
                expect(code, argv.join(' ')).to.equal(2);
                expect(post.callCount, argv.join(' ')).to.equal(0);
            }
        }

        function explicitBoundsSuite18() {
            it('honours --from/--to verbatim and issues no anchor probe', honoursFromToVerbatimAndIssuesTest19);
            it('rejects an invalid explicit bound with exit 2, before any request', rejectsAnInvalidExplicitBoundWithTest20);
        }

        registerexplicitBounds17 = function registerSuite() {
            describe('explicit bounds', explicitBoundsSuite18);
        };

    }

    let registerdistinctHubIdentities21;

    {

        async function collapsesARepeatedUrlSoTheTest23() {
            // Comparing a hub to itself proves nothing, which the file's own usage
            // text says; counting URL ENTRIES let `--hubs A,A` clear the gate, compare
            // that endpoint to itself and print agreement with exit 0.
            const { cli, post } = loadCli({ [HUB_A]: () => presence(25, 27) });
            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', HUB_A + ',' + HUB_A + '/'], {}));
            expect(code).to.equal(2);
            expect(post.callCount).to.equal(0);
            expect(logs.join('\n')).to.contain('DISTINCT');
        }

        async function countsAMalformedAnswerAsNotTest24() {
            // Two hubs answer, one without a rounds array. A gate that counted raw
            // replies while comparePresence re-filtered would leave ONE view to be
            // reported as federation agreement with exit 0.
            const { cli } = loadCli({
                [HUB_A]: () => presence(25, 27),
                [HUB_B]: () => ({ from_round: 25, to_round: 27, digest: 'x' })
            });
            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', HUB_A + ',' + HUB_B, '--from', '25', '--to', '27'], {}));
            expect(code).to.equal(2);
            expect(logs.join('\n')).to.contain('need at least two to compare');
        }

        function distinctHubIdentitiesSuite22() {
            it('collapses a repeated URL so the two-hub gate bites before any request', collapsesARepeatedUrlSoTheTest23);
            it('counts a malformed answer as not-compared rather than as agreement', countsAMalformedAnswerAsNotTest24);
        }

        registerdistinctHubIdentities21 = function registerSuite() {
            describe('distinct hub identities', distinctHubIdentitiesSuite22);
        };

    }

    let registerexitCodes25;

    {

        async function returns0WhenEveryHubReportsTest27() {
            const { cli } = loadCli({
                [HUB_A]: () => presence(25, 27),
                [HUB_B]: () => presence(25, 27)
            });
            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', HUB_A + ',' + HUB_B, '--from', '25', '--to', '27'], {}));
            expect(code).to.equal(0);
        }

        async function returns1WhenTheHubsDisagreeTest28() {
            const { cli } = loadCli({
                [HUB_A]: () => presence(25, 27),
                [HUB_B]: () => presence(25, 27, { 26: 'missing' })
            });
            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', HUB_A + ',' + HUB_B, '--from', '25', '--to', '27'], {}));
            expect(code).to.equal(1);
            expect(logs.join('\n')).to.contain('round 26');
        }

        async function returns2BeforeAnyNetworkCallTest29() {
            const { cli, post } = loadCli({ [HUB_A]: () => presence(25, 27) });
            const code = await cli.main(cli.parseArgs(['node', 'cli', '--hubs', HUB_A], {}));
            expect(code).to.equal(2);
            expect(post.callCount).to.equal(0);
        }

        async function returns2WhenOnlyOneOfTest30() {
            const { cli } = loadCli({ [HUB_A]: () => presence(25, 27) });   // hub B refuses
            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', HUB_A + ',' + HUB_B, '--from', '25', '--to', '27'], {}));
            expect(code).to.equal(2);
            expect(logs.join('\n')).to.contain('need at least two to compare');
        }

        function exitCodesSuite26() {
            it('returns 0 when every hub reports the same outcome for every round', returns0WhenEveryHubReportsTest27);
            it('returns 1 when the hubs disagree about a round', returns1WhenTheHubsDisagreeTest28);
            it('returns 2 before any network call when fewer than two hubs are named', returns2BeforeAnyNetworkCallTest29);
            it('returns 2 when only one of the named hubs can be reached', returns2WhenOnlyOneOfTest30);
        }

        registerexitCodes25 = function registerSuite() {
            describe('exit codes', exitCodesSuite26);
        };

    }

    let registerjson31;

    {

        async function printsThePinnedRangeAndPerTest33() {
            const { cli } = loadCli({
                [HUB_A]: () => emptyPresence(),
                [HUB_B]: () => presence(25, 27)
            });

            const code = await cli.main(cli.parseArgs(
                ['node', 'cli', '--hubs', HUB_A + ',' + HUB_B, '--json'], {}));

            expect(code).to.equal(1);
            const payload = JSON.parse(logs.filter(l => l.trim().startsWith('{')).pop());
            expect(payload.range).to.deep.equal({ from_round: 25, to_round: 27 });
            expect(payload.digests.map(d => d.hub)).to.deep.equal([HUB_A, HUB_B]);
        }

        function jsonSuite32() {
            it('prints the pinned range and per-hub digests, and still returns the outcome code', printsThePinnedRangeAndPerTest33);
        }

        registerjson31 = function registerSuite() {
            describe('--json', jsonSuite32);
        };

    }

    function binOracleRoundPresenceJsRangeSuite1() {
        beforeEach(function () {
            logs = [];
            sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
            sinon.stub(console, 'error').callsFake(m => logs.push(String(m)));
        });
        afterEach(function () {
            sinon.restore();
        });
        registerparseargs2();
        registerusablerange6();
        registeranchorResolution11();
        registerexplicitBounds17();
        registerdistinctHubIdentities21();
        registerexitCodes25();
        registerjson31();
    }

    describe('bin/oracle-round-presence.js: range pinning across hubs', binOracleRoundPresenceJsRangeSuite1);

}
