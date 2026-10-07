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

// The oracle fields xchain-dashboard reads, pinned where a rename would happen.
//
// The dashboard tolerates a missing diagnostics field on purpose (an older hub
// lacks it), so a hub rename or drop reads there as 0/false/null and silently
// turns off a rise-only alert or the frozen-tip crit. Only currentRound and
// submissions are guarded on that side. This file fails in hub CI instead.
//
// Consumers (xchain-dashboard monitor/src): lib/oracles.js, lib/alerts/rules.js,
// lib/alerts/evaluator.js, lib/alerts/oracle-baselines.js, views/oracles.js and
// lib/hub-client.js. Add a key here when the dashboard starts reading one; pin
// presence only, because null is a legitimate value for most of them.
// active and oracleMaxPriceAgeSeconds come from the getoraclesubmissions wrapper
// (src/api/rpc/oracle.js), not getSubmissionsInfo, and oracle_submissions_role.test.js
// already pins both.

const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMockHub } = require('../../../helpers/mockHub');

const SUBMISSIONS_INFO_KEYS = [
    'currentRound', 'roundInterval', 'submissions',
    'skippedRounds', 'skippedCount', 'skippedRoundsReadError',
    'droppedPairs', 'droppedPairCount', 'droppedPairsReadError',
    'roundBand', 'implausibleRounds', 'implausibleRoundCount', 'implausibleRoundRejections',
    'failedSubmissionPersists', 'lastSubmissionPersistFailureRound', 'lastSubmissionPersistFailureCount',
    'submissionsPruneFailures', 'lastSubmissionsPruneFailureRound', 'consecutiveSkippedRounds',
    'round_timeouts', 'abandoned_rounds', 'lastAbandonedRound',
    'single_source_rounds', 'lastSingleSourceRound', 'oracle_fetch_failures',
    'lastSuccessfulRoundTime', 'lastSuccessAgeMs', 'usingFallback', 'chainTipFetchFailures',
    'chainTipStalenessMs', 'chainTipBlockAgeMs', 'chainTipBlockStale'
];
const DROPPED_PAIR_KEYS = ['round', 'coinPair'];
const ROUND_BAND_KEYS = ['max'];

// pairHealth reads these off getpricesnapshots(status 'all'), which serves SELECT *.
const PRICE_SNAPSHOT_COLUMNS = [
    'round_number', 'coin_pair', 'price', 'status', 'validator_count',
    'consensus_round', 'block_timestamp', 'reference_chain'
];

const DDL_PATH = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'price_snapshots.sql');
const INTERVAL_MS = 60000;
const CURRENT = 51688;

function missingKeys(obj, keys) {
    return keys.filter(k => !(obj && Object.prototype.hasOwnProperty.call(obj, k)));
}

// Column names declared in a CREATE TABLE body: the leading identifier of every line
// that is not a key, constraint or comment.
function ddlColumns(ddl) {
    let cols = [];
    for (let line of ddl.split('\n')) {
        let m = /^\s+([a-z_][a-z0-9_]*)\s+[A-Z]/.exec(line);
        if (m && !/^(UNIQUE|KEY|PRIMARY|CONSTRAINT|INDEX)$/i.test(m[1])) cols.push(m[1]);
    }
    return cols;
}

let OracleRound = null;

async function liveInfo() {
    let hub = createMockHub({
        p2pConfig: {
            ORACLE_EPOCH_START: Date.now() - CURRENT * INTERVAL_MS,
            ORACLE_ROUND_INTERVAL: String(INTERVAL_MS),
            ORACLE_SUBMISSION_WINDOW: '30000'
        }
    });
    // One dropped pair, so the element keys are read off a real row, not an empty list.
    hub.db.doQuery = sinon.stub().callsFake(async sql => {
        if (/SELECT s\.round_number, s\.coin_pair FROM price_snapshots/.test(sql))
            return [{ round_number: CURRENT - 1, coin_pair: 'DOGE/USD' }];
        return [];
    });
    return new OracleRound(hub).getSubmissionsInfo();
}

describe('oracle diagnostics: fields xchain-dashboard reads', function () {
    // A cold load of the oracle module tree takes seconds when this file runs alone.
    before(function () {
        this.timeout(30000);
        OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () { return { fetchPrices: sinon.stub().resolves([]) }; }
        });
    });
    afterEach(function () { sinon.restore(); });

    it('getSubmissionsInfo emits every key the dashboard reads', async function () {
        let info = await liveInfo();
        expect(missingKeys(info, SUBMISSIONS_INFO_KEYS)).to.deep.equal([]);
    });

    it('droppedPairs elements and roundBand carry the sub-keys the dashboard reads', async function () {
        let info = await liveInfo();
        expect(info.droppedPairs).to.have.length(1);
        expect(missingKeys(info.droppedPairs[0], DROPPED_PAIR_KEYS)).to.deep.equal([]);
        expect(info.roundBand, 'band resolves on a configured schedule').to.be.an('object');
        expect(missingKeys(info.roundBand, ROUND_BAND_KEYS)).to.deep.equal([]);
    });

    it('names a key the payload no longer carries', async function () {
        let info = await liveInfo();
        delete info.abandoned_rounds;
        delete info.chainTipBlockStale;
        expect(missingKeys(info, SUBMISSIONS_INFO_KEYS)).to.deep.equal(['abandoned_rounds', 'chainTipBlockStale']);
    });
});

describe('price_snapshots: columns xchain-dashboard reads', function () {
    let ddl = fs.readFileSync(DDL_PATH, 'utf8');

    it('parses enough columns that a membership miss is real, not a parser miss', function () {
        let cols = ddlColumns(ddl);
        expect(cols.length).to.be.at.least(20);
        expect(cols).to.include('id');
        expect(cols).to.not.include('UNIQUE');
    });

    it('the DDL declares every column the dashboard reads', function () {
        expect(missingKeys(Object.fromEntries(ddlColumns(ddl).map(c => [c, true])), PRICE_SNAPSHOT_COLUMNS))
            .to.deep.equal([]);
    });

    it('the status-all read the dashboard uses still selects every column', async function () {
        let hub = createMockHub();
        await hub.db.findPriceSnapshotsAnyStatus(5);
        expect(hub.db.doQuery.getCall(0).args[0]).to.match(/^SELECT \* FROM price_snapshots /);
    });

    it('names a column the DDL no longer declares', function () {
        let dropped = ddl.split('\n').filter(l => !/^\s+validator_count\s/.test(l)).join('\n');
        let cols = Object.fromEntries(ddlColumns(dropped).map(c => [c, true]));
        expect(missingKeys(cols, PRICE_SNAPSHOT_COLUMNS)).to.deep.equal(['validator_count']);
    });
});
