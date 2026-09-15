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

// ── 1. The cross-service canonical ──────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('relay canonicals', function () { it('pins the request canonical byte-for-byte', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(false);
            const relay = new AttestationRelay(makeHub());
            const canonical = relay._relayRequestCanonical({
                request_id: REQ_ID, snapshot_block: 963000, network: 'mainnet',
                origin_chain: 'LTC', origin_action_index: 4242, provider_id: 'http_get',
                request_payload: 'https://example.com/score', redundancy: 3, deadline_blocks: 10,
            });
            expect(canonical).to.equal(
                'ATTEST|RELAY_REQUEST|' + REQ_ID + '|963000|mainnet|LTC|4242|http_get|' +
                sha256('https://example.com/score') + '|3|10');
        }); }); });

// ── 1. The cross-service canonical ──────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('relay canonicals', function () { it('pins the response canonical byte-for-byte', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(false);
            const relay = new AttestationRelay(makeHub());
            const bodyHash = sha256('body');
            const canonical = relay._relayResponseCanonical({
                request_id: REQ_ID, snapshot_block: 963000, network: 'mainnet',
                origin_chain: 'DOGE', home_response_action_index: 777, provider_id: 'http_get',
                response_hash: bodyHash, status: 'ok', meta: '200',
            });
            expect(canonical).to.equal(
                'ATTEST|RELAY_RESPONSE|' + REQ_ID + '|963000|mainnet|DOGE|777|http_get|' +
                bodyHash + '|ok|200');
        }); }); });

// ── 1. The cross-service canonical ──────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('relay canonicals', function () { it('wraps the EQUIV header with a per-leg round id so the two legs never collide', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(true);
            const relay = new AttestationRelay(makeHub());
            const base = { request_id: REQ_ID, snapshot_block: 963000, network: 'mainnet', origin_chain: 'LTC', provider_id: 'http_get' };
            const req = relay._relayRequestCanonical({ ...base, origin_action_index: 1, request_payload: '', redundancy: 1, deadline_blocks: 10 });
            const res = relay._relayResponseCanonical({ ...base, home_response_action_index: 1, response_hash: 'f'.repeat(64), status: 'ok', meta: '' });
            expect(req).to.include('XATTEST');
            expect(req).to.not.equal(res);
        }); }); });

// ── 1. The cross-service canonical ──────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('relay canonicals', function () { it('pins VIEW at 0 so a view change cannot invalidate the signatures', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(true);
            const relay = new AttestationRelay(makeHub());
            const row = {
                phase: 'request', request_id: REQ_ID, snapshot_block: 963000, network: 'mainnet',
                origin_chain: 'LTC', origin_action_index: 1, provider_id: 'http_get',
                request_payload: '', redundancy: 1, deadline_blocks: 10,
            };
            // The on-chain action carries no VIEW field, so a verifier replaying it
            // cannot learn one; the canonical must be view-independent.
            expect(relay._canonicalMatch(row, 7)).to.equal(relay._canonicalMatch(row, 0));
        }); }); });

// ── 1. The cross-service canonical ──────────────────────────────────────



        // The goldens above are the contract. This additionally executes the
        // INDEXER's own implementation when the sibling repo is checked out, which
        // is what catches a one-sided edit to either copy.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('relay canonicals', function () { it('byte-matches the indexer implementation (skipped when the sibling repo is absent)', function () {
            const attestPath = process.env.XCHAIN_INDEXER_DIR
                ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'actions', 'attest', 'index.js')
                : path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'actions', 'attest', 'index.js');
            // The skip is for a bare clone. A run that declared its siblings supplied
            // fails instead, so a dropped indexer checkout cannot leave the canonical
            // uncompared while the suite still reports green.
            if (!fs.existsSync(attestPath)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-indexer sibling was not found at ' + attestPath);
                return this.skip();
            }

            const Attest = require(attestPath);
            // Both canonicals touch only this._sha256 and the module-scoped
            // equivocation header, so a bare prototype exercises the real code.
            const ix    = Object.create(Attest.prototype);
            const relay = new AttestationRelay(makeHub());

            for (const network of ['mainnet', 'regtest']) {
                for (const snapshotBlock of [0, 962999, 963000, 4000000]) {
                    for (const payload of ['', 'https://example.com/score', 'ünïcødé']) {
                        expect(relay._relayRequestCanonical({
                            request_id: REQ_ID, snapshot_block: snapshotBlock, network,
                            origin_chain: 'LTC', origin_action_index: 4242, provider_id: 'http_get',
                            request_payload: payload, redundancy: 3, deadline_blocks: 10,
                        })).to.equal(ix.relayRequestCanonical({
                            requestId: REQ_ID, snapshotBlock, network,
                            originChain: 'LTC', originActionIndex: 4242, providerId: 'http_get',
                            requestPayload: payload, redundancy: 3, deadlineBlocks: 10,
                        }), `request canonical drift at ${network}/${snapshotBlock}`);

                        expect(relay._relayResponseCanonical({
                            request_id: REQ_ID, snapshot_block: snapshotBlock, network,
                            origin_chain: 'DOGE', home_response_action_index: 777, provider_id: 'http_get',
                            response_hash: sha256(payload), status: 'ok', meta: '200',
                        })).to.equal(ix.relayResponseCanonical({
                            requestId: REQ_ID, snapshotBlock, network,
                            originChain: 'DOGE', homeResponseActionIndex: 777, providerId: 'http_get',
                            responseHash: sha256(payload), status: 'ok', meta: '200',
                        }), `response canonical drift at ${network}/${snapshotBlock}`);
                    }
                }
            }
        }); }); });

// ── 1. The cross-service canonical ──────────────────────────────────────



        // The response leg end to end, through the code that actually runs: the row
        // the hub derives from its home indexer, versus the canonical the origin
        // indexer builds from the base64 that row puts on the wire. Nothing here is a
        // hand-computed hash, because a hand-computed hash proves only that the test
        // agrees with itself. The body must survive utf8 -> base64 -> bytes -> sha256
        // with the SAME hash on both sides, which is the one asymmetry of this leg:
        // the indexer hashes the DECODED bytes, not the base64 text.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('relay canonicals', function () { it('byte-matches the indexer on the derived response leg (skipped when the sibling repo is absent)', function () {
            const attestPath = process.env.XCHAIN_INDEXER_DIR
                ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'actions', 'attest', 'index.js')
                : path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'actions', 'attest', 'index.js');
            if (!fs.existsSync(attestPath)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-indexer sibling was not found at ' + attestPath);
                return this.skip();
            }

            const Attest = require(attestPath);
            const ix     = Object.create(Attest.prototype);
            const relay  = new AttestationRelay(makeHub());

            let compared = 0;
            for (const network of ['mainnet', 'regtest']) {
                for (const snapshotBlock of [0, 962999, 963000, 4000000]) {
                    for (const payload of ['', '{"score":42}', 'ünïcødé ✓', 'a|b|c', 'x'.repeat(400)]) {
                        for (const meta of ['', '200', 'model=ünï', null]) {
                            for (const status of ['ok', 'expired']) {
                                for (const originChain of ['LTC', 'DOGE']) {
                                    const fields = relay.responseFieldsFromHome(homeRelayedRow({
                                        response_payload: payload,
                                        response_hash:    crypto.createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex'),
                                        response_status:  status,
                                        meta:             meta,
                                        origin_chain:     originChain,
                                    }));
                                    expect(fields, 'derivation refused a relayable body').to.not.equal(null);

                                    // Exactly what xchain-indexer/src/actions/attest/index.js
                                    // parseRelayResponse does with the wire field.
                                    const wireBytes = Buffer.from(fields.payloadB64, 'base64');
                                    const wireHash  = crypto.createHash('sha256').update(wireBytes).digest('hex');
                                    expect(wireHash, 'the hub signed a hash of bytes it did not send')
                                        .to.equal(fields.responseHash);

                                    expect(relay._relayResponseCanonical({
                                        request_id: REQ_ID, snapshot_block: snapshotBlock, network,
                                        origin_chain: originChain,
                                        home_response_action_index: fields.homeResponseActionIndex,
                                        provider_id: fields.providerId, response_hash: fields.responseHash,
                                        status: fields.status, meta: fields.meta,
                                    })).to.equal(ix.relayResponseCanonical({
                                        requestId: REQ_ID, snapshotBlock, network,
                                        originChain,
                                        homeResponseActionIndex: fields.homeResponseActionIndex,
                                        providerId: fields.providerId, responseHash: wireHash,
                                        status: fields.status, meta: fields.meta,
                                    }), `response canonical drift at ${network}/${snapshotBlock}/${status}/${originChain}`);
                                    compared++;
                                }
                            }
                        }
                    }
                }
            }
            // Guards the guard: a loop that silently stopped iterating would pass.
            expect(compared).to.equal(2 * 4 * 5 * 4 * 2 * 2);
        }); }); });
}
