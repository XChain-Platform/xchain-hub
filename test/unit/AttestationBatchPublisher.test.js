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

const AttestationBatchPublisher = require('../../src/AttestationBatchPublisher.js');
const ValidatorIdentity = require('../../src/ValidatorIdentity.js');
const abw = require('../../src/lib/attest_batch_wire.js');
const { isNeverSentError, isAmbiguousSendError } = require('../../src/lib/idempotent_broadcast.js');

const WINDOW_S = 10;                       // regtest override; the whole suite closes windows in seconds
const ANCHOR   = 941234;

// ---------------------------------------------------------------------------
// Two in-memory tables with just enough SQL surface for the publisher's reads and
// writes, plus the chain-tip accessor it resolves its anchor from.
// ---------------------------------------------------------------------------
function makeDb(){
    let responses = [];
    let markers   = [];
    let tip       = { blockHeight: ANCHOR, blockTime: 1 };
    return {
        responses, markers,
        setTip(h){ tip = (h === null) ? null : { blockHeight: h, blockTime: 1 }; },
        marker(windowStart){ return markers.find(m => Number(m.window_start) === Number(windowStart)) || null; },
        async getChainTip(){ return tip; },
        async doQuery(sql, args){
            if(/FROM attestation_responses/i.test(sql)){
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
            // Read BEFORE the marker SELECT below, whose predicate this statement shares:
            // matched the other way round, a withdraw would silently read as a lookup and
            // the row it was meant to remove would survive.
            if(/^DELETE FROM attest_published_batches/i.test(sql)){
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
            if(/SELECT MAX\(window_start\)/i.test(sql)){
                let newest = markers.reduce((m, r) => Math.max(m, Number(r.window_start)), 0);
                return [{ newest: newest || null }];
            }
            if(/SELECT window_start FROM attest_published_batches/i.test(sql)){
                return markers.filter(m => m.status === args[1]).map(m => ({ window_start: m.window_start }));
            }
            if(/FROM attest_published_batches WHERE network = \? AND window_start = \?/i.test(sql)){
                let found = markers.find(m => m.network === args[0] && Number(m.window_start) === Number(args[1]));
                return found ? [Object.assign({}, found)] : [];
            }
            if(/^INSERT INTO attest_published_batches/i.test(sql)){
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
            if(/^UPDATE attest_published_batches SET status/i.test(sql)){
                let [status, txid, rowCount, network, windowStart, fromStatus] = args;
                let found = markers.find(m => m.network === network &&
                                              Number(m.window_start) === Number(windowStart) &&
                                              m.status === fromStatus);
                if(!found) return { affectedRows: 0 };
                Object.assign(found, { status, txid, row_count: rowCount });
                return { affectedRows: 1 };
            }
            throw new Error('unexpected statement: ' + sql);
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

describe('AttestationBatchPublisher', function () {

    let dir;
    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-batch-'));
    });
    afterEach(function () {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    });

    // ------------------------------------------------------------ window math

    // Row identity in the co-sign compare is (request_id, effective_time), the table's
    // own key. A round that finalized under two leader slots leaves two honest rows for
    // one request that differ only in the stamp; keying on request_id alone read that
    // as "appears twice" on the hub holding both and as a field mismatch on a hub
    // holding one, so no such window could be co-signed (AT5 pass 19).
    describe('_matchesLocalWindow row identity', function () {
        function variants(){
            let rid = crypto.randomBytes(32).toString('hex');
            let a = makeRow({ request_id: rid, effective_time: 1780000120 });
            let b = makeRow({ request_id: rid, effective_time: 1780000127 });
            return { a, b };
        }

        it('accepts two honest variants of one request that differ only in effective_time', function () {
            let hub = makeHub({ dir: dir });
            let p   = new AttestationBatchPublisher(hub);
            let { a, b } = variants();
            expect(p._matchesLocalWindow([a, b], [a, b])).to.deep.equal({ ok: true, why: null });
            expect(p._matchesLocalWindow([b, a], [a, b]).ok).to.equal(true);
        });

        it('still refuses the same variant twice', function () {
            let hub = makeHub({ dir: dir });
            let p   = new AttestationBatchPublisher(hub);
            let { a } = variants();
            let v = p._matchesLocalWindow([a, Object.assign({}, a)], [a]);
            expect(v.ok).to.equal(false);
            expect(v.why).to.match(/appears twice/);
        });

        it('refuses a variant this hub does not hold, and one it holds that was not proposed', function () {
            let hub = makeHub({ dir: dir });
            let p   = new AttestationBatchPublisher(hub);
            let { a, b } = variants();
            let notHeld = p._matchesLocalWindow([a, b], [a]);
            expect(notHeld.ok).to.equal(false);
            expect(notHeld.why).to.match(/effective_time 1780000127 is proposed but not held here/);
            let notProposed = p._matchesLocalWindow([a], [a, b]);
            expect(notProposed.ok).to.equal(false);
            expect(notProposed.why).to.match(/effective_time 1780000127 is held here for this window but was not proposed/);
        });
    });

    describe('the window', function () {

        it('aligns to the unix hour at the protocol value, not to process start', function () {
            let hub = makeHub({ dir: dir, cfg: { ATTEST_BATCH_WINDOW_S_OVERRIDE: '' } });
            let p   = new AttestationBatchPublisher(hub);
            expect(p.windowS).to.equal(3600);
            for (let t of [1780000123, 1779998400, 0, 1780003599]) {
                let start = p.windowStartFor(t);
                expect(start % 3600, 'window start for ' + t).to.equal(0);
                expect(t - start).to.be.at.least(0).and.below(3600);
                expect(p.windowEndFor(start)).to.equal(start + 3600);
            }
        });

        it('never schedules the boundary in the past, and lands exactly on it', function () {
            let hub = makeHub({ dir: dir, cfg: { ATTEST_BATCH_WINDOW_S_OVERRIDE: '' } });
            let p   = new AttestationBatchPublisher(hub);
            // A millisecond after a boundary asks for very nearly a whole window; a
            // millisecond before asks for one millisecond, never zero or negative.
            expect(p.msToNextBoundary(1780002000 * 1000 + 1)).to.equal(3600 * 1000 - 1);
            expect(p.msToNextBoundary(1780002000 * 1000)).to.equal(3600 * 1000);
            expect(p.msToNextBoundary(1780005599 * 1000 + 999)).to.be.at.least(1);
        });

        it('honours the regtest override, so an acceptance run closes windows in seconds', function () {
            let hub = makeHub({ dir: dir });
            expect(new AttestationBatchPublisher(hub).windowS).to.equal(WINDOW_S);
        });

        it('IGNORES the override off regtest, where a private cadence would break co-signing', function () {
            let hub = makeHub({ dir: dir, network: 'testnet' });
            expect(new AttestationBatchPublisher(hub).windowS).to.equal(3600);
        });

        it('throws on a malformed regtest override rather than aligning to NaN', function () {
            for (let bad of ['0', 'ten', '', ' ', '-5', '1.5']) {
                let hub = makeHub({ dir: dir, cfg: { ATTEST_BATCH_WINDOW_S_OVERRIDE: bad } });
                if (String(bad).trim() === '') {
                    expect(new AttestationBatchPublisher(hub).windowS,
                        'an unset override is the protocol value, not an error').to.equal(3600);
                    continue;
                }
                expect(() => new AttestationBatchPublisher(hub), 'override "' + bad + '"').to.throw(/positive integer/);
            }
        });

        it('schedules nothing on a network whose mirror activation entry is null', async function () {
            let hub = makeHub({ dir: dir, network: 'mainnet' });
            let p   = new AttestationBatchPublisher(hub);
            expect(p.isArmedNetwork()).to.equal(false);
            await p.start();
            expect(p._windowTimer, 'an unarmed network must arm no window timer').to.equal(null);
            p.stop();
        });
    });

    // ------------------------------------------------------------ publishing

    describe('publishing a window', function () {

        it('publishes an EMPTY window as a row_count 0 coverage head', async function () {
            let hub = makeHub({ dir: dir });
            let p   = makePublisher(hub);
            let now = 200 * WINDOW_S;
            p._floorWindow = now - WINDOW_S;

            let result = await p.sweep(now);

            expect(result.published).to.equal(1);
            expect(p.wires.length).to.equal(1);
            let head = decodeHead(p.wires[0]);
            expect(head.rowCount).to.equal(0);
            expect(head.windowStart).to.equal(now - WINDOW_S);
            expect(head.windowEnd).to.equal(now);
            expect(head.totalChunks).to.equal(1);
            expect(p.stats.windowsEmpty).to.equal(1);
            expect(hub.db.marker(now - WINDOW_S).status).to.equal('sent');
        });

        it('carries the window\'s terminal rows, in the applier\'s order', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.responses.push(
                makeRow({ effective_time: start + 5, request_block_index: 121, request_action_index: 2 }),
                makeRow({ effective_time: start + 1, request_block_index: 120, request_action_index: 9 }),
                makeRow({ effective_time: start - 1 })                       // the PREVIOUS window's row
            );
            let p = makePublisher(hub);
            p._floorWindow = start;

            await p.sweep(now);

            let head = decodeHead(p.wires[0]);
            expect(head.rowCount).to.equal(2);
            let body = abw.reassembleAttestBatch(head, []);
            expect(body.ok, body.status).to.equal(true);
            expect(body.batch.rows.map(r => r.request_block_index)).to.deep.equal([120, 121]);
            // The audit column is hub wall clock and two hubs disagree on it, so it must
            // never reach the signed bytes.
            expect(Object.keys(body.batch.rows[0])).to.not.include('finalized_at');
        });

        it('dead-letters an over-cap window loudly instead of truncating it', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            for (let i = 0; i <= abw.ATTEST_BATCH_MAX_ROWS; i++)
                hub.db.responses.push(makeRow({ effective_time: start + 1, request_action_index: i }));
            let p = makePublisher(hub);
            p._floorWindow = start;

            await p.sweep(now);

            expect(p.wires.length, 'nothing may be published for an over-cap window').to.equal(0);
            expect(p.stats.windowsDeadLettered).to.equal(1);
            expect(hub.db.marker(start).status).to.equal('deadletter');
            let dead = fs.readFileSync(p.deadLetterPath, 'utf8').trim().split('\n').map(JSON.parse);
            expect(dead.length).to.equal(1);
            expect(dead[0].row_count).to.equal(abw.ATTEST_BATCH_MAX_ROWS + 1);
            expect(dead[0].reason).to.match(/exceeds ATTEST_BATCH_MAX_ROWS/);
        });

        it('does not re-publish a window a restart finds already sent', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.responses.push(makeRow({ effective_time: start + 1 }));

            let first = makePublisher(hub);
            first._floorWindow = start;
            await first.sweep(now);
            expect(first.wires.length).to.equal(1);

            // The restart: a NEW publisher over the same durable tables, exactly as a
            // process restart sees them. Its in-process state is empty, so only the
            // marker can stop a second DOGE fee.
            let second = makePublisher(hub);
            second._floorWindow = start;
            let result = await second.sweep(now);

            expect(second.wires.length, 'the marker must stop the second broadcast').to.equal(0);
            expect(result.attempted).to.equal(0);
            expect(hub.db.marker(start).txid).to.equal('tx1');
        });

        it('quarantines a window whose marker is intent-only, never re-publishing it', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.markers.push({ network: 'regtest', window_start: start, window_end: now,
                                  row_count: 1, status: 'intent', txid: null });

            let p = makePublisher(hub);
            p._floorWindow = start;
            await p.sweep(now);

            expect(p.wires.length).to.equal(0);
            expect(p.stats.windowsQuarantined).to.equal(1);
        });

        it('leaves a window unpublished when the anchor cannot be resolved', async function () {
            let hub = makeHub({ dir: dir });
            hub.db.setTip(null);
            let p = makePublisher(hub);
            let now = 200 * WINDOW_S;
            p._floorWindow = now - WINDOW_S;

            await p.sweep(now);

            expect(p.wires.length).to.equal(0);
            expect(hub.db.marker(now - WINDOW_S), 'a deferred window leaves NO marker').to.equal(null);
            expect(p.stats.windowsDeferred).to.equal(1);
        });

        // A hub whose Bitcoin indexer never called pushchaintip publishes nothing, ever.
        // That is a one-line configuration gap presenting as total silence, so the defer
        // has to name the missing thing; and it has to name it ONCE, because the sweep
        // runs every window and a regtest window is seconds long.
        it('names the missing BTC chain tip when it defers, once per cause', async function () {
            let hub = makeHub({ dir: dir });
            hub.db.setTip(null);
            let p = makePublisher(hub);
            let now = 200 * WINDOW_S;
            p._floorWindow = now - WINDOW_S;

            let warned = [];
            let realWarn = console.warn;
            console.warn = (msg) => warned.push(String(msg));
            try {
                await p.sweep(now);
                await p.sweep(now + WINDOW_S);
            } finally {
                console.warn = realWarn;
            }

            let anchorWarnings = warned.filter(w => /no BTC anchor/.test(w));
            expect(anchorWarnings.length, 'one line per cause, not one per window').to.equal(1);
            expect(anchorWarnings[0]).to.match(/chain_tips/);
            expect(anchorWarnings[0], 'the operator has to be told which call is missing')
                .to.match(/pushchaintip/);
            expect(p.getStats().anchorFailure).to.match(/chain_tips/);

            // A DIFFERENT cause speaks again: the latch is on the reason, not on the fact
            // that something once failed.
            hub.db.getChainTip = async () => { throw new Error('connection lost'); };
            warned.length = 0;
            console.warn = (msg) => warned.push(String(msg));
            try { await p.sweep(now + 2 * WINDOW_S); } finally { console.warn = realWarn; }
            expect(warned.filter(w => /connection lost/.test(w)).length).to.equal(1);

            // And it clears once the tip resolves, so a LATER outage of the same cause is
            // a new episode rather than a swallowed one.
            hub.db.getChainTip = async () => ({ blockHeight: ANCHOR, blockTime: 1 });
            await p.sweep(now + 3 * WINDOW_S);
            expect(p.getStats().anchorFailure).to.equal(null);

            hub.db.getChainTip = async () => { throw new Error('connection lost'); };
            warned.length = 0;
            console.warn = (msg) => warned.push(String(msg));
            try { await p.sweep(now + 4 * WINDOW_S); } finally { console.warn = realWarn; }
            expect(warned.filter(w => /connection lost/.test(w)).length,
                'a recovered rail that fails again must warn again').to.equal(1);
        });

        // A federation that shares one Bitcoin indexer has one hub with a chain_tips
        // row and N-1 without (testnet 2026-09-07: four of five validators). Every
        // one of them polls that indexer for requests, and the poll reports the tip,
        // so a hub with no pushed row anchors on the tip its own round observed.
        it('anchors on the tip the attestation poll observed when no chain tip was pushed', async function () {
            let hub = makeHub({ dir: dir });
            hub.db.setTip(null);
            hub.getAttestationRound = () => ({
                getObservedBtcTip: () => ({ blockHeight: ANCHOR - 3, observedAt: Date.now() })
            });
            let p = makePublisher(hub);
            let now = 200 * WINDOW_S;
            p._floorWindow = now - WINDOW_S;

            let result = await p.sweep(now);

            expect(result.published).to.equal(1);
            expect(decodeHead(p.wires[0]).btcBlockHeight).to.equal(ANCHOR - 3);
            expect(p.getStats().anchorSource).to.equal('observed');
            expect(p.getStats().anchorFailure).to.equal(null);
        });

        it('prefers the pushed chain tip over the observed one where both exist', async function () {
            let hub = makeHub({ dir: dir });
            hub.getAttestationRound = () => ({
                getObservedBtcTip: () => ({ blockHeight: ANCHOR - 3, observedAt: Date.now() })
            });
            let p = makePublisher(hub);
            let now = 200 * WINDOW_S;
            p._floorWindow = now - WINDOW_S;

            await p.sweep(now);

            expect(decodeHead(p.wires[0]).btcBlockHeight).to.equal(ANCHOR);
            expect(p.getStats().anchorSource).to.equal('pushed');
        });

        it('names both missing sources when neither the pushed nor the observed tip resolves', async function () {
            let hub = makeHub({ dir: dir });
            hub.db.setTip(null);
            hub.getAttestationRound = () => ({ getObservedBtcTip: () => null });
            let p = makePublisher(hub);
            let now = 200 * WINDOW_S;
            p._floorWindow = now - WINDOW_S;

            let warned = [];
            let realWarn = console.warn;
            console.warn = (msg) => warned.push(String(msg));
            try { await p.sweep(now); } finally { console.warn = realWarn; }

            expect(p.wires.length).to.equal(0);
            let line = warned.find(w => /no BTC anchor/.test(w));
            expect(line).to.match(/chain_tips/);
            expect(line).to.match(/pushchaintip/);
            expect(line, 'the operator has to know the fallback was tried too').to.match(/attestation poll/);
            expect(p.getStats().anchorSource).to.equal(null);
        });
    });

    // ------------------------------------------------------------ refused before sending

    // The intent marker exists to stop a SECOND fee for a window that may
    // already carry a transaction. A head that was refused BEFORE it could be sent
    // carries none: the encoder answered 4xx, or the socket never connected. Keeping the
    // marker there quarantined the window forever, so one transient refusal on an hourly
    // window dropped that hour out of the chain-only reconstruction permanently (AT5
    // logs, 2026-09-05). These cases pin which failures withdraw the marker and, more
    // importantly, which ones still must not.
    describe('a head refused before it was sent', function () {

        // The classifier the branch turns on. Its contract is NARROWER than "safe to
        // retry": a named node rejection is definitive, but the node had to receive the
        // transaction to reject it, so it is not proof that nothing left the process and
        // must not withdraw a marker.
        it('classifies only provably-unsent shapes as never sent', function () {
            expect(isNeverSentError({ response: { status: 400 } })).to.equal(true);
            expect(isNeverSentError({ response: { status: 429 } })).to.equal(true);
            expect(isNeverSentError({ code: 'ECONNREFUSED' })).to.equal(true);
            expect(isNeverSentError({ code: 'ENOTFOUND' })).to.equal(true);
            expect(isNeverSentError({ code: 'EAI_AGAIN' })).to.equal(true);

            expect(isNeverSentError(new Error('Encoder RPC error: bad-txns-inputs-missingorspent')),
                'a node rejection received the transaction').to.equal(false);
            expect(isNeverSentError({ response: { status: 502 } })).to.equal(false);
            expect(isNeverSentError({ code: 'ETIMEDOUT' })).to.equal(false);
            expect(isNeverSentError(new Error('socket hang up'))).to.equal(false);
            expect(isNeverSentError(null)).to.equal(false);
            // A multi-phase signer that already funded on chain is never "unsent",
            // whatever shape the failure that follows has.
            expect(isNeverSentError(Object.assign(new Error('refused'),
                { fundsCommitted: true, response: { status: 400 } }))).to.equal(false);
            expect(isNeverSentError(Object.assign(new Error('refused'),
                { fundsCommitted: true, code: 'ECONNREFUSED' }))).to.equal(false);

            // And it never contradicts the ambiguity gate: nothing may be both.
            for (let e of [{ response: { status: 400 } }, { code: 'ECONNREFUSED' },
                           { code: 'ETIMEDOUT' }, new Error('socket hang up')])
                expect(isNeverSentError(e) && isAmbiguousSendError(e)).to.equal(false);
        });

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

        // The encoder refusing the call before it builds anything: insufficient funds, or
        // change from the previous window still unconfirmed. HTTP 4xx, nothing sent.
        function httpRefusal(){
            return Object.assign(new Error('Encoder RPC error: insufficient funds'),
                                 { response: { status: 400 } });
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

        it('withdraws the intent marker on an HTTP 4xx head refusal and lands the window next cycle',
        async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.responses.push(makeRow({ effective_time: start + 1 }));
            let p = makeScriptedPublisher(hub, [httpRefusal()]);
            p._floorWindow = start;

            await p.sweep(now);

            expect(p.wires.length, 'the refused head never went out').to.equal(0);
            expect(hub.db.marker(start),
                'an intent marker for an unsent window is what strands its coverage').to.equal(null);
            expect(p.stats.windowsRefusalRetried).to.equal(1);
            expect(p.stats.windowsQuarantined).to.equal(0);
            // Nothing was sent, so nothing may be charged against the window ceiling.
            expect(p.spendGuard.spentInWindow()).to.equal(0);

            let result = await p.sweep(now);

            expect(result.published, 'the rebuilt window must publish').to.equal(1);
            expect(p.wires.length).to.equal(1);
            expect(decodeHead(p.wires[0]).windowStart).to.equal(start);
            expect(hub.db.marker(start).status).to.equal('sent');
            expect(p.getStats().refusalRetryWindows,
                'a landed window keeps no attempt history').to.equal(0);
        });

        it('does the same for a never-connected transport error', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.responses.push(makeRow({ effective_time: start + 1 }));
            let p = makeScriptedPublisher(hub, [neverConnected()]);
            p._floorWindow = start;

            await p.sweep(now);
            expect(hub.db.marker(start)).to.equal(null);
            expect(p.stats.windowsRefusalRetried).to.equal(1);

            await p.sweep(now);
            expect(p.wires.length).to.equal(1);
            expect(hub.db.marker(start).status).to.equal('sent');
        });

        // The whole point of the marker. An ambiguous head may be in a mempool this hub
        // cannot see, so the window stays latched and an operator reconciles it.
        it('still latches and quarantines an AMBIGUOUS head failure', async function () {
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
        });

        // A continuation failing proves nothing about the head, which is already on
        // chain and already paid for. Provably-unsent or not, the window latches.
        it('still latches when a wire AFTER the head fails, even provably unsent', async function () {
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
        });

        // A refusal that never clears must not re-propose forever: the federation's
        // signing capacity is the scarce thing. At the bound it latches like any other
        // failure, once, and quarantines from then on.
        it('latches exactly once when the attempt bound is reached', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.responses.push(makeRow({ effective_time: start + 1 }));
            let p = makeScriptedPublisher(hub, [httpRefusal(), httpRefusal(), httpRefusal(), httpRefusal()]);
            p._floorWindow = start;
            expect(p.maxRefusalAttempts).to.equal(3);

            let cap = captureErrors();
            try {
                await p.sweep(now);          // attempt 1: withdrawn, retried
                await p.sweep(now);          // attempt 2: withdrawn, retried
                await p.sweep(now);          // attempt 3: the bound, latch
                await p.sweep(now);          // quarantined, no fourth broadcast attempt
            } finally { cap.restore(); }

            expect(p.stats.windowsRefusalRetried).to.equal(2);
            expect(p.calls, 'the latched window must not be broadcast again').to.equal(3);
            expect(hub.db.marker(start).status).to.equal('intent');
            expect(cap.lines.filter(l => /CRITICAL - wire 1\//.test(l)).length,
                'a permanently refused window latches once, not once per sweep').to.equal(1);
            expect(p.stats.windowsQuarantined).to.equal(1);
        });

        // The withdraw is guarded on status = 'intent'. A batch the federation landed
        // between the send and the failure leaves a `landed` row, and that row is the
        // authoritative coverage record: the retry path must not be able to remove it.
        it('cannot withdraw a marker that is no longer intent-only', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.markers.push({ network: 'regtest', window_start: start, window_end: now,
                                  row_count: 3, status: 'landed', txid: 'dogetxid' });
            let p = makeScriptedPublisher(hub, []);

            await p._clearIntent(start);

            expect(hub.db.marker(start).status).to.equal('landed');
            expect(hub.db.marker(start).txid).to.equal('dogetxid');
        });

        // A crash marker is a genuinely unknown outcome and stays quarantined across a
        // restart: the retry path must not have widened what _hydrateMarkers admits.
        it('still quarantines a genuine intent-only crash marker after a restart', async function () {
            let hub = makeHub({ dir: dir });
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.markers.push({ network: 'regtest', window_start: start, window_end: now,
                                  row_count: 1, status: 'intent', txid: null });

            let p = makeScriptedPublisher(hub, []);
            let cap = captureErrors();
            try { await p._hydrateMarkers(); } finally { cap.restore(); }

            expect(p._quarantined.has(start)).to.equal(true);
            expect(cap.lines.filter(l => /publish-intent marker with no outcome/.test(l)).length).to.equal(1);

            p._floorWindow = start;
            await p.sweep(now);
            expect(p.wires.length).to.equal(0);
        });
    });

    // ------------------------------------------------------------ membership

    // Which rows a window holds is decided by the SIGNED effective time, never by the
    // per-hub `finalized_at` wall clock the schema allows two hubs to disagree on. The
    // cases below are the two a reading cannot settle: that two hubs stamping one row
    // hours apart still agree on its window, and that the bounds are half-open.
    describe('window membership', function () {

        it('puts one row in the same window on two hubs whose finalized_at disagree', async function () {
            let ids  = [ValidatorIdentity.generate(), ValidatorIdentity.generate(), ValidatorIdentity.generate()];
            let now   = 200 * WINDOW_S;
            let start = now - WINDOW_S;

            // One logical row, a second before the boundary, stamped by two hubs on
            // opposite sides of it: hub A finalized it inside the window, hub B's clock
            // put its copy in the NEXT one. Its signed effective time is identical.
            let base = makeRow({ effective_time: now - 1 });
            let hubA = makeHub({ dir: dir, identities: ids });
            let hubB = makeHub({ dir: dir, identities: [ids[1], ids[0], ids[2]] });
            hubA.db.responses.push(Object.assign({}, base, { finalized_at: start + 2 }));
            hubB.db.responses.push(Object.assign({}, base, { finalized_at: now + 3 }));

            let proposals = [];
            hubA.peerManager = { on(){}, removeListener(){},
                broadcast(type, data){ if(type === AttestationBatchPublisher.XATTESTB_SIGN_REQ) proposals.push(data); } };
            let sentByB = [];
            hubB.peerManager = { on(){}, removeListener(){}, broadcast(type, data){ sentByB.push({ type, data }); } };

            let pA = makePublisher(hubA), pB = makePublisher(hubB);
            let rowsA = await pA._selectWindowRows(start, now);
            let rowsB = await pB._selectWindowRows(start, now);
            expect(rowsA.length, 'hub A must hold the boundary row for this window').to.equal(1);
            expect(rowsB.length, 'hub B must hold the SAME row for the SAME window').to.equal(1);
            expect(rowsA).to.deep.equal(rowsB);

            // The same rows means the same batch key, which is what two hubs have to
            // agree on before either can co-sign the other's proposal.
            let windowOf = (rows) => ({ network: 'regtest', window_start: start, window_end: now,
                                        row_count: rows.length, btc_block_height: ANCHOR, rows: rows });
            expect(abw.computeBatchKey(windowOf(rowsA))).to.equal(abw.computeBatchKey(windowOf(rowsB)));

            // And the agreement is real, not arithmetic: B co-signs A's actual proposal.
            pA._floorWindow = start;
            await pA._publishWindow(start, 4);
            expect(proposals.length, 'hub A must have proposed the window').to.equal(1);
            await pB._handleSignReq({
                type: AttestationBatchPublisher.XATTESTB_SIGN_REQ,
                sig_pubkey: hubA._identity.getPubkeyHex().toLowerCase(),
                data: proposals[0]
            });
            expect(pB.stats.signRefusals, 'hub B must not refuse a window it holds the same rows for').to.equal(0);
            expect(sentByB.length).to.equal(1);
            expect(sentByB[0].type).to.equal(AttestationBatchPublisher.XATTESTB_SIGN);
        });

        it('takes a row at window_start and leaves one at exactly window_end to the next window', async function () {
            let hub = makeHub({ dir: dir });
            let now   = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            let first = makeRow({ effective_time: start });          // the inclusive lower bound
            let edge  = makeRow({ effective_time: now });            // the EXCLUSIVE upper bound
            hub.db.responses.push(first, edge);

            let p = makePublisher(hub);
            p._floorWindow = start;
            await p.sweep(now);

            let head = decodeHead(p.wires[0]);
            expect(head.windowEnd).to.equal(now);
            expect(head.rowCount, 'window_end is exclusive').to.equal(1);
            let body = abw.reassembleAttestBatch(head, []);
            expect(body.batch.rows[0].request_id).to.equal(first.request_id);

            // The boundary row is not dropped: it rides the NEXT window, exactly once.
            await p.sweep(now + WINDOW_S);
            let next = decodeHead(p.wires[1]);
            expect(next.windowStart).to.equal(now);
            expect(next.rowCount).to.equal(1);
            expect(abw.reassembleAttestBatch(next, []).batch.rows[0].request_id).to.equal(edge.request_id);
        });
    });

    // ------------------------------------------------------------ the quorum

    describe('the batch quorum', function () {

        // Three validators on a bus. The two followers co-sign only when `answering` is
        // true, which is how the same window is driven through a failed round and then a
        // successful one without changing a single row.
        function federation(hub, followers, state){
            return {
                on(){}, removeListener(){},
                broadcast(type, data){
                    if(type !== AttestationBatchPublisher.XATTESTB_SIGN_REQ) return;
                    if(!state.answering) return;
                    state.proposals.push(JSON.stringify(data));
                    let canonical = abw.buildAttestBatchCanonical({
                        network: data.network, window_start: data.window_start,
                        window_end: data.window_end, row_count: data.row_count,
                        btc_block_height: data.btc_block_height, rows: data.rows
                    });
                    for (let f of followers) {
                        // The follower's own payload shape, window bounds included: a
                        // co-signature that did not name its window would be counted into
                        // whatever round happened to be open.
                        state.publisher._handleSign({
                            type: AttestationBatchPublisher.XATTESTB_SIGN,
                            data: { network: data.network, window_start: data.window_start,
                                    window_end: data.window_end,
                                    pubkey: f.getPubkeyHex().toLowerCase(), sig: f.sign(canonical) }
                        }).catch(() => {});
                    }
                }
            };
        }

        it('leaves a quorum-less window unpublished and retries it with byte-identical content', async function () {
            let ids = [ValidatorIdentity.generate(), ValidatorIdentity.generate(), ValidatorIdentity.generate()];
            let state = { answering: false, proposals: [], publisher: null };
            let followers = [new ValidatorIdentity(ids[1].privkeyHex), new ValidatorIdentity(ids[2].privkeyHex)];
            let hub = makeHub({ dir: dir, identities: ids });
            hub.peerManager = federation(hub, followers, state);

            let p = makePublisher(hub);
            state.publisher = p;
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            hub.db.responses.push(makeRow({ effective_time: start + 1 }));
            p._floorWindow = start;

            // Driven at an age past every rank so the election is not what decides this
            // case; the election has its own test below.
            // Nobody answers: the round times out, nothing is published, and NO marker is
            // written, which is what makes the retry possible at all.
            await p._publishWindow(start, 4);
            expect(p.wires.length).to.equal(0);
            expect(p.stats.signTimeouts).to.equal(1);
            expect(hub.db.marker(start)).to.equal(null);

            // Same window, same rows, one window later: the proposal must be the same
            // bytes, because a batch rebuilt differently is a batch the earlier
            // signatures could never have covered.
            state.answering = true;
            let firstProposal = null;
            hub.peerManager.broadcast = ((orig) => function (type, data) {
                if (type === AttestationBatchPublisher.XATTESTB_SIGN_REQ && firstProposal === null)
                    firstProposal = JSON.stringify(data);
                return orig.call(this, type, data);
            })(hub.peerManager.broadcast);

            await p._publishWindow(start, 4);

            expect(p.wires.length, 'the retried window must publish').to.equal(1);
            let head = decodeHead(p.wires[0]);
            expect(head.windowStart).to.equal(start);
            expect(head.rowCount).to.equal(1);
            // The proposal the round timed out on and the one it published from are the
            // same window bytes.
            expect(JSON.parse(firstProposal).window_start).to.equal(start);
            let body = abw.reassembleAttestBatch(head, []);
            expect(body.ok, body.status).to.equal(true);
            expect(body.batch.sigs.length).to.be.at.least(2);
        });

        it('signs with the attestation set at the anchor, and the wire carries verifying signatures', async function () {
            let ids = [ValidatorIdentity.generate(), ValidatorIdentity.generate(), ValidatorIdentity.generate()];
            let state = { answering: true, proposals: [], publisher: null };
            let followers = [new ValidatorIdentity(ids[1].privkeyHex), new ValidatorIdentity(ids[2].privkeyHex)];
            let hub = makeHub({ dir: dir, identities: ids });
            hub.peerManager = federation(hub, followers, state);
            let p = makePublisher(hub);
            state.publisher = p;
            let now = 200 * WINDOW_S;
            p._floorWindow = now - WINDOW_S;
            hub.db.responses.push(makeRow({ effective_time: now - WINDOW_S + 1 }));

            await p._publishWindow(now - WINDOW_S, 4);

            // A co-signature naming a DIFFERENT window is not counted, even though it
            // carries a real signature from a real member of the set.
            await p._handleSign({
                type: AttestationBatchPublisher.XATTESTB_SIGN,
                data: { network: 'regtest', window_start: 1, window_end: 2,
                        pubkey: followers[0].getPubkeyHex().toLowerCase(), sig: 'ab'.repeat(64) }
            });

            let body = abw.reassembleAttestBatch(decodeHead(p.wires[0]), []);
            let canonical = abw.buildAttestBatchCanonical(body.batch);
            let qualified = new Set(hub._snapshot.validators.map(v => v.pubkey));
            for (let s of body.batch.sigs) {
                expect(qualified.has(s.pubkey), 'signer ' + s.pubkey.substring(0, 8) + ' is not in the set').to.equal(true);
                expect(ValidatorIdentity.verify(canonical, s.sig, s.pubkey),
                    'a carried signature does not verify over the batch canonical').to.equal(true);
            }
        });

        it('refuses to co-sign a window it cannot rebuild from its own rows', async function () {
            let hub = makeHub({ dir: dir });
            let sent = [];
            hub.peerManager = { on(){}, removeListener(){}, broadcast(type, data){ sent.push({ type, data }); } };
            let p = makePublisher(hub);
            let start = 200 * WINDOW_S;
            let mine  = makeRow({ effective_time: start + 5 });
            hub.db.responses.push(mine);

            let proposal = (rows) => ({
                type: AttestationBatchPublisher.XATTESTB_SIGN_REQ,
                sig_pubkey: 'ff'.repeat(32),
                data: { network: 'regtest', window_start: start, window_end: start + WINDOW_S,
                        row_count: rows.length, btc_block_height: ANCHOR, rows: rows }
            });
            let wireRow = (r) => {
                let out = {};
                for (let f of abw.ATTEST_BATCH_ROW_FIELDS) out[f] = r[f];
                return out;
            };

            // An invented row, an altered row, and a row silently dropped from the window.
            await p._handleSignReq(proposal([wireRow(makeRow({ effective_time: start + 1 }))]));
            await p._handleSignReq(proposal([Object.assign(wireRow(mine), { response_payload: 'tampered' })]));
            await p._handleSignReq(proposal([]));
            expect(sent.length, 'every refusal must be silent on the wire').to.equal(0);
            expect(p.stats.signRefusals).to.equal(3);
            // None of these three is the missing-chain-tip shape, so the dedicated
            // class must stay at zero rather than absorbing unrelated refusals.
            expect(p.stats.signRefusalsNoChainTip).to.equal(0);

            // The honest proposal is co-signed.
            await p._handleSignReq(proposal([wireRow(mine)]));
            expect(sent.length).to.equal(1);
            expect(sent[0].type).to.equal(AttestationBatchPublisher.XATTESTB_SIGN);
        });

        it('bounds a proposed anchor instead of re-deriving it', async function () {
            let hub = makeHub({ dir: dir });
            let sent = [];
            hub.peerManager = { on(){}, removeListener(){}, broadcast(type, data){ sent.push({ type, data }); } };
            let p = makePublisher(hub);
            let start = 200 * WINDOW_S;

            let at = async (anchor) => {
                sent.length = 0;
                await p._handleSignReq({
                    type: AttestationBatchPublisher.XATTESTB_SIGN_REQ,
                    sig_pubkey: 'ff'.repeat(32),
                    data: { network: 'regtest', window_start: start, window_end: start + WINDOW_S,
                            row_count: 0, btc_block_height: anchor, rows: [] }
                });
                return sent.length === 1;
            };

            expect(await at(ANCHOR), 'this hub\'s own tip must be signable').to.equal(true);
            expect(await at(ANCHOR - AttestationBatchPublisher.ANCHOR_MAX_LAG_BLOCKS), 'the oldest admissible anchor').to.equal(true);
            expect(await at(ANCHOR + 1), 'an anchor above this hub\'s tip is refused').to.equal(false);
            expect(await at(ANCHOR - AttestationBatchPublisher.ANCHOR_MAX_LAG_BLOCKS - 1), 'too far back').to.equal(false);
        });

        it('counts a missing chain tip as its own refusal class, not the generic bound', async function () {
            let hub = makeHub({ dir: dir });
            let sent = [];
            hub.peerManager = { on(){}, removeListener(){}, broadcast(type, data){ sent.push({ type, data }); } };
            let p = makePublisher(hub);
            let start = 200 * WINDOW_S;
            hub.db.setTip(null);   // no chain_tips row for this network at all

            await p._handleSignReq({
                type: AttestationBatchPublisher.XATTESTB_SIGN_REQ,
                sig_pubkey: 'ff'.repeat(32),
                data: { network: 'regtest', window_start: start, window_end: start + WINDOW_S,
                        row_count: 0, btc_block_height: ANCHOR, rows: [] }
            });

            expect(sent.length, 'a refusal is silent on the wire').to.equal(0);
            expect(p.stats.signRefusals).to.equal(1);
            expect(p.stats.signRefusalsNoChainTip).to.equal(1);
        });

        // The follower half of the same gap: a hub with no chain_tips row refused every
        // proposal, so a federation sharing one Bitcoin indexer could never reach the
        // batch quorum. With the poll-observed tip it bounds the proposal like any
        // other follower, and the bound is still enforced against that tip.
        it('co-signs from the observed tip when no chain tip was pushed, and still bounds the anchor', async function () {
            let hub = makeHub({ dir: dir });
            let sent = [];
            hub.peerManager = { on(){}, removeListener(){}, broadcast(type, data){ sent.push({ type, data }); } };
            hub.db.setTip(null);
            hub.getAttestationRound = () => ({
                getObservedBtcTip: () => ({ blockHeight: ANCHOR, observedAt: Date.now() })
            });
            let p = makePublisher(hub);
            let start = 200 * WINDOW_S;

            let at = async (anchor) => {
                sent.length = 0;
                await p._handleSignReq({
                    type: AttestationBatchPublisher.XATTESTB_SIGN_REQ,
                    sig_pubkey: 'ff'.repeat(32),
                    data: { network: 'regtest', window_start: start, window_end: start + WINDOW_S,
                            row_count: 0, btc_block_height: anchor, rows: [] }
                });
                return sent.length === 1;
            };

            expect(await at(ANCHOR), 'the observed tip must be signable').to.equal(true);
            expect(await at(ANCHOR + 1), 'an anchor above the observed tip is refused').to.equal(false);
            expect(p.stats.signRefusalsNoChainTip, 'a bound refusal is not the missing-tip class').to.equal(0);
        });
    });

    // ------------------------------------------------------------ the election

    describe('the publisher election', function () {

        it('defers a window until this hub\'s rank comes up', async function () {
            // A five-member set: this hub leads only the windows its own hash order wins,
            // and picks up the others one window later per rank.
            let ids = [ValidatorIdentity.generate(), ValidatorIdentity.generate(), ValidatorIdentity.generate(),
                       ValidatorIdentity.generate(), ValidatorIdentity.generate()];
            let hub = makeHub({ dir: dir, identities: ids });
            let p   = makePublisher(hub);
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;
            let window = { network: 'regtest', window_start: start, window_end: now,
                           row_count: 0, btc_block_height: ANCHOR, rows: [] };
            let rank = (await p._electionRank(ANCHOR, abw.computeBatchKey(window))).rank;
            expect(rank).to.be.at.least(0).and.below(5);

            // One window younger than this hub's rank: not its turn.
            if (rank > 0) {
                p._floorWindow = start;
                await p._publishWindow(start, rank - 1);
                expect(p.wires.length, 'a hub must not publish before its rank comes up').to.equal(0);
            }
            // At its rank, it takes over.
            await p._publishWindow(start, rank);
            expect(p.wires.length).to.equal(1);
        });
    });

    // ------------------------------------------------------------ landing

    describe('the landed marker', function () {

        it('stops a window the federation has already landed from being published', async function () {
            let hub = makeHub({ dir: dir });
            let p   = makePublisher(hub);
            let now = 200 * WINDOW_S;
            let start = now - WINDOW_S;

            await p.recordLandedWindow(start, now, 'dogetxid', 3);
            p._floorWindow = start;
            await p.sweep(now);

            expect(p.wires.length).to.equal(0);
            expect(hub.db.marker(start).status).to.equal('landed');
        });
    });
});
