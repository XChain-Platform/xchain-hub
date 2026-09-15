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
 * XChain Hub - AttestationBatchPublisher unit tests (the ATTEST response-mirror
 * design, §6.2).
 *
 * The cases here are the ones a reading of the diff cannot settle: that the window
 * is on the unix hour and not on the process's own start, that an EMPTY window still
 * publishes a coverage head, that an over-cap window dead-letters loudly rather than
 * truncating itself, that a restart cannot pay for a window twice, and that a window
 * whose quorum was unavailable is retried with the SAME bytes rather than a new
 * proposal. The DB is a small in-memory pair of tables rather than call-counting
 * stubs, because "the second publisher saw the first one's marker" is exactly the
 * assertion a canned stub cannot fail.
 *
 ********************************************************************/

'use strict';

const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { expect } = require('chai');

const AttestationBatchPublisher = require('../../../../../src/attestation/batch_publisher.js');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const abw = require('../../../../../src/lib/attest_batch_wire.js');
const { isNeverSentError, isAmbiguousSendError } = require('../../../../../src/lib/idempotent_broadcast.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const WINDOW_S = 10;                       // regtest override; the whole suite closes windows in seconds
const ANCHOR   = 941234;

// ---------------------------------------------------------------------------
// Two in-memory tables with just enough SQL surface for the publisher's reads and
// writes, plus the chain-tip accessor it resolves its anchor from.
// ---------------------------------------------------------------------------
function selectResponses(responses, sql, args){
    // Membership is read off the column the statement actually names, so a
    // publisher that went back to the audit column selects nothing here.
    let column  = /WHERE network = \? AND ([a-z_]+) >= \?/i.exec(sql)[1];
    let [network, from, to, limit] = args;
    return responses
        .filter(r => r.network === network && r[column] >= from && r[column] < to)
        .sort((a, b) => (a.request_block_index - b.request_block_index) ||
                        (a.request_action_index - b.request_action_index) ||
                        (a.request_id < b.request_id ? -1 : 1))
        .slice(0, limit)
        .map(r => Object.assign({}, r));
}

function deleteMarker(markers, args){
            // Read BEFORE the marker SELECT below, whose predicate this statement shares:
            // matched the other way round, a withdraw would silently read as a lookup and
            // the row it was meant to remove would survive.
    let [network, windowStart, fromStatus] = args;
    // The status predicate is honoured, because the whole safety argument for
    // the withdraw is that it can only remove an intent-only row: a fake that
    // deleted unconditionally could not fail the case that matters.
    let idx = markers.findIndex(m => m.network === network &&
                                 Number(m.window_start) === Number(windowStart) &&
                                 m.status === fromStatus);
    if(idx < 0) return { affectedRows: 0 };
    markers.splice(idx, 1);
    return { affectedRows: 1 };
}

function insertMarker(markers, sql, args){
    let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
    let row  = {};
    cols.forEach((c, i) => { row[c] = args[i]; });
    let existing = markers.find(m => Number(m.window_start) === Number(row.window_start));
    if(existing){
        // Only the landed/dead-letter statements carry an updating clause; the
        // intent statement's is a deliberate no-op, and the fake honours that
        // difference so a replay cannot downgrade a marker here either.
        if(/status = VALUES\(status\)/i.test(sql)){
            existing.status    = row.status;
            existing.row_count = row.row_count;
        }
        return { affectedRows: 0 };
    }
    markers.push(row);
    return { affectedRows: 1 };
}

function updateMarker(markers, args){
    let [status, txid, rowCount, network, windowStart, fromStatus] = args;
    let found = markers.find(m => m.network === network &&
                                  Number(m.window_start) === Number(windowStart) &&
                                  m.status === fromStatus);
    if(!found) return { affectedRows: 0 };
    Object.assign(found, { status, txid, row_count: rowCount });
    return { affectedRows: 1 };
}

function doDbQuery(responses, markers, sql, args){
            if(/FROM attestation_responses/i.test(sql)) return selectResponses(responses, sql, args);
            if(/^DELETE FROM attest_published_batches/i.test(sql)) return deleteMarker(markers, args);
            // The floor read. BOTH aggregates are answered from the same row set, so a
            // publisher that went back to flooring on the newest marker reads a real
            // value here rather than an undefined the test would silently coerce.
            if(/SELECT MIN\(window_start\)/i.test(sql)){
                let oldest = markers.reduce((m, r) => Math.min(m, Number(r.window_start)), Infinity);
                let newest = markers.reduce((m, r) => Math.max(m, Number(r.window_start)), 0);
                return [{ oldest: Number.isFinite(oldest) ? oldest : null, newest: newest || null }];
            }
            if(/SELECT window_start FROM attest_published_batches/i.test(sql)){
                return markers.filter(m => m.status === args[1]).map(m => ({ window_start: m.window_start }));
            }
            if(/FROM attest_published_batches WHERE network = \? AND window_start = \?/i.test(sql)){
                let found = markers.find(m => m.network === args[0] && Number(m.window_start) === Number(args[1]));
                return found ? [Object.assign({}, found)] : [];
            }
            if(/^INSERT INTO attest_published_batches/i.test(sql)) return insertMarker(markers, sql, args);
            if(/^UPDATE attest_published_batches SET status/i.test(sql)) return updateMarker(markers, args);
            throw new Error('unexpected statement: ' + sql);
}

function makeDb(){
    let responses = [];
    let markers   = [];
    let tip       = { blockHeight: ANCHOR, blockTime: 1 };
    return { ...DB_METHODS,
        responses, markers,
        setTip(h){ tip = (h === null) ? null : { blockHeight: h, blockTime: 1 }; },
        marker(windowStart){ return markers.find(m => Number(m.window_start) === Number(windowStart)) || null; },
        async getChainTip(){ return tip; },
        async doQuery(sql, args){
            return doDbQuery(responses, markers, sql, args);
        }
    };
}

// `effective_time` is what places a row in a window, so every case sets it. The
// default `finalized_at` is deliberately absurd: it belongs to no window any test
// publishes, so a publisher that partitioned on the audit column would find an empty
// window everywhere in this file rather than a subtly different one.
function makeRow(overrides){
    let rid = crypto.randomBytes(32).toString('hex');
    return Object.assign({
        network:              'regtest',
        request_id:           rid,
        request_action_index: 4400,
        request_block_index:  120,
        provider_id:          'http_get',
        status:               'ok',
        response_payload:     '{"ok":true}',
        response_hash:        crypto.createHash('sha256').update('body').digest('hex'),
        meta:                 '200',
        effective_time:       1780000120,
        signer_pubkeys:       '[]',
        signatures:           '[]',
        widen:                0,
        finalized_at:         7
    }, overrides || {});
}

// A capability snapshot of `n` validators, the first of which is this hub. Weights
// are deliberately uneven so a two-of-three signer set clears the strict 2/3 stake
// bar, which equal weights would sit exactly on and fail.
function makeSnapshot(privkeys){
    let weights = ['100', '100', '10', '10', '10'];
    return {
        validators: privkeys.map((pk, i) => ({
            pubkey: new ValidatorIdentity(pk).getPubkeyHex().toLowerCase(),
            weight: weights[i] || '10',
            amount: weights[i] || '10',
            source: 'src' + i
        })),
        count: privkeys.length
    };
}

function makeHub(opts){
    opts = opts || {};
    let db  = opts.db || makeDb();
    let ids = opts.identities || [ValidatorIdentity.generate()];
    let identity = new ValidatorIdentity(ids[0].privkeyHex);
    let snapshot = makeSnapshot(ids.map(i => i.privkeyHex));
    return {
        network:  opts.network || 'regtest',
        db:       db,
        p2pConfig: Object.assign({
            ATTEST_BATCH_WINDOW_S_OVERRIDE: String(WINDOW_S),
            ATTEST_BATCH_BUFFER_PATH: path.join(opts.dir, 'attest-batch-buffer.jsonl'),
            ATTEST_BATCH_SPEND_STATE_PATH: path.join(opts.dir, 'spend-state.json'),
            ORACLE_BATCH_SIGN_TIMEOUT_MS: '40'
        }, opts.cfg || {}),
        getIdentity: () => identity,
        capabilitySnapshot: opts.capabilitySnapshot || {
            async getWeightSnapshot(){ return snapshot; },
            async getSnapshot(){ return snapshot; }
        },
        peerManager: opts.peerManager || null,
        _identity:   identity,
        _snapshot:   snapshot
    };
}

// A publisher wired to a capturing broadcaster. Returns both so a test can read the
// wires that actually went out.
function makePublisher(hub){
    let p = new AttestationBatchPublisher(hub);
    let sent = [];
    p.setBroadcastHook(async (payload) => {
        sent.push(payload);
        return { txid: 'tx' + sent.length };
    });
    p.wires = sent;
    return p;
}

function decodeHead(wire){
    let params = wire.split('|').slice(1);
    let head   = abw.parseAttestBatchHead(params);
    if(!head.ok) throw new Error('head did not parse: ' + head.status);
    return head;
}

{
let dir;

const hookAt10719 = function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-batch-'));
    };

const hookAt10827 = function () {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    };

// A broadcaster that throws the scripted error for call N, and succeeds once the
        // script runs out. `calls` counts every attempt, thrown or not.
        function makeScriptedPublisher(hub, script){
            let p = new AttestationBatchPublisher(hub);
            let sent = [];
            p.calls = 0;
            p.setBroadcastHook(async (payload) => {
                let e = script[p.calls++];
                if(e) throw e;
                sent.push(payload);
                return { txid: 'tx' + sent.length };
            });
            p.wires = sent;
            return p;
        }

function neverConnected(){
            return Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }

// Rows whose payloads are random hex, so the deflated body cannot fit one wire
        // and the window is genuinely a head plus continuations.
        function chunkedRows(start){
            let out = [];
            for (let i = 0; i < 6; i++)
                out.push(makeRow({ effective_time: start + 1, request_action_index: i,
                                   response_payload: crypto.randomBytes(3000).toString('hex') }));
            return out;
        }

function captureErrors(){
            let lines = [];
            let real = console.error;
            console.error = (msg) => lines.push(String(msg));
            return { lines, restore(){ console.error = real; } };
        }

// ------------------------------------------------------------ refused before sending

    // The intent marker exists to stop a SECOND fee for a window that may
    // already carry a transaction. A head that was refused BEFORE it could be sent
    // carries none: the encoder answered 4xx, or the socket never connected. Keeping the
    // marker there quarantined the window forever, so one transient refusal on an hourly
    // window dropped that hour out of the chain-only reconstruction permanently (AT5
    // logs, 2026-09-05). These cases pin which failures withdraw the marker and, more
    // importantly, which ones still must not.


        // The whole point of the marker. An ambiguous head may be in a mempool this hub
        // cannot see, so the window stays latched and an operator reconciles it.
describe('AttestationBatchPublisher', function () { beforeEach(hookAt10719); afterEach(hookAt10827); describe('a head refused before it was sent', function () { it('still latches and quarantines an AMBIGUOUS head failure', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.responses.push(makeRow({ effective_time: start + 1 }));
            let p = makeScriptedPublisher(hub, [new Error('socket hang up')]);
            p._floorWindow = start;

            let cap = captureErrors();
            try { await p.sweep(now); } finally { cap.restore(); }

            expect(p.wires.length).to.equal(0);
            expect(hub.db.marker(start).status,
                'an ambiguous send must keep its intent marker').to.equal('intent');
            expect(p.stats.windowsRefusalRetried).to.equal(0);
            expect(cap.lines.filter(l => /AMBIGUOUSLY/.test(l)).length).to.equal(1);

            // And the next sweep refuses it rather than paying a second time.
            await p.sweep(now);
            expect(p.wires.length).to.equal(0);
            expect(p.stats.windowsQuarantined).to.equal(1);
        }); }); });

// ------------------------------------------------------------ refused before sending

    // The intent marker exists to stop a SECOND fee for a window that may
    // already carry a transaction. A head that was refused BEFORE it could be sent
    // carries none: the encoder answered 4xx, or the socket never connected. Keeping the
    // marker there quarantined the window forever, so one transient refusal on an hourly
    // window dropped that hour out of the chain-only reconstruction permanently (AT5
    // logs, 2026-09-05). These cases pin which failures withdraw the marker and, more
    // importantly, which ones still must not.


        // A continuation failing proves nothing about the head, which is already on
        // chain and already paid for. Provably-unsent or not, the window latches.
describe('AttestationBatchPublisher', function () { beforeEach(hookAt10719); afterEach(hookAt10827); describe('a head refused before it was sent', function () { it('still latches when a wire AFTER the head fails, even provably unsent', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            for (let r of chunkedRows(start)) hub.db.responses.push(r);
            let p = makeScriptedPublisher(hub, [null, neverConnected()]);
            p._floorWindow = start;

            let cap = captureErrors();
            try { await p.sweep(now); } finally { cap.restore(); }

            expect(p.calls, 'this window must be more than one wire for the case to mean anything')
                .to.be.at.least(2);
            expect(p.wires.length, 'the head went out').to.equal(1);
            expect(hub.db.marker(start).status).to.equal('intent');
            expect(p.stats.windowsRefusalRetried).to.equal(0);
            expect(cap.lines.filter(l => /CRITICAL - wire 2\//.test(l)).length).to.equal(1);

            await p.sweep(now);
            expect(p.stats.windowsQuarantined).to.equal(1);
        }); }); });
}
