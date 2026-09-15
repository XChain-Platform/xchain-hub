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
 * AttestationRelay (request leg / response leg): the hub half of the
 * §12 cross-chain relay.
 *
 * What these protect, in priority order:
 *   1. THE CANONICAL. The hub signs bytes an indexer must reproduce exactly. A
 *      one-byte drift is silent: signatures simply never verify and every peer's
 *      v3 or v4 is dropped as unquorate. Pinned as goldens here AND cross-checked
 *      against the indexer's own implementation when the sibling repo is present.
 *   2. INERTNESS. Off unless ATTEST_RELAY_ENABLED=1, and below
 *      ATTEST_RELAY_ACTIVATION nothing is proposed or broadcast, so a deployed
 *      but unarmed fleet behaves exactly as it did before activation.
 *   3. NO DOUBLE SPEND. A v3 that already exists on BTC and a v4 for a request the
 *      origin has already closed are both rejected on-chain, so re-broadcasting
 *      either only burns a real fee.
 *   4. THE RESPONSE LEG SETTLES. A v4 is the only leg that irreversibly closes an
 *      origin request, releases its escrow and fires a contract callback, so what a
 *      peer re-verifies before co-signing one is held to a higher bar than the
 *      request leg: both ends, from its own indexers, never the leader's claim.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const crypto     = require('crypto');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

const AttestationRelay = require('../../../../src/attestation/relay.js');
const eq               = require('../../../../src/equivocation_header.js');
const rejectSlot       = require('../../../../src/attest_relay_reject_slot_activation.js');

const REQ_ID    = 'd'.repeat(64);
const PUBKEY_A  = 'a'.repeat(64);
const PUBKEY_B  = 'b'.repeat(64);
const SIG_A     = '1'.repeat(128);
const sha256    = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// The origin indexer's getpendingattestation_requests row shape, matching the
// column list xchain-indexer/src/db/index.js::getPendingAttestationRequests selects.
function originRow(overrides = {}) {
    return {
        action_index:         4242,
        request_id:           REQ_ID,
        contract_index:       5,
        provider_id:          'http_get',
        payload:              'https://example.com/score',
        callback_method:      'onResult',
        callback_params_json: '[]',
        redundancy:           3,
        deadline_block:       3160010,
        block_index:          3160000,
        origin_chain:         'LTC',
        origin_action_index:  null,
        request_status:       'pending',
        ...overrides,
    };
}

function makeHub(overrides = {}) {
    return {
        db:        { doQuery: sinon.stub().resolves([]) },
        network:   'regtest',
        p2pConfig: {},
        hubDbBroadcaster: null,
        capabilitySnapshot: {
            getSnapshot:       sinon.stub().resolves({ validators: [{ pubkey: PUBKEY_A, amount: '100' }] }),
            getWeightSnapshot: sinon.stub().resolves({ validators: [{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }] }),
        },
        getPeerManager: () => ({}),
        getIdentity:    () => ({ getPubkeyHex: () => PUBKEY_A, sign: () => SIG_A }),
        resolveBtcLatestBlock: sinon.stub().resolves(1000),
        resolveIndexerUrl:     sinon.stub().resolves('http://127.0.0.1:1/'),
        ...overrides,
    };
}

// The home indexer's getrelayedattestation_requests row shape: a BTC request row
// materialized from an LTC origin, with its terminal response attached. Column names
// match xchain-indexer/src/db/index.js::getRelayedAttestationRequests.
const RESPONSE_BODY = '{"score":42}';
function homeRelayedRow(overrides = {}) {
    return {
        action_index:          9001,          // the BTC v3-materialized request
        block_index:           940,
        request_id:            REQ_ID,
        provider_id:           'http_get',
        origin_chain:          'LTC',
        origin_action_index:   4242,
        request_status:        'fulfilled',
        response_action_index: 9002,          // the BTC v1 that fulfilled it
        response_block_index:  980,
        response_hash:         crypto.createHash('sha256').update(Buffer.from(RESPONSE_BODY, 'utf8')).digest('hex'),
        response_payload:      RESPONSE_BODY,
        response_status:       'ok',
        meta:                  '200',
        ...overrides,
    };
}

// A relay wired for the happy path: every indexer reachable, one pending LTC
// request, nothing yet on BTC. Consensus is stubbed so the tests observe what
// WOULD be proposed without running a real PBFT round. `homeRows` drives the
// relayed-requests read that feeds the response leg; empty by default so the
// request-leg tests run against a clean world.
function makeRelay(hubOverrides = {}, rows = [originRow()], homeRows = []) {
    const relay = new AttestationRelay(makeHub(hubOverrides));
    for (const coin of Object.keys(relay.indexers)) relay.indexers[coin].url = 'http://127.0.0.1:1/';
    relay.indexerCall = sinon.stub().callsFake(async (coin, method, params) => {
        if (coin === 'BTC' && method === 'getrelayedattestation_requests') {
            const filtered = params && params.request_id
                ? homeRows.filter(r => r.request_id === params.request_id)
                : homeRows;
            return { latest_block_index: 1000, requests: filtered };
        }
        if (coin === 'BTC')  return { latest_block_index: 1000, requests: [] };
        if (coin === 'LTC')  return { latest_block_index: 3160099, requests: rows };
        return { latest_block_index: 0, requests: [] };
    });
    relay.consensus.propose = sinon.stub().resolves();
    return relay;
}

// Rows proposed to consensus for one leg, in call order.
function proposedRows(relay, phase) {
    return relay.consensus.propose.getCalls()
        .map(c => c.args[1].row)
        .filter(r => r.phase === phase);
}

{
let envSnapshot;

const hookAt6668 = function () {
        envSnapshot = { ...process.env };
        delete process.env.ATTEST_RELAY_ENABLED;
        delete process.env.ATTEST_RELAY_QUEUE_PATH;
    };

const hookAt6849 = function () {
        process.env = envSnapshot;
        sinon.restore();
    };

const DEADLINE = originRow().deadline_block;

// absolute, on the LTC origin
        const OTHER_ID = 'e'.repeat(64);

let dir;

const hookAt75731 = function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-ev-'));
            process.env.ATTEST_RELAY_QUEUE_PATH = path.join(dir, 'relay.jsonl');
        };

const hookAt75935 = function () { fs.rmSync(dir, { recursive: true, force: true }); };

function walLines() {
            return fs.readFileSync(process.env.ATTEST_RELAY_QUEUE_PATH, 'utf8')
                .split('\n').filter(Boolean).map(JSON.parse);
        }

function writeWal(records) {
            fs.writeFileSync(process.env.ATTEST_RELAY_QUEUE_PATH,
                records.map(r => JSON.stringify(r)).join('\n') + '\n');
        }

// ── 8. Deadline-anchored eviction and WAL compaction ──────────
    //
    // Both idempotency sets and the WAL behind them once grew for the process
    // lifetime. The bound the operator ruled for on 2026-08-11 (proposal A) anchors on
    // the ORIGIN request's own absolute deadline_block, which the response leg does not
    // otherwise have: the home chain's relayed row carries only the RELATIVE count the
    // v3 put on BTC. What these protect:
    //   - the record shape: the deadline is threaded onto the response round row and
    //     re-derived by followers, and it must stay OUT of the signed canonical, which
    //     has to keep byte-matching the indexer's;
    //   - the safety of forgetting: a leg is evicted only past a horizon that both
    //     re-entry paths also refuse, so a forgotten key can never fund a second
    //     broadcast;
    //   - the crash controls: a lost or half-written WAL must always fail toward
    //     suppressing a broadcast, never toward re-spending.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('rewrites the WAL to one record per surviving key, keeping the txid', function () {
            writeWal([
                { rid: REQ_ID,   leg: 'request',  phase: 'intent', deadline_chain: 'LTC', deadline_block: DEADLINE },
                { rid: REQ_ID,   leg: 'request',  phase: 'sent', txid: 'aa', deadline_chain: 'LTC', deadline_block: DEADLINE },
                { rid: REQ_ID,   leg: 'response', phase: 'intent', deadline_chain: 'LTC', deadline_block: DEADLINE },
                { rid: REQ_ID,   leg: 'response', phase: 'sent', txid: 'bb', deadline_chain: 'LTC', deadline_block: DEADLINE },
                { rid: OTHER_ID, leg: 'request',  phase: 'sent', txid: 'cc', deadline_chain: 'LTC', deadline_block: DEADLINE + 100000 },
                { rid: OTHER_ID, leg: 'request',  phase: 'failed' },
            ]);
            const relay = new AttestationRelay(makeHub());
            relay.loadWal();
            expect(relay._published.size).to.equal(2);

            relay._originLatest.LTC = DEADLINE + 5000;   // buries REQ_ID, not OTHER_ID
            expect(relay.evictExpired()).to.equal(1);

            const lines = walLines();
            expect(lines).to.have.length(1);
            expect(lines[0]).to.include({ rid: OTHER_ID, leg: 'request', phase: 'sent', txid: 'cc', compacted: true });
            expect(relay.getStats().wal_compactions).to.equal(1);

            // The restart must agree: one leg still suppressed, the evicted one gone.
            const restarted = new AttestationRelay(makeHub());
            restarted.loadWal();
            expect(restarted._published.has(OTHER_ID)).to.equal(true);
            expect(restarted._published.has(REQ_ID)).to.equal(false);
            expect(restarted._publishedResponses.has(REQ_ID)).to.equal(false);
            expect(restarted._deadlines.get(OTHER_ID)).to.deep.equal({ coin: 'LTC', block: DEADLINE + 100000 });
        }); }); });

// ── 8. Deadline-anchored eviction and WAL compaction ──────────
    //
    // Both idempotency sets and the WAL behind them once grew for the process
    // lifetime. The bound the operator ruled for on 2026-08-11 (proposal A) anchors on
    // the ORIGIN request's own absolute deadline_block, which the response leg does not
    // otherwise have: the home chain's relayed row carries only the RELATIVE count the
    // v3 put on BTC. What these protect:
    //   - the record shape: the deadline is threaded onto the response round row and
    //     re-derived by followers, and it must stay OUT of the signed canonical, which
    //     has to keep byte-matching the indexer's;
    //   - the safety of forgetting: a leg is evicted only past a horizon that both
    //     re-entry paths also refuse, so a forgotten key can never fund a second
    //     broadcast;
    //   - the crash controls: a lost or half-written WAL must always fail toward
    //     suppressing a broadcast, never toward re-spending.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('re-synthesizes a record for a published key whose WAL line was LOST', function () {
            // The forced lost-record control: a crash (or a truncated write) that drops
            // the line for a key this process holds as published must not let compaction
            // turn that loss into a re-broadcast. The rewrite puts the key back.
            writeWal([
                { rid: REQ_ID, leg: 'request', phase: 'sent', txid: 'aa',
                  deadline_chain: 'LTC', deadline_block: DEADLINE },
            ]);
            const relay = new AttestationRelay(makeHub());
            relay.loadWal();
            relay._publishedResponses.mark(OTHER_ID);              // held in memory, no line on disk
            relay.noteDeadline('LTC', OTHER_ID, DEADLINE + 100000);

            relay._originLatest.LTC = DEADLINE + 5000;
            expect(relay.evictExpired()).to.equal(1);

            const lines = walLines();
            expect(lines).to.have.length(1);
            expect(lines[0]).to.include({ rid: OTHER_ID, leg: 'response', phase: 'sent', synthesized: true });

            const restarted = new AttestationRelay(makeHub());
            restarted.loadWal();
            expect(restarted._publishedResponses.has(OTHER_ID)).to.equal(true);
        }); }); });

// ── 8. Deadline-anchored eviction and WAL compaction ──────────
    //
    // Both idempotency sets and the WAL behind them once grew for the process
    // lifetime. The bound the operator ruled for on 2026-08-11 (proposal A) anchors on
    // the ORIGIN request's own absolute deadline_block, which the response leg does not
    // otherwise have: the home chain's relayed row carries only the RELATIVE count the
    // v3 put on BTC. What these protect:
    //   - the record shape: the deadline is threaded onto the response round row and
    //     re-derived by followers, and it must stay OUT of the signed canonical, which
    //     has to keep byte-matching the indexer's;
    //   - the safety of forgetting: a leg is evicted only past a horizon that both
    //     re-entry paths also refuse, so a forgotten key can never fund a second
    //     broadcast;
    //   - the crash controls: a lost or half-written WAL must always fail toward
    //     suppressing a broadcast, never toward re-spending.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('leaves the uncompacted WAL standing when the rewrite fails mid-crash', function () {
            // A failed compaction must fail toward the FULLER file: the restart then
            // re-learns the keys and holds them another window, which costs retention.
            // Losing them would cost a duplicate broadcast, and a real fee.
            writeWal([
                { rid: REQ_ID,   leg: 'request', phase: 'sent', txid: 'aa', deadline_chain: 'LTC', deadline_block: DEADLINE },
                { rid: OTHER_ID, leg: 'request', phase: 'sent', txid: 'cc', deadline_chain: 'LTC', deadline_block: DEADLINE + 100000 },
            ]);
            const relay = new AttestationRelay(makeHub());
            relay.loadWal();
            sinon.stub(fs, 'renameSync').throws(Object.assign(new Error('EIO'), { code: 'EIO' }));

            relay._originLatest.LTC = DEADLINE + 5000;
            expect(relay.evictExpired()).to.equal(1);
            expect(relay._walFailures).to.equal(1);
            expect(relay.getStats().wal_compactions).to.equal(0);

            sinon.restore();
            expect(walLines()).to.have.length(2);                       // untouched
            expect(fs.existsSync(process.env.ATTEST_RELAY_QUEUE_PATH + '.compact')).to.equal(false);

            const restarted = new AttestationRelay(makeHub());
            restarted.loadWal();
            expect(restarted._published.has(REQ_ID)).to.equal(true);    // suppression survives
        }); }); });

// ── 8. Deadline-anchored eviction and WAL compaction ──────────
    //
    // Both idempotency sets and the WAL behind them once grew for the process
    // lifetime. The bound the operator ruled for on 2026-08-11 (proposal A) anchors on
    // the ORIGIN request's own absolute deadline_block, which the response leg does not
    // otherwise have: the home chain's relayed row carries only the RELATIVE count the
    // v3 put on BTC. What these protect:
    //   - the record shape: the deadline is threaded onto the response round row and
    //     re-derived by followers, and it must stay OUT of the signed canonical, which
    //     has to keep byte-matching the indexer's;
    //   - the safety of forgetting: a leg is evicted only past a horizon that both
    //     re-entry paths also refuse, so a forgotten key can never fund a second
    //     broadcast;
    //   - the crash controls: a lost or half-written WAL must always fail toward
    //     suppressing a broadcast, never toward re-spending.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('compacts nothing when there is no WAL on disk yet', function () {
            const relay = new AttestationRelay(makeHub());
            expect(relay.compactWal('startup')).to.equal(false);
            expect(fs.existsSync(process.env.ATTEST_RELAY_QUEUE_PATH)).to.equal(false);
        }); }); });

// ── 8. Deadline-anchored eviction and WAL compaction ──────────
    //
    // Both idempotency sets and the WAL behind them once grew for the process
    // lifetime. The bound the operator ruled for on 2026-08-11 (proposal A) anchors on
    // the ORIGIN request's own absolute deadline_block, which the response leg does not
    // otherwise have: the home chain's relayed row carries only the RELATIVE count the
    // v3 put on BTC. What these protect:
    //   - the record shape: the deadline is threaded onto the response round row and
    //     re-derived by followers, and it must stay OUT of the signed canonical, which
    //     has to keep byte-matching the indexer's;
    //   - the safety of forgetting: a leg is evicted only past a horizon that both
    //     re-entry paths also refuse, so a forgotten key can never fund a second
    //     broadcast;
    //   - the crash controls: a lost or half-written WAL must always fail toward
    //     suppressing a broadcast, never toward re-spending.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('empties the WAL when every key it held has been evicted', function () {
            writeWal([
                { rid: REQ_ID, leg: 'request',  phase: 'sent', txid: 'aa', deadline_chain: 'LTC', deadline_block: DEADLINE },
                { rid: REQ_ID, leg: 'response', phase: 'sent', txid: 'bb', deadline_chain: 'LTC', deadline_block: DEADLINE },
            ]);
            const relay = new AttestationRelay(makeHub());
            relay.loadWal();
            relay._originLatest.LTC = DEADLINE + 5000;
            relay.evictExpired();
            expect(walLines()).to.have.length(0);
            expect(relay.loadWal()).to.deep.equal({ records: 0, keys: 0 });
        }); }); });
}
