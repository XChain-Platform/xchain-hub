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

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('relays a confirmed terminal response back to its origin chain', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            await relay._poll();
            const rows = proposedRows(relay, 'response');
            expect(rows).to.have.length(1);
            expect(rows[0]).to.include({
                request_id:                 REQ_ID,
                phase:                      'response',
                origin_chain:               'LTC',
                home_response_action_index: 9002,
                provider_id:                'http_get',
                status:                     'ok',
                meta:                       '200',
                snapshot_block:             1000,
            });
            // The signed hash is of the DECODED bytes, matching what the origin
            // indexer recomputes from the base64 on the wire.
            expect(rows[0].response_payload_b64).to.equal(Buffer.from(RESPONSE_BODY, 'utf8').toString('base64'));
            expect(rows[0].response_hash).to.equal(
                crypto.createHash('sha256').update(Buffer.from(RESPONSE_BODY, 'utf8')).digest('hex'));
            // Both legs of one request, never one slot.
            expect(rows[0].round_id).to.equal(sha256('ATTESTRELAYROUND|response|' + REQ_ID));
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('relays a terminal expired outcome, which closes the origin request early', async function () {
            const relay = makeRelay({}, [originRow()],
                [homeRelayedRow({ response_status: 'expired', request_status: 'errored' })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')[0].status).to.equal('expired');
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('relays nothing while the request is still pending on BTC', async function () {
            const relay = makeRelay({}, [originRow()],
                [homeRelayedRow({ request_status: 'pending', response_action_index: null,
                                  response_block_index: null, response_hash: null,
                                  response_payload: null, response_status: null, meta: null })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('relays nothing once the origin no longer has the request pending', async function () {
            // The origin flips out of 'pending' exactly when a v4 lands, so this is
            // also how a PEER's broadcast retires our own work.
            const relay = makeRelay({}, [], [homeRelayedRow()]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('relays nothing when the origin pending view could not be refreshed', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            relay._indexerCall = sinon.stub().callsFake(async (coin, method) => {
                if (coin === 'BTC' && method === 'getrelayedattestation_requests')
                    return { latest_block_index: 1000, requests: [homeRelayedRow()] };
                if (coin === 'BTC') return { latest_block_index: 1000, requests: [] };
                throw new Error('connect ECONNREFUSED');
            });
            await relay._poll();
            // A view we could not read is not evidence the origin is still waiting.
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('holds a response that has not reached the BTC confirmation depth', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow({ response_block_index: 1000 })]);
            expect(relay.confirmations.BTC).to.be.greaterThan(1);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('refuses a body that does not re-encode to its own stored hash', async function () {
            // The indexer stores the UTF-8 DECODE of the bytes it hashed, so a
            // non-UTF-8 attested body cannot cross chains: base64 of the stored text
            // would deliver a MANGLED payload under a quorum signature.
            const relay = makeRelay({}, [originRow()], [homeRelayedRow({ response_hash: 'f'.repeat(64) })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('refuses a meta containing a pipe, which the positional wire cannot carry', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow({ meta: '200|spoofed' })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('relays nothing below ATTEST_RELAY_ACTIVATION', async function () {
            const relay = makeRelay(
                { network: 'mainnet', _resolveBtcLatestBlock: sinon.stub().resolves(962999) },
                [originRow()], [homeRelayedRow()]);
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('relays nothing for an origin chain it has no indexer for', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            relay.indexers.LTC.url = '';
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('refuses to propose when the two chains name different providers', async function () {
            // They agree by construction, since the v3 carried the provider from the
            // origin. A disagreement would produce a canonical the origin cannot
            // reproduce, so every peer refuses and the round wedges silently.
            const relay = makeRelay({}, [originRow({ provider_id: 'llm' })], [homeRelayedRow()]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });

// ── 3b. Response-leg discovery ─────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('home response discovery', function () { it('does not re-propose a response it has already relayed', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            relay._publishedResponses.mark(REQ_ID);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        }); }); });
}
