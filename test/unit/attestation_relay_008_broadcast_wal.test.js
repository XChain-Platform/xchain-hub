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

const AttestationRelay = require('../../src/attestation/relay.js');
const eq               = require('../../src/equivocation_header.js');
const rejectSlot       = require('../../src/attest_relay_reject_slot_activation.js');

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

let dir;

const hookAt55319 = function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-')); };

const hookAt55419 = function () { fs.rmSync(dir, { recursive: true, force: true }); };

function relayWithWal(lines) {
            const wal = path.join(dir, 'relay.jsonl');
            if (lines) fs.writeFileSync(wal, lines.map(JSON.stringify).join('\n') + '\n');
            process.env.ATTEST_RELAY_QUEUE_PATH = wal;
            const relay = new AttestationRelay(makeHub());
            relay.loadWal();
            return relay;
        }

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('treats a sent record as relayed', function () {
            expect(relayWithWal([{ rid: REQ_ID, phase: 'intent' }, { rid: REQ_ID, phase: 'sent', txid: 'ab' }])
                ._published.has(REQ_ID)).to.equal(true);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('treats a crash between intent and outcome as SENT', function () {
            // Fail closed toward not spending: a duplicate v3 burns a real BTC fee for
            // an action the indexer rejects, while a missed relay merely lets the
            // origin request expire on its own deadline.
            expect(relayWithWal([{ rid: REQ_ID, phase: 'intent' }])._published.has(REQ_ID)).to.equal(true);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('leaves a definitively failed broadcast retryable', function () {
            expect(relayWithWal([{ rid: REQ_ID, phase: 'intent' }, { rid: REQ_ID, phase: 'failed' }])
                ._published.has(REQ_ID)).to.equal(false);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('keeps a sent record sticky against a later failed record', function () {
            expect(relayWithWal([{ rid: REQ_ID, phase: 'sent' }, { rid: REQ_ID, phase: 'failed' }])
                ._published.has(REQ_ID)).to.equal(true);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('survives a truncated or corrupt line', function () {
            const wal = path.join(dir, 'relay.jsonl');
            fs.writeFileSync(wal, '{"rid":"' + REQ_ID + '","phase":"sent"}\n{not json\n');
            process.env.ATTEST_RELAY_QUEUE_PATH = wal;
            const relay = new AttestationRelay(makeHub());
            relay.loadWal();
            expect(relay._published.has(REQ_ID)).to.equal(true);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('starts clean when no WAL exists yet', function () {
            process.env.ATTEST_RELAY_QUEUE_PATH = path.join(dir, 'absent.jsonl');
            const relay = new AttestationRelay(makeHub());
            relay.loadWal();
            expect(relay._published.size).to.equal(0);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('keys on (request_id, leg) so one request can relay both legs', function () {
            // Idempotency is per leg: one request legitimately gets one v3 AND one v4.
            const relay = relayWithWal([{ rid: REQ_ID, leg: 'request', phase: 'sent' }]);
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(false);

            const both = relayWithWal([
                { rid: REQ_ID, leg: 'request',  phase: 'sent' },
                { rid: REQ_ID, leg: 'response', phase: 'sent' },
            ]);
            expect(both._published.has(REQ_ID)).to.equal(true);
            expect(both._publishedResponses.has(REQ_ID)).to.equal(true);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('reads a leg-less record written before the response leg existed as a request-leg record', function () {
            const relay = relayWithWal([{ rid: REQ_ID, phase: 'sent' }]);
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(false);
        }); }); });

// ── 6. Durable at-most-once ─────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast WAL', function () { beforeEach(hookAt55319); afterEach(hookAt55419); it('keeps a failed response record retryable without touching the request leg', function () {
            const relay = relayWithWal([
                { rid: REQ_ID, leg: 'request',  phase: 'sent' },
                { rid: REQ_ID, leg: 'response', phase: 'intent' },
                { rid: REQ_ID, leg: 'response', phase: 'failed' },
            ]);
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(false);
        }); }); });
}
