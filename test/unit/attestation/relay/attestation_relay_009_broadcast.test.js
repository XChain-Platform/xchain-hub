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
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('broadcasts once when this node holds rank 0', async function () {
            const relay = new AttestationRelay(makeHub());
            const sent = [];
            relay.setBroadcastHook(async (payload) => { sent.push(payload); return { txid: 'deadbeef' }; });
            // Sole signer, so this node is unambiguously rank 0.
            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(sent).to.have.length(1);
            expect(sent[0].split('|')[1]).to.equal('3');
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._broadcastSucceeded).to.equal(1);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('does not broadcast twice for the same request', async function () {
            const relay = new AttestationRelay(makeHub());
            const sent = [];
            relay.setBroadcastHook(async (payload) => { sent.push(payload); return { txid: 'deadbeef' }; });
            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(sent).to.have.length(1);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('holds a non-zero rank until its failover window elapses', async function () {
            // Rank is the hash order of the signer set; pick the identity that is NOT
            // first so this node must wait for the leader's silence.
            const rankOf = (pk) => sha256(REQ_ID + pk);
            const [first] = [PUBKEY_A, PUBKEY_B].sort((a, b) => (rankOf(a) < rankOf(b) ? -1 : 1));
            const other = first === PUBKEY_A ? PUBKEY_B : PUBKEY_A;

            const relay = new AttestationRelay(makeHub({
                getIdentity: () => ({ getPubkeyHex: () => other, sign: () => SIG_A }),
            }));
            const sent = [];
            relay.setBroadcastHook(async (payload) => { sent.push(payload); return { txid: 'x' }; });

            await relay.onRoundFinalized(finalizedEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            expect(sent).to.have.length(0);
            expect(relay._finalizedWire.get(REQ_ID).rank).to.equal(1);

            await relay.sweepFinalized();
            expect(sent).to.have.length(0);   // window has not elapsed

            relay._finalizedWire.get(REQ_ID).finalizedAt = Date.now() - (relay.failoverWindowMs + 1000);
            await relay.sweepFinalized();
            expect(sent).to.have.length(1);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('drops a retained round once the request appears on BTC', async function () {
            const relay = new AttestationRelay(makeHub({
                getIdentity: () => ({ getPubkeyHex: () => PUBKEY_B, sign: () => SIG_A }),
            }));
            relay.setBroadcastHook(async () => ({ txid: 'x' }));
            await relay.onRoundFinalized(finalizedEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            relay._homePending = new Set([REQ_ID]);
            await relay.sweepFinalized();
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(false);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('does not broadcast a round that finalized with no signatures', async function () {
            const relay = new AttestationRelay(makeHub());
            const sent = [];
            relay.setBroadcastHook(async (p) => { sent.push(p); return { txid: 'x' }; });
            await relay.onRoundFinalized(finalizedEvent([]));
            expect(sent).to.have.length(0);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('retains the round when no broadcast rail is configured', async function () {
            const relay = new AttestationRelay(makeHub());
            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(true);
            expect(relay._published.has(REQ_ID)).to.equal(false);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('marks an ambiguous send as relayed rather than re-spending', async function () {
            const relay = new AttestationRelay(makeHub());
            relay.setBroadcastHook(async () => {
                const e = new Error('socket hang up');
                e.code = 'ECONNRESET';
                throw e;
            });
            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._broadcastFailed).to.equal(1);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('leaves a never-sent transport failure retryable', async function () {
            const relay = new AttestationRelay(makeHub());
            relay.setBroadcastHook(async () => {
                const e = new Error('connect ECONNREFUSED');
                e.code = 'ECONNREFUSED';
                throw e;
            });
            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(false);
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(true);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('leaves a PRE-SEND failure on its own encoder rail retryable', async function () {
            // The shared classifier defaults an unrecognised error to ambiguous, which
            // is right for an opaque operator hook but would permanently suppress a
            // request that merely found the wallet empty. Nothing left the process
            // here, so it must stay retryable.
            const relay = new AttestationRelay(makeHub());
            relay.setEncoder({ getUtxos: async () => [], createTx: async () => ({}), broadcastTx: async () => ({ txid: 'x' }) });
            relay.setWalletSignHook(async () => 'deadbeef');
            relay.btcAddress   = 'mtest';
            relay.btcPubkeyHex = 'ab'.repeat(33);

            await relay.onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(false);
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(true);
            expect(relay._broadcastFailed).to.equal(1);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('broadcasts the v4 on the ORIGIN chain, not on the home chain', async function () {
            const relay = new AttestationRelay(makeHub());
            const home = [], origin = [];
            relay.setBroadcastHook(async (p) => { home.push(p); return { txid: 'btc' }; });
            relay.setChainBroadcastHook('LTC', async (p) => { origin.push(p); return { txid: 'ltc' }; });

            await relay.onRoundFinalized(finalizedResponseEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(origin).to.have.length(1);
            expect(origin[0].split('|')[1]).to.equal('4');
            // Handing a v4 to the home hook would put it on BTC, where it is rejected
            // outright ('relay responses land on origin chains only') after the fee.
            expect(home).to.have.length(0);
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(true);
            expect(relay._published.has(REQ_ID)).to.equal(false);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('never falls back to the home rail when the origin chain has none', async function () {
            const relay = new AttestationRelay(makeHub());
            const home = [];
            relay.setBroadcastHook(async (p) => { home.push(p); return { txid: 'btc' }; });
            relay.setEncoder({ getUtxos: async () => [{ txid: 'a', vout: 0, value: 1 }], createTx: async () => ({ psbt: 'p' }), broadcastTx: async () => ({ txid: 'x' }) });
            relay.setWalletSignHook(async () => 'deadbeef');
            relay.btcAddress   = 'mtest';
            relay.btcPubkeyHex = 'ab'.repeat(33);

            await relay.onRoundFinalized(finalizedResponseEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(home).to.have.length(0);
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(true);   // retained, not dropped
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(false);
        }); }); });

// ── 7. Broadcast and failover ───────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('broadcast', function () { beforeEach(hookAt59525); afterEach(hookAt59729); it('builds the v4 through the origin encoder and signs it with the coin named', async function () {
            const relay = new AttestationRelay(makeHub());
            const seen = { address: null, data: null, coin: null };
            relay.setChainEncoder('LTC', {
                getUtxos:    async (addr) => { seen.address = addr; return [{ txid: 'a', vout: 0, value: 100000 }]; },
                createTx:    async (args) => { seen.data = args.data; return { psbt: 'psbt' }; },
                broadcastTx: async () => ({ txid: 'ltctx' }),
            });
            relay.chainRails.LTC.address = 'ltc1qtest';
            // The shared operator hook serves an origin chain too, but it is told which
            // chain it is signing for so a multi-key module can pick the right one.
            relay.setWalletSignHook(async (psbt, coin) => { seen.coin = coin; return 'deadbeef'; });

            await relay.onRoundFinalized(finalizedResponseEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(seen.address).to.equal('ltc1qtest');
            expect(seen.coin).to.equal('LTC');
            expect(seen.data.split('|')[1]).to.equal('4');
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(true);
        }); }); });
}
