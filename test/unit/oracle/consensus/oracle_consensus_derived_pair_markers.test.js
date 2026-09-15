'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// item 3521: the per-pair silent-drop markers (#180) were computed over
// PriceFetcher.getCoinPairs() alone, while ADMISSION is the union of those 36 API
// pairs with DERIVED_PAIRS (OracleRound.canonicalPairs). XCHAIN/USD is therefore
// fully admitted, aggregated, co-signed and finalized, yet was the one pair that
// could stop publishing with no status='skipped' row, nothing in
// getSubmissionsInfo().droppedPairs, and the previous snapshot still reading alive.
// These pin the marker set to the admission set, gated on the round's own activation
// instant so the pair is not marked skipped in rounds where it was never due.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../../../src/oracle/consensus');
const PriceFetcher = require('../../../../src/oracle/price_fetcher');
const {
  DERIVED_PAIRS
} = require('../../../../src/constants.js');
const {
  createMockHub,
  DB_METHODS
} = require('../../../helpers/mockHub');
const oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN = DERIVED_PAIRS[0];
let oracleConsensusDerivedPairDropMarkersItemSuite1Oc;

// Minimal OracleRound stand-in exposing only the round-keyed gate the marker
// path consults, so these cases pin the seam and not the activation arithmetic
// (which xchain_price_activation's own suite already covers).
function oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(openFor) {
  return {
    getSubmissions: sinon.stub().returns(new Map()),
    xchainPriceGateOpenFor: round => openFor(round)
  };
}
function registerOracleConsensusDerivedPairDropMarkersItemSuite1Part1() {
  afterEach(function () {
    sinon.restore();
  });
  it('leaves the derived pair out while the activation gate is closed', function () {
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(createMockHub(), oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(() => false));
    const pairs = oracleConsensusDerivedPairDropMarkersItemSuite1Oc.markerPairs(7);
    expect(pairs).to.deep.equal(PriceFetcher.getCoinPairs());
    expect(pairs).to.not.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
  });
  it('unions the derived pair in once the gate is open for that round', function () {
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(createMockHub(), oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(() => true));
    const pairs = oracleConsensusDerivedPairDropMarkersItemSuite1Oc.markerPairs(7);
    expect(pairs).to.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
    // Union, not replacement: every fetched pair still gets its marker.
    for (const p of PriceFetcher.getCoinPairs()) expect(pairs, p).to.include(p);
    expect(pairs.length).to.equal(PriceFetcher.getCoinPairs().length + DERIVED_PAIRS.length);
  });

  // The gate is asked about the STORED round. A hub writing markers for the round
  // it just finalized may already have advanced its own currentRound past the
  // threshold, so a currentRound-keyed read would answer for the wrong instant.
  it('asks the gate about the stored round, not whatever round is current', function () {
    const seen = [];
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(createMockHub(), oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(round => {
      seen.push(round);
      return round >= 100;
    }));
    expect(oracleConsensusDerivedPairDropMarkersItemSuite1Oc.markerPairs(99)).to.not.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
    expect(oracleConsensusDerivedPairDropMarkersItemSuite1Oc.markerPairs(100)).to.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
    expect(seen).to.deep.equal([99, 100]);
  });
  it('fails closed to the fetched pairs when the gate throws', function () {
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(createMockHub(), {
      getSubmissions: sinon.stub().returns(new Map()),
      xchainPriceGateOpenFor: () => {
        throw new Error('no epoch yet');
      }
    });
    expect(oracleConsensusDerivedPairDropMarkersItemSuite1Oc.markerPairs(7)).to.deep.equal(PriceFetcher.getCoinPairs());
  });
  it('fails closed against an OracleRound that predates the round-keyed gate', function () {
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(createMockHub(), {
      getSubmissions: sinon.stub().returns(new Map())
    });
    expect(oracleConsensusDerivedPairDropMarkersItemSuite1Oc.markerPairs(7)).to.deep.equal(PriceFetcher.getCoinPairs());
  });

  // The whole point of the item: a gated-on round that finalizes the other pairs but
  // drops the derived one must now leave a durable skipped row for it.
}
function registerOracleConsensusDerivedPairDropMarkersItemSuite1Part2() {
  it('writes a skipped row for the derived pair when a finalizing round omits it', async function () {
    const hub = createMockHub();
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(hub, oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(() => true));
    const queries = [];
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc.db = {
      ...DB_METHODS,
      doQuery: async (sql, params) => {
        queries.push({
          sql,
          params
        });
        return [];
      }
    };
    await oracleConsensusDerivedPairDropMarkersItemSuite1Oc._storeSnapshot(42, [{
      coinPair: 'BTC/USD',
      price: '100000'
    }], 3, '[]', 900, 1700000000);
    const skipInsert = queries.find(q => q.sql.includes("'skipped'") && q.sql.includes('INSERT INTO price_snapshots'));
    expect(skipInsert, 'a skipped-marker INSERT was issued').to.exist;
    expect(skipInsert.params, 'the derived pair is among the marked pairs').to.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
  });
  it('does not mark the derived pair skipped when the round actually finalized it', async function () {
    const hub = createMockHub();
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(hub, oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(() => true));
    const queries = [];
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc.db = {
      ...DB_METHODS,
      doQuery: async (sql, params) => {
        queries.push({
          sql,
          params
        });
        return [];
      }
    };
    await oracleConsensusDerivedPairDropMarkersItemSuite1Oc._storeSnapshot(42, [{
      coinPair: 'BTC/USD',
      price: '100000'
    }, {
      coinPair: oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN,
      price: '0.01'
    }], 3, '[]', 900, 1700000000);
    const skipInsert = queries.find(q => q.sql.includes("'skipped'") && q.sql.includes('INSERT INTO price_snapshots'));
    if (skipInsert) expect(skipInsert.params).to.not.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
  });
}
function registerOracleConsensusDerivedPairDropMarkersItemSuite1Part3() {
  it('includes the derived pair in a whole-round skip once the gate is open', async function () {
    const hub = createMockHub();
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(hub, oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(() => true));
    const queries = [];
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc.db = {
      ...DB_METHODS,
      doQuery: async (sql, params) => {
        queries.push({
          sql,
          params
        });
        return [];
      }
    };
    await oracleConsensusDerivedPairDropMarkersItemSuite1Oc.storeSkippedRound(42, 900, 1700000000, 'no submissions');
    const insert = queries.find(q => q.sql.includes('INSERT INTO price_snapshots'));
    expect(insert, 'a skipped-round INSERT was issued').to.exist;
    expect(insert.params).to.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
  });
  it('omits it from a whole-round skip below the gate', async function () {
    const hub = createMockHub();
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc = new OracleConsensus(hub, oracleConsensusDerivedPairDropMarkersItemSuite1WithGate(() => false));
    const queries = [];
    oracleConsensusDerivedPairDropMarkersItemSuite1Oc.db = {
      ...DB_METHODS,
      doQuery: async (sql, params) => {
        queries.push({
          sql,
          params
        });
        return [];
      }
    };
    await oracleConsensusDerivedPairDropMarkersItemSuite1Oc.storeSkippedRound(42, 900, 1700000000, 'no submissions');
    const insert = queries.find(q => q.sql.includes('INSERT INTO price_snapshots'));
    expect(insert).to.exist;
    expect(insert.params).to.not.include(oracleConsensusDerivedPairDropMarkersItemSuite1XCHAIN);
  });
}
describe('OracleConsensus derived-pair drop markers (item 3521)', function () {
  registerOracleConsensusDerivedPairDropMarkersItemSuite1Part1.call(this);
  registerOracleConsensusDerivedPairDropMarkersItemSuite1Part2.call(this);
  registerOracleConsensusDerivedPairDropMarkersItemSuite1Part3.call(this);
});
