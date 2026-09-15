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

const BODY_B64  = Buffer.from(RESPONSE_BODY, 'utf8').toString('base64');

const BODY_HASH = crypto.createHash('sha256').update(Buffer.from(RESPONSE_BODY, 'utf8')).digest('hex');

function responseRow(overrides = {}) {
            return {
                round_id:                   sha256('ATTESTRELAYROUND|response|' + REQ_ID),
                request_id:                 REQ_ID,
                phase:                      'response',
                snapshot_block:             1000,
                network:                    'regtest',
                origin_chain:               'LTC',
                home_response_action_index: 9002,
                provider_id:                'http_get',
                response_hash:              BODY_HASH,
                response_payload_b64:       BODY_B64,
                status:                     'ok',
                meta:                       '200',
                ...overrides,
            };
        }

// Both ends reachable and agreeing: the origin still waiting, BTC holding the
        // terminal response the row names.
        function relayForResponse(homeOverrides = {}, originRows = [originRow()]) {
            return makeRelay({}, originRows, [homeRelayedRow(homeOverrides)]);
        }

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('accepts a row it can independently confirm at BOTH ends', async function () {
            expect(await relayForResponse().validateProposedMatch(responseRow())).to.equal(true);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses a row whose round id does not bind the response leg', async function () {
            const relay = relayForResponse();
            // The REQUEST leg's round id for the same request must not co-sign here, or
            // the two legs collide in one idempotency slot.
            expect(await relay.validateProposedMatch(responseRow({
                round_id: sha256('ATTESTRELAYROUND|request|' + REQ_ID),
            }))).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses every field the home chain does not agree with', async function () {
            const relay = relayForResponse();
            for (const bad of [
                { home_response_action_index: 9003 },
                { provider_id: 'other_provider' },
                { response_hash: 'f'.repeat(64) },
                { response_payload_b64: Buffer.from('tampered', 'utf8').toString('base64') },
                { status: 'expired' },
                { meta: '404' },
            ]) {
                expect(await relay.validateProposedMatch(responseRow(bad)),
                    'should refuse ' + JSON.stringify(bad)).to.equal(false);
            }
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses a payload whose bytes do not hash to the row hash', async function () {
            // The origin recomputes the hash from the wire payload, so a leader that
            // pairs an honest hash with a tampered body produces a canonical the
            // signatures do not cover. Refusing here fails earlier and cheaper.
            const relay = relayForResponse();
            expect(await relay.validateProposedMatch(responseRow({
                response_payload_b64: Buffer.from('other body', 'utf8').toString('base64'),
            }))).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses when its own origin indexer no longer has the request pending', async function () {
            const relay = relayForResponse({}, []);
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses when the origin request names a different provider', async function () {
            // The origin builds its canonical from ITS OWN request row's provider_id,
            // so a mismatch signs bytes the origin will never reproduce.
            const relay = makeRelay({}, [originRow({ provider_id: 'llm' })], [homeRelayedRow()]);
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses when its own BTC indexer has no terminal response for the request', async function () {
            const relay = makeRelay({}, [originRow()], []);
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses when BTC holds the request but nothing has fulfilled it', async function () {
            const relay = relayForResponse({
                request_status: 'pending', response_action_index: null, response_block_index: null,
                response_hash: null, response_payload: null, response_status: null, meta: null,
            });
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses a response BTC has not confirmed deeply enough to settle against', async function () {
            const relay = relayForResponse({ response_block_index: 1000 });
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses a row whose origin chain disagrees with the BTC request row', async function () {
            const relay = relayForResponse({ origin_chain: 'DOGE' });
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses a stale snapshot_block, a foreign network and an unknown origin chain', async function () {
            const relay = relayForResponse();
            for (const bad of [{ snapshot_block: 100 }, { network: 'mainnet' }, { origin_chain: 'BTC' }]) {
                expect(await relay.validateProposedMatch(responseRow(bad)),
                    'should refuse ' + JSON.stringify(bad)).to.equal(false);
            }
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses below ATTEST_RELAY_ACTIVATION', async function () {
            const relay = makeRelay({ network: 'mainnet', _resolveBtcLatestBlock: sinon.stub().resolves(962999) },
                [originRow()], [homeRelayedRow()]);
            expect(await relay.validateProposedMatch(responseRow({
                network: 'mainnet', snapshot_block: 962999,
            }))).to.equal(false);
        }); }); });

// ── 4b. Follower re-verification, response leg ─────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('validateProposedMatch, response leg', function () { it('refuses when either indexer is unreachable', async function () {
            for (const down of ['BTC', 'LTC']) {
                const relay = relayForResponse();
                const good  = relay._indexerCall;
                relay._indexerCall = sinon.stub().callsFake(async (coin, method, params) => {
                    if (coin === down) throw new Error('connect ECONNREFUSED');
                    return good(coin, method, params);
                });
                expect(await relay.validateProposedMatch(responseRow()),
                    'should refuse with ' + down + ' down').to.equal(false);
            }
        }); }); });
}
