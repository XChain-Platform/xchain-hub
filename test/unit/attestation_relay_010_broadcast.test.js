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

const hookAt59525 = function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-bc-'));
            process.env.ATTEST_RELAY_QUEUE_PATH = path.join(dir, 'relay.jsonl');
        };

const hookAt59729 = function () { fs.rmSync(dir, { recursive: true, force: true }); };

function finalizedEvent(signatures) {
            return {
                row: {
                    round_id: sha256('ATTESTRELAYROUND|request|' + REQ_ID),
                    request_id: REQ_ID, phase: 'request', snapshot_block: 1000, network: 'regtest',
                    origin_chain: 'LTC', origin_action_index: 4242, provider_id: 'http_get',
                    request_payload: 'https://example.com/score', redundancy: 3, deadline_blocks: 10,
                },
                signatures: signatures,
                view: 0,
            };
        }

// ── the response leg's own rail ──────────────────────────────────────

        function finalizedResponseEvent(signatures) {
            return {
                row: {
                    round_id: sha256('ATTESTRELAYROUND|response|' + REQ_ID),
                    request_id: REQ_ID, phase: 'response', snapshot_block: 1000, network: 'regtest',
                    origin_chain: 'LTC', home_response_action_index: 9002, provider_id: 'http_get',
                    response_hash: crypto.createHash('sha256').update(Buffer.from(RESPONSE_BODY, 'utf8')).digest('hex'),
                    response_payload_b64: Buffer.from(RESPONSE_BODY, 'utf8').toString('base64'),
                    status: 'ok', meta: '200',
                },
                signatures: signatures,
                view: 0,
            };
        }

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('retires a retained v4 once the origin request leaves the pending set', async function () {
            const relay = new AttestationRelay(makeHub({
                getIdentity: () => ({ getPubkeyHex: () => PUBKEY_B, sign: () => SIG_A }),
            }));
            relay.setChainBroadcastHook('LTC', async () => ({ txid: 'ltc' }));
            await relay.onRoundFinalized(finalizedResponseEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(true);

            // A null view is "unknown" and must NOT retire the round.
            relay._originPending.LTC = null;
            await relay.sweepFinalized();
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(true);

            relay._originPending.LTC = new Set();   // the origin closed it: a v4 landed
            await relay.sweepFinalized();
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(false);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('steps in on the response leg only after its failover window', async function () {
            const rankOf = (pk) => sha256(REQ_ID + pk);
            const [first] = [PUBKEY_A, PUBKEY_B].sort((a, b) => (rankOf(a) < rankOf(b) ? -1 : 1));
            const other = first === PUBKEY_A ? PUBKEY_B : PUBKEY_A;

            const relay = new AttestationRelay(makeHub({
                getIdentity: () => ({ getPubkeyHex: () => other, sign: () => SIG_A }),
            }));
            const sent = [];
            relay.setChainBroadcastHook('LTC', async (p) => { sent.push(p); return { txid: 'ltc' }; });
            relay._originPending.LTC = new Set([REQ_ID]);   // still owed

            await relay.onRoundFinalized(finalizedResponseEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            expect(sent).to.have.length(0);
            await relay.sweepFinalized();
            expect(sent).to.have.length(0);

            relay._finalizedResponse.get(REQ_ID).finalizedAt = Date.now() - (relay.failoverWindowMs + 1000);
            await relay.sweepFinalized();
            expect(sent).to.have.length(1);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('stamps the eviction key onto every WAL record it writes', async function () {
            // a record with no deadline is one no later process can ever retire,
            // so the stamp is applied centrally in appendWal rather than per call site.
            const relay = new AttestationRelay(makeHub());
            relay.noteDeadline('LTC', REQ_ID, 3160010);
            relay.setBroadcastHook(async () => ({ txid: 'deadbeef' }));
            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));

            const recs = fs.readFileSync(process.env.ATTEST_RELAY_QUEUE_PATH, 'utf8')
                .split('\n').filter(Boolean).map(JSON.parse);
            expect(recs).to.have.length.greaterThan(1);
            for (const r of recs) {
                expect(r.deadline_chain).to.equal('LTC');
                expect(r.deadline_block).to.equal(3160010);
            }
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('treats an ambiguous failure from the send step as sent', async function () {
            const relay = new AttestationRelay(makeHub());
            relay.setEncoder({
                getUtxos:    async () => [{ txid: 'a', vout: 0, value: 100000 }],
                createTx:    async () => ({ psbt: 'psbt' }),
                broadcastTx: async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; },
            });
            relay.setWalletSignHook(async () => 'deadbeef');
            relay.btcAddress   = 'mtest';
            relay.btcPubkeyHex = 'ab'.repeat(33);

            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(true);
        }); }); });
}
