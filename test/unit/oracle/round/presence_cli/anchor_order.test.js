'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { presenceDigest } = require('../../../../../src/lib/oracle_round_presence.js');

const FIRST = 'http://127.0.0.1:4001';
const SECOND = 'http://127.0.0.1:4002';

function presence(from, to, lo, hi) {
    const rounds = [];
    for (let round = from; round <= to; round++) {
        rounds.push({ round, status: round >= lo && round <= hi ? 'finalized' : 'missing' });
    }
    return {
        from_round: from,
        to_round: to,
        rounds,
        missing: rounds.filter((item) => item.status === 'missing').map((item) => item.round),
        digest: presenceDigest(rounds),
    };
}

function responder(lo, hi) {
    return (params) =>
        params.to_round == null
            ? presence(params.from_round == null ? lo : params.from_round, hi, lo, hi)
            : presence(params.from_round, params.to_round, lo, hi);
}

function loadCli() {
    const answers = { [FIRST]: responder(10, 12), [SECOND]: responder(10, 15) };
    const post = sinon.stub().callsFake(async (url, body) => ({
        data: { result: answers[url](body.params) },
    }));
    const cli = proxyquire('../../../../../bin/oracle-round-presence.js', { axios: { post } });
    return { cli, post };
}

function requestParams(call) {
    return call.args[1].params;
}

describe('oracle round presence anchor order', function () {
    let logs;

    beforeEach(function () {
        logs = [];
        sinon.stub(console, 'log').callsFake((line) => logs.push(String(line)));
        sinon.stub(console, 'error').callsFake((line) => logs.push(String(line)));
    });

    afterEach(function () {
        sinon.restore();
    });

    it('pins the highest anchor and reports the same divergence in either order', async function () {
        for (const hubs of [
            [FIRST, SECOND],
            [SECOND, FIRST],
        ]) {
            const { cli, post } = loadCli();
            const code = await cli.main(cli.parseArgs(['node', 'cli', '--hubs', hubs.join(',')], {}));
            expect(code).to.equal(1);
            expect(logs.join('\n')).to.contain('DIVERGENT on 3 round(s)');
            expect(logs.join('\n')).to.contain('hubs report different newest rounds');
            expect(requestParams(post.getCall(2))).to.deep.equal({ from_round: 10, to_round: 15 });
            expect(requestParams(post.getCall(3))).to.deep.equal({ from_round: 10, to_round: 15 });
            logs.length = 0;
            sinon.restore();
            sinon.stub(console, 'log').callsFake((line) => logs.push(String(line)));
            sinon.stub(console, 'error').callsFake((line) => logs.push(String(line)));
        }
    });

    it('pins the highest anchor when only the lower bound is explicit', async function () {
        for (const hubs of [
            [FIRST, SECOND],
            [SECOND, FIRST],
        ]) {
            const { cli, post } = loadCli();
            const argv = ['node', 'cli', '--hubs', hubs.join(','), '--from', '10'];
            expect(await cli.main(cli.parseArgs(argv, {}))).to.equal(1);
            expect(requestParams(post.getCall(2))).to.deep.equal({ from_round: 10, to_round: 15 });
        }
    });

    it('includes every probed anchor in json output', async function () {
        const { cli } = loadCli();
        const argv = ['node', 'cli', '--hubs', FIRST + ',' + SECOND, '--json'];
        expect(await cli.main(cli.parseArgs(argv, {}))).to.equal(1);
        const payload = JSON.parse(logs.find((line) => line.trim().startsWith('{')));
        expect(payload.range).to.deep.equal({ from_round: 10, to_round: 15 });
        expect(payload.anchors).to.deep.equal([
            { hub: FIRST, from_round: 10, to_round: 12 },
            { hub: SECOND, from_round: 10, to_round: 15 },
        ]);
    });
});
