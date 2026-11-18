'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { presenceDigest } = require('../../../../../src/lib/oracle_round_presence.js');

const HUB_A = 'http://hub-a:4000';
const HUB_B = 'http://hub-b:4000';
const HUB_C = 'http://hub-c:4000';

function presence(from, to) {
    const rounds = [];
    for (let round = from; round <= to; round++) rounds.push({ round, status: 'finalized' });
    return { from_round: from, to_round: to, rounds, missing: [], digest: presenceDigest(rounds) };
}

function loadCli(responders) {
    const post = sinon.stub().callsFake(async (url, body) => ({ data: { result: responders[url](body.params) } }));
    const cli = proxyquire('../../../../../bin/oracle-round-presence.js', { axios: { post } });
    return { cli, post };
}

function opts(cli, extra, hubs) {
    return cli.parseArgs(['node', 'cli', '--hubs', (hubs || [HUB_A, HUB_B]).join(',')].concat(extra), {});
}

describe('oracle round presence CLI range coverage guard', function () {
    let logs;
    beforeEach(function () {
        logs = [];
        sinon.stub(console, 'log').callsFake(line => logs.push(String(line)));
        sinon.stub(console, 'error').callsFake(line => logs.push(String(line)));
    });
    afterEach(function () { sinon.restore(); });

    it('refuses an explicit span above MAX_RANGE before any request', async function () {
        const { cli, post } = loadCli({});
        expect(await cli.main(opts(cli, ['--from', '0', '--to', '1000']))).to.equal(2);
        expect(post.callCount).to.equal(0);
        expect(logs.join('\n')).to.match(/1000|MAX_RANGE/);
    });

    it('accepts an explicit span exactly MAX_RANGE wide', async function () {
        const responders = { [HUB_A]: p => presence(p.from_round, p.to_round),
            [HUB_B]: p => presence(p.from_round, p.to_round) };
        const { cli, post } = loadCli(responders);
        expect(await cli.main(opts(cli, ['--from', '0', '--to', '999']))).to.equal(0);
        expect(post.callCount).to.equal(2);
    });

    it('cannot compare when one of two hubs answers a narrower range', async function () {
        const { cli } = loadCli({ [HUB_A]: () => presence(25, 27), [HUB_B]: () => presence(25, 26) });
        expect(await cli.main(opts(cli, ['--from', '25', '--to', '27']))).to.equal(2);
        expect(logs.join('\n')).to.contain('need at least two to compare');
    });

    it('excludes and reports a narrower third answer in JSON', async function () {
        const responders = { [HUB_A]: () => presence(25, 27), [HUB_B]: () => presence(25, 27),
            [HUB_C]: () => presence(25, 26) };
        const { cli } = loadCli(responders);
        expect(await cli.main(opts(cli, ['--from', '25', '--to', '27', '--json'], [HUB_A, HUB_B, HUB_C])))
            .to.equal(0);
        const payload = JSON.parse(logs.find(line => line.startsWith('{')));
        expect(payload.unreachable).to.deep.equal([{ hub: HUB_C,
            error: 'answered rounds 25-26, not the pinned 25-27' }]);
    });
});
