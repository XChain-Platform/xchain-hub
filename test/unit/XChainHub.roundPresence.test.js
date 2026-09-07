'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// hub.getOracleRoundPresence resolves the round RANGE and hands it to
// the presence fold. The range resolution is where a comparison quietly stops
// comparing, so it is what these tests pin: an omitted to_round anchors on the
// hub's own highest recorded round (a fact about stored data, so a hub missing
// its newest rounds reports a lower to_round and that IS the signal), and the
// span is bounded so a health probe cannot turn into a table scan.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { MAX_RANGE } = require('../../src/lib/oracle_round_presence.js');

describe('XChainHub.getOracleRoundPresence', function () {

    let mockDb, XChainHub, hub;

    before(function () {
        this.timeout(30000);
        XChainHub = proxyquire('../../src/XChainHub', { './db': function () { return mockDb; } });
    });

    function rows(entries) {
        return entries.map(([round, status]) => ({
            round_number: round, coin_pair: 'BTC/USD', status: status,
            reference_block: 900 + round, block_timestamp: 1700000000 + round
        }));
    }

    // doQuery answers the MAX(round_number) probe and the range read separately.
    function seed(maxRound, snapshotRows) {
        mockDb.doQuery = sinon.stub();
        mockDb.doQuery.withArgs(sinon.match(/MAX\(round_number\)/)).resolves(
            [{ max_round: maxRound }]);
        mockDb.doQuery.withArgs(sinon.match(/BETWEEN/)).resolves(snapshotRows || []);
        return mockDb.doQuery;
    }

    beforeEach(function () {
        mockDb = { doQuery: sinon.stub().resolves([]), close: sinon.stub().resolves() };
        hub = new XChainHub('host', 3306, 'db', 'user', 'pass', { P2P_PORT: 10001 });
        hub.db = mockDb;
    });

    afterEach(function () { sinon.restore(); });

    it('reports a lost round as missing over an explicit range', function () {
        seed(27, rows([[25, 'finalized']]));
        return hub.getOracleRoundPresence(25, 27).then(res => {
            expect(res.from_round).to.equal(25);
            expect(res.to_round).to.equal(27);
            expect(res.missing).to.deep.equal([26, 27]);
            expect(res.rounds.map(r => r.status)).to.deep.equal(['finalized', 'missing', 'missing']);
            expect(res.digest).to.be.a('string');
        });
    });

    it('anchors an omitted to_round on the highest round this hub actually holds', async function () {
        // Not the current wall-clock round: a hub whose newest rounds are all
        // missing must report a LOWER to_round than its healthy peers.
        seed(27, rows([[27, 'skipped']]));
        let res = await hub.getOracleRoundPresence(undefined, undefined, 3);
        expect(res.to_round).to.equal(27);
        expect(res.from_round).to.equal(25);
    });

    it('returns an empty answer, not a fabricated range, when the table is empty', async function () {
        seed(null, []);
        let res = await hub.getOracleRoundPresence();
        expect(res).to.deep.equal({ from_round: null, to_round: null, rounds: [], missing: [], digest: null });
    });

    it('honours an explicit from_round and clamps the span to MAX_RANGE', async function () {
        let q = seed(999999, []);
        let res = await hub.getOracleRoundPresence(10, 10 + MAX_RANGE + 500);
        expect(res.from_round).to.equal(10);
        expect(res.to_round).to.equal(10 + MAX_RANGE - 1);
        expect(res.rounds.length).to.equal(MAX_RANGE);
        // The range read was bounded too, not just the answer.
        let rangeCall = q.getCalls().find(c => /BETWEEN/.test(c.args[0]));
        expect(rangeCall.args[1]).to.deep.equal([10, 10 + MAX_RANGE - 1]);
    });

    it('clamps an oversized limit and rejects a non-positive one back to the default', async function () {
        seed(5000, []);
        let big = await hub.getOracleRoundPresence(undefined, undefined, MAX_RANGE * 10);
        expect(big.to_round - big.from_round + 1).to.equal(MAX_RANGE);

        let zero = await hub.getOracleRoundPresence(undefined, undefined, 0);
        expect(zero.to_round - zero.from_round + 1).to.equal(50);
    });

    it('never runs off the bottom of the round space', async function () {
        seed(3, rows([[0, 'finalized']]));
        let res = await hub.getOracleRoundPresence(undefined, undefined, 50);
        expect(res.from_round).to.equal(0);
        expect(res.to_round).to.equal(3);
    });

    it('reads only the columns presence needs, not whole snapshot rows', async function () {
        let q = seed(10, []);
        await hub.getOracleRoundPresence(9, 10);
        let rangeCall = q.getCalls().find(c => /BETWEEN/.test(c.args[0]));
        expect(rangeCall.args[0]).to.not.match(/SELECT \*/);
        expect(rangeCall.args[0]).to.match(/round_number, coin_pair, status/);
    });
});
