/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - the boot-time scan for publish-intent markers.
 *
 * hydrateMarkers used to load every intent row this hub had ever written and report
 * the count with no age, so a marker from four days ago read exactly like one from
 * the last hour and an operator could not tell an action item from a reconciliation
 * record. These cases pin the bound (the catch-up horizon, which is the only span a
 * sweep can still reach) and pin that the line now carries each marker's age.
 *
 ********************************************************************/

'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const AttestationBatchPublisher = require('../../../../../src/attestation/batch_publisher.js');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const { MAX_CATCHUP_WINDOWS } = require('../../../../../src/attestation/batch_publisher/constants.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const WINDOW_S = 10;                       // regtest override; these cases close windows in seconds
const HOUR_S   = 3600;                     // the protocol window, exercised off regtest

// One in-memory marker table, plus a record of every single-window lookup the sweep
// makes. The lookup log is the evidence for the bound: a window pendingWindows never
// asks about is a window no quarantine entry could ever have changed.
function makeDb(markers){
    let lookups = [];
    return { ...DB_METHODS,
        markers, lookups,
        async doQuery(sql, args){
            if(/SELECT window_start FROM attest_published_batches/i.test(sql))
                return markers.filter(m => m.network === args[0] && m.status === args[1])
                              .map(m => ({ window_start: m.window_start }));
            if(/SELECT MIN\(window_start\)/i.test(sql)){
                let starts = markers.map(m => Number(m.window_start));
                return [{ oldest: starts.length ? Math.min.apply(null, starts) : null,
                          newest: starts.length ? Math.max.apply(null, starts) : null }];
            }
            if(/FROM attest_published_batches WHERE network = \? AND window_start = \?/i.test(sql)){
                lookups.push(Number(args[1]));
                let found = markers.find(m => m.network === args[0] &&
                                              Number(m.window_start) === Number(args[1]));
                return found ? [Object.assign({}, found)] : [];
            }
            throw new Error('unexpected statement: ' + sql);
        }
    };
}

function intentMarker(network, windowStart, windowS){
    return { network: network, window_start: windowStart, window_end: windowStart + windowS,
             row_count: 1, status: 'intent', txid: null };
}

let dir;

const makeDir = function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-marker-horizon-')); };

const rmDir = function () {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
};

// `windowS` null leaves the regtest override off, which is how a case gets the frozen
// protocol window of one hour.
function makePublisher(network, windowS, markers){
    let identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    let cfg = {
        ATTEST_BATCH_BUFFER_PATH:      path.join(dir, 'attest-batch-buffer.jsonl'),
        ATTEST_BATCH_SPEND_STATE_PATH: path.join(dir, 'spend-state.json')
    };
    if(windowS !== null) cfg.ATTEST_BATCH_WINDOW_S_OVERRIDE = String(windowS);
    let hub = {
        network: network,
        db: makeDb(markers),
        p2pConfig: cfg,
        getIdentity: () => identity,
        peerManager: null
    };
    return new AttestationBatchPublisher(hub);
}

// Both sinks, because the whole point of the change is that the two kinds of marker
// are reported at two severities: error routes to console.error, info to console.log.
function captureLog(){
    let errors = [], infos = [];
    let realError = console.error, realLog = console.log;
    console.error = (msg) => errors.push(String(msg));
    console.log   = (msg) => infos.push(String(msg));
    return { errors, infos, restore(){ console.error = realError; console.log = realLog; } };
}

async function hydrate(p, nowSec){
    let cap = captureLog();
    try { await p.hydrateMarkers(nowSec); } finally { cap.restore(); }
    return cap;
}

// ------------------------------------------------------------ inside the horizon

describe('AttestationBatchPublisher', function () { beforeEach(makeDir); afterEach(rmDir); describe('the publish-intent marker horizon', function () { it('quarantines a marker inside the horizon and names how old it is', async function () {
    let now = 200 * WINDOW_S;
    let start = now - WINDOW_S;
    let p = makePublisher('regtest', WINDOW_S, [intentMarker('regtest', start, WINDOW_S)]);

    let cap = await hydrate(p, now);

    expect(p._quarantined.has(start)).to.equal(true);
    expect(cap.errors.length).to.equal(1);
    expect(cap.errors[0]).to.contain(String(start));
    expect(cap.errors[0]).to.contain('1 window(s) / 0m10s old');
}); }); });

// ------------------------------------------------------------ below the horizon

describe('AttestationBatchPublisher', function () { beforeEach(makeDir); afterEach(rmDir); describe('the publish-intent marker horizon', function () { it('leaves a marker below the horizon out of the quarantine set', async function () {
    let now = 200 * WINDOW_S;
    let aged = now - (MAX_CATCHUP_WINDOWS + 1) * WINDOW_S;
    let p = makePublisher('regtest', WINDOW_S, [intentMarker('regtest', aged, WINDOW_S)]);

    let cap = await hydrate(p, now);

    expect(p._quarantined.has(aged)).to.equal(false);
    expect(p._quarantined.size).to.equal(0);
    // No action item at all: that line is where four days of unactionable noise came from.
    expect(cap.errors.length).to.equal(0);
}); }); });

describe('AttestationBatchPublisher', function () { beforeEach(makeDir); afterEach(rmDir); describe('the publish-intent marker horizon', function () { it('reports a marker below the horizon as history, at info, with its age', async function () {
    let now = 200 * WINDOW_S;
    let aged = now - (MAX_CATCHUP_WINDOWS + 3) * WINDOW_S;
    let p = makePublisher('regtest', WINDOW_S, [intentMarker('regtest', aged, WINDOW_S)]);

    let cap = await hydrate(p, now);

    let history = cap.infos.filter(l => /publish-intent marker\(s\) lie below/.test(l));
    expect(history.length).to.equal(1);
    expect(history[0]).to.contain('7 window(s) / 1m10s old');
    expect(history[0]).to.contain('NOT an action item');
}); }); });

// ------------------------------------------------------------ where the bound falls

    // THE BOUND'S WHOLE JUSTIFICATION. pendingWindows asks only about the
    // MAX_CATCHUP_WINDOWS windows below the current one, so the oldest of those is the
    // last one a quarantine entry can change an outcome for; the next is never asked about.
describe('AttestationBatchPublisher', function () { beforeEach(makeDir); afterEach(rmDir); describe('the publish-intent marker horizon', function () { it('bounds at exactly the oldest window the sweep still asks about', async function () {
    let now = 200 * WINDOW_S;
    let oldestReachable = now - MAX_CATCHUP_WINDOWS * WINDOW_S;
    let justPast        = oldestReachable - WINDOW_S;
    let p = makePublisher('regtest', WINDOW_S,
        [intentMarker('regtest', oldestReachable, WINDOW_S), intentMarker('regtest', justPast, WINDOW_S)]);

    await hydrate(p, now);
    expect(p._quarantined.has(oldestReachable)).to.equal(true);
    expect(p._quarantined.has(justPast)).to.equal(false);

    let cap = captureLog();
    try { await p.pendingWindows(now); } finally { cap.restore(); }

    expect(p.hub.db.lookups).to.contain(oldestReachable);
    expect(p.hub.db.lookups).to.not.contain(justPast);
}); }); });

// ------------------------------------------------------------ the age in the line

describe('AttestationBatchPublisher', function () { beforeEach(makeDir); afterEach(rmDir); describe('the publish-intent marker horizon', function () { it('names every marker inside the horizon with its own age', async function () {
    let now = 200 * WINDOW_S;
    let starts = [now - WINDOW_S, now - 2 * WINDOW_S, now - MAX_CATCHUP_WINDOWS * WINDOW_S];
    let p = makePublisher('regtest', WINDOW_S, starts.map(s => intentMarker('regtest', s, WINDOW_S)));

    let cap = await hydrate(p, now);

    expect(cap.errors.length).to.equal(1);
    expect(cap.errors[0]).to.contain('3 window(s) carry a publish-intent marker');
    expect(cap.errors[0]).to.contain(starts[2] + ' (4 window(s) / 0m40s old)');
    expect(cap.errors[0]).to.contain(starts[1] + ' (2 window(s) / 0m20s old)');
    expect(cap.errors[0]).to.contain(starts[0] + ' (1 window(s) / 0m10s old)');
}); }); });

// ------------------------------------------------------------ the hourly window

    // The shape the row was reported in: an hourly window, a marker from four days ago,
    // and a hub that had not restarted in four days.
describe('AttestationBatchPublisher', function () { beforeEach(makeDir); afterEach(rmDir); describe('the publish-intent marker horizon', function () { it('on the hourly window, four days old is history and two hours old is the action item', async function () {
    let now  = 490000 * HOUR_S;
    let live = now - 2 * HOUR_S;
    let old  = now - 96 * HOUR_S;
    let p = makePublisher('testnet', null,
        [intentMarker('testnet', live, HOUR_S), intentMarker('testnet', old, HOUR_S)]);
    expect(p.windowS).to.equal(HOUR_S);

    let cap = await hydrate(p, now);

    expect(p._quarantined.has(live)).to.equal(true);
    expect(p._quarantined.has(old)).to.equal(false);
    expect(cap.errors.length).to.equal(1);
    expect(cap.errors[0]).to.contain(live + ' (2 window(s) / 2h0m old)');
    expect(cap.errors[0]).to.not.contain(String(old));
    expect(cap.infos.filter(l => /lie below/.test(l))[0]).to.contain('96 window(s) / 4d0h old');
}); }); });
