'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const sinon = require('sinon');
const { expect } = require('chai');
const OracleConsensus = require('../../../../src/oracle/consensus');
const { createMockHub } = require('../../../helpers/mockHub');

function build() {
    const hub = createMockHub();
    const oracleRound = {
        canonicalPairs: new Set(['BTC/USD', 'LTC/USD']),
        getSubmissions: sinon.stub().returns(new Map())
    };
    return { hub, consensus: new OracleConsensus(hub, oracleRound) };
}

function expectIndexedLatestLookup(call, pairs, belowRound) {
    const [sql, args] = call.args;
    const flat = sql.replace(/\s+/g, ' ').trim();
    expect((flat.match(/FROM price_snapshots FORCE INDEX \(idx_status_pair_round\)/g) || []))
        .to.have.length(pairs.length);
    for (const pair of pairs) {
        expect(flat).to.include("WHERE status = 'finalized' AND coin_pair = '" + pair + "' AND price IS NOT NULL");
    }
    expect((flat.match(/ORDER BY round_number DESC LIMIT 1/g) || [])).to.have.length(pairs.length);
    expect(flat).not.to.match(/\bGROUP BY\b|\bJOIN\b/i);
    expect(args).to.deep.equal(belowRound === undefined ? [] : pairs.map(() => belowRound));
    if (belowRound === undefined) expect(flat).not.to.include('round_number < ?');
    else expect(flat).to.include('round_number < ?');
}

describe('OracleConsensus last-finalized seed query', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('reads each canonical pair through the status-pair-round index without a full-table aggregate', async function () {
        const { hub, consensus } = build();
        hub.db.doQuery.resolves([
            { coin_pair: 'BTC/USD', price: '65000.00000000', round_number: 41 },
            { coin_pair: 'LTC/USD', price: '80.00000000', round_number: 41 }
        ]);

        await consensus.seedLastFinalizedPrices({ quiet: true });

        expect(hub.db.doQuery.calledOnce).to.equal(true);
        expectIndexedLatestLookup(hub.db.doQuery.firstCall, ['BTC/USD', 'LTC/USD']);
        expect(consensus.getLastFinalizedPrice('BTC/USD')).to.equal('65000.00000000');
        expect(consensus.lastFinalizedRoundFor('LTC/USD')).to.equal(41);
    });

    it('keeps the round bound inside every indexed pair predicate', async function () {
        const { hub, consensus } = build();
        hub.db.doQuery.resolves([]);

        await consensus.seedLastFinalizedPrices({ quiet: true, belowRound: 42 });

        expect(hub.db.doQuery.calledOnce).to.equal(true);
        expectIndexedLatestLookup(hub.db.doQuery.firstCall, ['BTC/USD', 'LTC/USD'], 42);
    });
});
