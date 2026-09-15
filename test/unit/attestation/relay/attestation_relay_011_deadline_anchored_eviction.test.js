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
        _resolveBtcLatestBlock: sinon.stub().resolves(1000),
        _resolveIndexerUrl:     sinon.stub().resolves('http://127.0.0.1:1/'),
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
    relay._indexerCall = sinon.stub().callsFake(async (coin, method, params) => {
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

let dir;

const hookAt75731 = function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-ev-'));
            process.env.ATTEST_RELAY_QUEUE_PATH = path.join(dir, 'relay.jsonl');
        };

const hookAt75935 = function () { fs.rmSync(dir, { recursive: true, force: true }); };

// A relay whose LTC indexer reports the given tip, everything else as usual.
        function relayAtTip(tip, rows = [originRow()], homeRows = []) {
            const relay = makeRelay({}, rows, homeRows);
            const inner = relay._indexerCall;
            relay._indexerCall = sinon.stub().callsFake(async (coin, method, params) => {
                const res = await inner(coin, method, params);
                if (coin === 'LTC') res.latest_block_index = tip;
                return res;
            });
            return relay;
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



        // ── the record-shape change ──────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('threads the origin absolute deadline and its chain onto the response round row', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            await relay._poll();
            const row = proposedRows(relay, 'response')[0];
            expect(row.origin_deadline_block).to.equal(DEADLINE);
            expect(row.origin_chain).to.equal('LTC');
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
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('keeps the threaded deadline out of the signed canonical and off the v4 wire', function () {
            // It is bookkeeping, not consensus. The canonical must keep byte-matching the
            // indexer's relayResponseCanonical, and the wire is parsed positionally.
            sinon.stub(eq, 'isEquivHeaderActive').returns(false);
            const relay = new AttestationRelay(makeHub());
            const base = {
                request_id: REQ_ID, snapshot_block: 963000, network: 'mainnet', origin_chain: 'LTC',
                home_response_action_index: 9002, provider_id: 'http_get',
                response_hash: 'a'.repeat(64), response_payload_b64: 'eA==', status: 'ok', meta: '200',
            };
            const withDeadline = { ...base, origin_deadline_block: DEADLINE };
            expect(relay._relayResponseCanonical(withDeadline)).to.equal(relay._relayResponseCanonical(base));
            expect(relay._buildResponseWire(withDeadline, [{ pubkey: PUBKEY_A, sig: SIG_A }]))
                .to.equal(relay._buildResponseWire(base, [{ pubkey: PUBKEY_A, sig: SIG_A }]));
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
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('re-derives the threaded deadline instead of trusting the leader', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            const responseRow = (overrides = {}) => ({
                round_id: sha256('ATTESTRELAYROUND|response|' + REQ_ID),
                request_id: REQ_ID, phase: 'response', snapshot_block: 1000, network: 'regtest',
                origin_chain: 'LTC', home_response_action_index: 9002, provider_id: 'http_get',
                response_hash: crypto.createHash('sha256').update(Buffer.from(RESPONSE_BODY, 'utf8')).digest('hex'),
                response_payload_b64: Buffer.from(RESPONSE_BODY, 'utf8').toString('base64'),
                status: 'ok', meta: '200', ...overrides,
            });

            expect(await relay.validateProposedMatch(responseRow({ origin_deadline_block: DEADLINE }))).to.equal(true);
            // A leader cannot push this node's eviction clock forward.
            expect(await relay.validateProposedMatch(responseRow({ origin_deadline_block: DEADLINE + 5000 }))).to.equal(false);
            // Absent is tolerated: an older leader must not wedge the settling leg.
            expect(await relay.validateProposedMatch(responseRow())).to.equal(true);
            // Either way this node has indexed its OWN reading.
            expect(relay._deadlines.get(REQ_ID)).to.deep.equal({ coin: 'LTC', block: DEADLINE });
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



        // ── indexing ─────────────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('indexes the deadline of a leg it has ALREADY relayed', async function () {
            // The record most in need of eviction is one already marked published, so the
            // index has to be written before the already-relayed early returns.
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            relay._published.mark(REQ_ID);
            relay._publishedResponses.mark(REQ_ID);
            await relay._poll();
            expect(relay._deadlines.get(REQ_ID)).to.deep.equal({ coin: 'LTC', block: DEADLINE });
            expect(relay.getStats().tracked_deadlines).to.equal(1);
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
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('refuses a deadline it cannot use, rather than indexing a guess', function () {
            const relay = new AttestationRelay(makeHub());
            expect(relay.noteDeadline('LTC', REQ_ID, 0)).to.equal(false);
            expect(relay.noteDeadline('LTC', REQ_ID, 'later')).to.equal(false);
            expect(relay.noteDeadline('BTC', REQ_ID, 100)).to.equal(false);   // home chain issues none
            expect(relay.noteDeadline('LTC', 'not-a-request-id', 100)).to.equal(false);
            expect(relay._deadlines.size).to.equal(0);
            expect(relay.noteDeadline('LTC', REQ_ID, DEADLINE)).to.equal(true);
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



        // ── the eviction itself ──────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('deadline-anchored eviction', function () { beforeEach(hookAt75731); afterEach(hookAt75935); it('evicts both legs once the origin has buried the deadline, and never re-relays', async function () {
            const relay = relayAtTip(DEADLINE + 5000, [originRow()], [homeRelayedRow()]);
            relay._published.mark(REQ_ID);
            relay._publishedResponses.mark(REQ_ID);

            await relay._poll();
            expect(relay._published.size).to.equal(0);
            expect(relay._publishedResponses.size).to.equal(0);
            expect(relay._deadlines.size).to.equal(0);
            expect(relay.getStats().legs_evicted).to.equal(1);

            // The whole safety argument: the row is STILL pending on the stubbed origin,
            // so without the matching horizon guard on the re-entry paths this poll would
            // propose a fresh v3 and v4 for a request it has already relayed.
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
            expect(relay._published.size).to.equal(0);
        }); }); });
}
