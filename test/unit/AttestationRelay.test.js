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
 * AttestationRelay ( request leg /  response leg): the hub half of the
 *  §12 cross-chain relay.
 *
 * What these protect, in priority order:
 *   1. THE CANONICAL. The hub signs bytes an indexer must reproduce exactly. A
 *      one-byte drift is silent: signatures simply never verify and every peer's
 *      v3 or v4 is dropped as unquorate. Pinned as goldens here AND cross-checked
 *      against the indexer's own implementation when the sibling repo is present.
 *   2. INERTNESS. Off unless ATTEST_RELAY_ENABLED=1, and below
 *      ATTEST_RELAY_ACTIVATION nothing is proposed or broadcast, so a deployed
 *      but unarmed fleet behaves exactly as it did before .
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

const AttestationRelay = require('../../src/AttestationRelay.js');
const eq               = require('../../src/equivocation_header.js');

const REQ_ID    = 'd'.repeat(64);
const PUBKEY_A  = 'a'.repeat(64);
const PUBKEY_B  = 'b'.repeat(64);
const SIG_A     = '1'.repeat(128);
const sha256    = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// The origin indexer's getpendingattestation_requests row shape, matching the
// column list xchain-indexer/src/db.js::getPendingAttestationRequests selects.
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
// match xchain-indexer/src/db.js::getRelayedAttestationRequests.
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
// request-leg tests see exactly the world  gave them.
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

describe('AttestationRelay ', function () {

    let envSnapshot;

    beforeEach(function () {
        envSnapshot = { ...process.env };
        delete process.env.ATTEST_RELAY_ENABLED;
        delete process.env.ATTEST_RELAY_QUEUE_PATH;
    });

    afterEach(function () {
        process.env = envSnapshot;
        sinon.restore();
    });

    // ── 1. The cross-service canonical ──────────────────────────────────────

    describe('relay canonicals', function () {

        it('pins the request canonical byte-for-byte', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(false);
            const relay = new AttestationRelay(makeHub());
            const canonical = relay._relayRequestCanonical({
                request_id: REQ_ID, snapshot_block: 969500, network: 'mainnet',
                origin_chain: 'LTC', origin_action_index: 4242, provider_id: 'http_get',
                request_payload: 'https://example.com/score', redundancy: 3, deadline_blocks: 10,
            });
            expect(canonical).to.equal(
                'ATTEST|RELAY_REQUEST|' + REQ_ID + '|969500|mainnet|LTC|4242|http_get|' +
                sha256('https://example.com/score') + '|3|10');
        });

        it('pins the response canonical byte-for-byte', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(false);
            const relay = new AttestationRelay(makeHub());
            const bodyHash = sha256('body');
            const canonical = relay._relayResponseCanonical({
                request_id: REQ_ID, snapshot_block: 969500, network: 'mainnet',
                origin_chain: 'DOGE', home_response_action_index: 777, provider_id: 'http_get',
                response_hash: bodyHash, status: 'ok', meta: '200',
            });
            expect(canonical).to.equal(
                'ATTEST|RELAY_RESPONSE|' + REQ_ID + '|969500|mainnet|DOGE|777|http_get|' +
                bodyHash + '|ok|200');
        });

        it('wraps the EQUIV header with a per-leg round id so the two legs never collide', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(true);
            const relay = new AttestationRelay(makeHub());
            const base = { request_id: REQ_ID, snapshot_block: 969500, network: 'mainnet', origin_chain: 'LTC', provider_id: 'http_get' };
            const req = relay._relayRequestCanonical({ ...base, origin_action_index: 1, request_payload: '', redundancy: 1, deadline_blocks: 10 });
            const res = relay._relayResponseCanonical({ ...base, home_response_action_index: 1, response_hash: 'f'.repeat(64), status: 'ok', meta: '' });
            expect(req).to.include('XATTEST');
            expect(req).to.not.equal(res);
        });

        it('pins VIEW at 0 so a view change cannot invalidate the signatures', function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(true);
            const relay = new AttestationRelay(makeHub());
            const row = {
                phase: 'request', request_id: REQ_ID, snapshot_block: 969500, network: 'mainnet',
                origin_chain: 'LTC', origin_action_index: 1, provider_id: 'http_get',
                request_payload: '', redundancy: 1, deadline_blocks: 10,
            };
            // The on-chain action carries no VIEW field, so a verifier replaying it
            // cannot learn one; the canonical must be view-independent.
            expect(relay._canonicalMatch(row, 7)).to.equal(relay._canonicalMatch(row, 0));
        });

        // The goldens above are the contract. This additionally executes the
        // INDEXER's own implementation when the sibling repo is checked out, which
        // is what catches a one-sided edit to either copy.
        it('byte-matches the indexer implementation (skipped when the sibling repo is absent)', function () {
            const attestPath = process.env.XCHAIN_INDEXER_DIR
                ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'actions', 'attest.js')
                : path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'actions', 'attest.js');
            if (!fs.existsSync(attestPath)) return this.skip();

            const Attest = require(attestPath);
            // Both canonicals touch only this._sha256 and the module-scoped
            // equivocation header, so a bare prototype exercises the real code.
            const ix    = Object.create(Attest.prototype);
            const relay = new AttestationRelay(makeHub());

            for (const network of ['mainnet', 'regtest']) {
                for (const snapshotBlock of [0, 969499, 969500, 4000000]) {
                    for (const payload of ['', 'https://example.com/score', 'ünïcødé']) {
                        expect(relay._relayRequestCanonical({
                            request_id: REQ_ID, snapshot_block: snapshotBlock, network,
                            origin_chain: 'LTC', origin_action_index: 4242, provider_id: 'http_get',
                            request_payload: payload, redundancy: 3, deadline_blocks: 10,
                        })).to.equal(ix._relayRequestCanonical({
                            requestId: REQ_ID, snapshotBlock, network,
                            originChain: 'LTC', originActionIndex: 4242, providerId: 'http_get',
                            requestPayload: payload, redundancy: 3, deadlineBlocks: 10,
                        }), `request canonical drift at ${network}/${snapshotBlock}`);

                        expect(relay._relayResponseCanonical({
                            request_id: REQ_ID, snapshot_block: snapshotBlock, network,
                            origin_chain: 'DOGE', home_response_action_index: 777, provider_id: 'http_get',
                            response_hash: sha256(payload), status: 'ok', meta: '200',
                        })).to.equal(ix._relayResponseCanonical({
                            requestId: REQ_ID, snapshotBlock, network,
                            originChain: 'DOGE', homeResponseActionIndex: 777, providerId: 'http_get',
                            responseHash: sha256(payload), status: 'ok', meta: '200',
                        }), `response canonical drift at ${network}/${snapshotBlock}`);
                    }
                }
            }
        });

        // The response leg end to end, through the code that actually runs: the row
        // the hub derives from its home indexer, versus the canonical the origin
        // indexer builds from the base64 that row puts on the wire. Nothing here is a
        // hand-computed hash, because a hand-computed hash proves only that the test
        // agrees with itself. The body must survive utf8 -> base64 -> bytes -> sha256
        // with the SAME hash on both sides, which is the one asymmetry of this leg:
        // the indexer hashes the DECODED bytes, not the base64 text.
        it('byte-matches the indexer on the derived response leg (skipped when the sibling repo is absent)', function () {
            const attestPath = process.env.XCHAIN_INDEXER_DIR
                ? path.join(process.env.XCHAIN_INDEXER_DIR, 'src', 'actions', 'attest.js')
                : path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'actions', 'attest.js');
            if (!fs.existsSync(attestPath)) return this.skip();

            const Attest = require(attestPath);
            const ix     = Object.create(Attest.prototype);
            const relay  = new AttestationRelay(makeHub());

            let compared = 0;
            for (const network of ['mainnet', 'regtest']) {
                for (const snapshotBlock of [0, 969499, 969500, 4000000]) {
                    for (const payload of ['', '{"score":42}', 'ünïcødé ✓', 'a|b|c', 'x'.repeat(400)]) {
                        for (const meta of ['', '200', 'model=ünï', null]) {
                            for (const status of ['ok', 'expired']) {
                                for (const originChain of ['LTC', 'DOGE']) {
                                    const fields = relay._responseFieldsFromHome(homeRelayedRow({
                                        response_payload: payload,
                                        response_hash:    crypto.createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex'),
                                        response_status:  status,
                                        meta:             meta,
                                        origin_chain:     originChain,
                                    }));
                                    expect(fields, 'derivation refused a relayable body').to.not.equal(null);

                                    // Exactly what xchain-indexer/src/actions/attest.js
                                    // _parseRelayResponse does with the wire field.
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
                                    })).to.equal(ix._relayResponseCanonical({
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
        });
    });

    // ── 2. Inertness ────────────────────────────────────────────────────────

    describe('opt-in and flag-day inertness', function () {

        it('is disabled unless ATTEST_RELAY_ENABLED=1', function () {
            expect(new AttestationRelay(makeHub()).enabled).to.equal(false);
            process.env.ATTEST_RELAY_ENABLED = '0';
            expect(new AttestationRelay(makeHub()).enabled).to.equal(false);
            process.env.ATTEST_RELAY_ENABLED = 'true';
            expect(new AttestationRelay(makeHub()).enabled).to.equal(false);
            process.env.ATTEST_RELAY_ENABLED = '1';
            expect(new AttestationRelay(makeHub()).enabled).to.equal(true);
        });

        it('start() attaches no poll timer while disabled', async function () {
            const relay = new AttestationRelay(makeHub());
            await relay.start();
            expect(relay._pollTimer).to.equal(null);
        });

        it('proposes nothing below ATTEST_RELAY_ACTIVATION', async function () {
            // mainnet arms at 969500; a BTC tip below it must relay nothing.
            const relay = makeRelay({ network: 'mainnet', _resolveBtcLatestBlock: sinon.stub().resolves(969499) });
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('proposes at the activation height and not one block below it', async function () {
            const below = makeRelay({ network: 'mainnet', _resolveBtcLatestBlock: sinon.stub().resolves(969499) });
            await below._poll();
            expect(below.consensus.propose.called).to.equal(false);

            const at = makeRelay({ network: 'mainnet', _resolveBtcLatestBlock: sinon.stub().resolves(969500) });
            await at._poll();
            expect(at.consensus.propose.calledOnce).to.equal(true);
            expect(at.consensus.propose.firstCall.args[1].row.snapshot_block).to.equal(969500);
        });

        it('proposes nothing when the BTC tip cannot be resolved', async function () {
            const relay = makeRelay({ _resolveBtcLatestBlock: sinon.stub().resolves(null) });
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });
    });

    // ── 3. Discovery gating ─────────────────────────────────────────────────

    describe('origin discovery', function () {

        it('materializes a confirmed relay-eligible request onto BTC', async function () {
            const relay = makeRelay();
            await relay._poll();
            expect(relay.consensus.propose.calledOnce).to.equal(true);
            const row = relay.consensus.propose.firstCall.args[1].row;
            expect(row).to.include({
                request_id:          REQ_ID,
                phase:               'request',
                origin_chain:        'LTC',
                origin_action_index: 4242,
                provider_id:         'http_get',
                redundancy:          3,
            });
            // DEADLINE travels as a block COUNT: the origin's absolute deadline_block
            // is a height on another chain and means nothing on BTC.
            expect(row.deadline_blocks).to.equal(10);
            expect(row.snapshot_block).to.equal(1000);
        });

        it('ignores a request that carries no origin_chain stamp', async function () {
            const relay = makeRelay({}, [originRow({ origin_chain: null })]);
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('ignores a request stamped for a different origin chain', async function () {
            const relay = makeRelay({}, [originRow({ origin_chain: 'DOGE' })]);
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('holds a request that has not reached the origin confirmation depth', async function () {
            const relay = makeRelay();
            const needed = relay.confirmations.LTC;
            relay._indexerCall = sinon.stub().callsFake(async (coin) => {
                if (coin === 'BTC') return { latest_block_index: 1000, requests: [] };
                if (coin === 'LTC') return {
                    // One block short of the depth.
                    latest_block_index: 3160000 + needed - 2,
                    requests: [originRow()],
                };
                return { latest_block_index: 0, requests: [] };
            });
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('does not re-materialize a request already pending on BTC', async function () {
            const relay = makeRelay();
            relay._indexerCall = sinon.stub().callsFake(async (coin) => {
                if (coin === 'BTC') return { latest_block_index: 1000, requests: [{ request_id: REQ_ID, block_index: 900, action_index: 1 }] };
                if (coin === 'LTC') return { latest_block_index: 3160099, requests: [originRow()] };
                return { latest_block_index: 0, requests: [] };
            });
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('does not re-materialize a request the WAL records as already relayed', async function () {
            const relay = makeRelay();
            relay._published.mark(REQ_ID);
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('refuses a payload containing a pipe, which the positional wire cannot carry', async function () {
            const relay = makeRelay({}, [originRow({ payload: 'https://example.com/a|b' })]);
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('refuses a request whose deadline is not a positive block count', async function () {
            const relay = makeRelay({}, [originRow({ deadline_block: 3160000 })]);
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('does not re-materialize a request BTC has already FULFILLED', async function () {
            // The regression that motivated the relayed-requests read: a fulfilled BTC
            // row is no longer in the pending queue, while the ORIGIN row stays pending
            // until the v4 lands. On the pending view alone that window reads as never
            // materialized, and the duplicate v3 is rejected on-chain after the fee.
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            await relay._poll();
            expect(proposedRows(relay, 'request')).to.have.length(0);
        });

        it('keeps the previous home-pending view when the BTC indexer is unreachable', async function () {
            const relay = makeRelay();
            relay._homePending = new Set([REQ_ID]);
            relay._indexerCall = sinon.stub().callsFake(async (coin) => {
                if (coin === 'BTC') throw new Error('connect ECONNREFUSED');
                if (coin === 'LTC') return { latest_block_index: 3160099, requests: [originRow()] };
                return { latest_block_index: 0, requests: [] };
            });
            await relay._poll();
            // Relaying while blind to BTC is what double-spends the fee.
            expect(relay.consensus.propose.called).to.equal(false);
        });
    });

    // ── 3b. Response-leg discovery  ─────────────────────────────────

    describe('home response discovery', function () {

        it('relays a confirmed terminal response back to its origin chain', async function () {
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
        });

        it('relays a terminal expired outcome, which closes the origin request early', async function () {
            const relay = makeRelay({}, [originRow()],
                [homeRelayedRow({ response_status: 'expired', request_status: 'errored' })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')[0].status).to.equal('expired');
        });

        it('relays nothing while the request is still pending on BTC', async function () {
            const relay = makeRelay({}, [originRow()],
                [homeRelayedRow({ request_status: 'pending', response_action_index: null,
                                  response_block_index: null, response_hash: null,
                                  response_payload: null, response_status: null, meta: null })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });

        it('relays nothing once the origin no longer has the request pending', async function () {
            // The origin flips out of 'pending' exactly when a v4 lands, so this is
            // also how a PEER's broadcast retires our own work.
            const relay = makeRelay({}, [], [homeRelayedRow()]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });

        it('relays nothing when the origin pending view could not be refreshed', async function () {
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
        });

        it('holds a response that has not reached the BTC confirmation depth', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow({ response_block_index: 1000 })]);
            expect(relay.confirmations.BTC).to.be.greaterThan(1);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });

        it('refuses a body that does not re-encode to its own stored hash', async function () {
            // The indexer stores the UTF-8 DECODE of the bytes it hashed, so a
            // non-UTF-8 attested body cannot cross chains: base64 of the stored text
            // would deliver a MANGLED payload under a quorum signature.
            const relay = makeRelay({}, [originRow()], [homeRelayedRow({ response_hash: 'f'.repeat(64) })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });

        it('refuses a meta containing a pipe, which the positional wire cannot carry', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow({ meta: '200|spoofed' })]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });

        it('relays nothing below ATTEST_RELAY_ACTIVATION', async function () {
            const relay = makeRelay(
                { network: 'mainnet', _resolveBtcLatestBlock: sinon.stub().resolves(969499) },
                [originRow()], [homeRelayedRow()]);
            await relay._poll();
            expect(relay.consensus.propose.called).to.equal(false);
        });

        it('relays nothing for an origin chain it has no indexer for', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            relay.indexers.LTC.url = '';
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });

        it('refuses to propose when the two chains name different providers', async function () {
            // They agree by construction, since the v3 carried the provider from the
            // origin. A disagreement would produce a canonical the origin cannot
            // reproduce, so every peer refuses and the round wedges silently.
            const relay = makeRelay({}, [originRow({ provider_id: 'llm' })], [homeRelayedRow()]);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });

        it('does not re-propose a response it has already relayed', async function () {
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            relay._publishedResponses.mark(REQ_ID);
            await relay._poll();
            expect(proposedRows(relay, 'response')).to.have.length(0);
        });
    });

    // ── 4. Follower re-verification ─────────────────────────────────────────

    describe('validateProposedMatch', function () {

        function proposedRow(overrides = {}) {
            return {
                round_id:            sha256('ATTESTRELAYROUND|request|' + REQ_ID),
                request_id:          REQ_ID,
                phase:               'request',
                snapshot_block:      1000,
                network:             'regtest',
                origin_chain:        'LTC',
                origin_action_index: 4242,
                provider_id:         'http_get',
                request_payload:     'https://example.com/score',
                redundancy:          3,
                deadline_blocks:     10,
                ...overrides,
            };
        }

        it('accepts a row it can independently confirm on its own origin indexer', async function () {
            const relay = makeRelay();
            expect(await relay.validateProposedMatch(proposedRow())).to.equal(true);
        });

        it('refuses a leg it has no verification rules for at all', async function () {
            const relay = makeRelay();
            for (const phase of ['response', 'settle', '', null, undefined]) {
                // 'response' is refused HERE because a request-leg row wearing the
                // response phase binds neither round id nor response fields; the real
                // response leg has its own describe block below.
                expect(await relay.validateProposedMatch(proposedRow({ phase })),
                    'should refuse phase ' + phase).to.equal(false);
            }
            expect(await relay.validateProposedMatch(null)).to.equal(false);
        });

        it('refuses a row whose round id does not bind its request id', async function () {
            const relay = makeRelay();
            expect(await relay.validateProposedMatch(proposedRow({ round_id: sha256('nope') }))).to.equal(false);
        });

        // #4204. The relay legs sign these integers VERBATIM (String(r.field) inside
        // _relayRequestCanonical) and put the same spelling on the v3 wire, but the
        // indexer re-parses that wire with parseInt() before rebuilding the canonical it
        // verifies against. '4242' and '04242' therefore pass the Number()-based field
        // checks below identically, while only one produces a canonical the origin chain
        // can verify: the other lands as 'invalid: cross_chain quorum' with no path to
        // re-relay, and the request sits until its deadline expires.
        it('refuses a noncanonical integer spelling on a signed field', async function () {
            const relay = makeRelay();
            // The canonical spelling passes as a number or as a string.
            expect(await relay.validateProposedMatch(proposedRow({ origin_action_index: '4242' }))).to.equal(true);
            for (const bad of [
                { origin_action_index: '04242' },
                { origin_action_index: '+4242' },
                { origin_action_index: ' 4242' },
                { redundancy: '03' },
                { deadline_blocks: '010' },
                { snapshot_block: '01000' },
                { redundancy: null }
            ]) {
                expect(await relay.validateProposedMatch(proposedRow(bad)),
                    'co-signed a relay leg spelled ' + JSON.stringify(bad)).to.equal(false);
            }
        });

        it('refuses a leader-inflated field the origin chain does not agree with', async function () {
            const relay = makeRelay();
            for (const bad of [
                { origin_action_index: 4243 },
                { provider_id: 'other_provider' },
                { redundancy: 1 },
                { deadline_blocks: 5000 },
                { request_payload: 'https://evil.example.com/' },
            ]) {
                expect(await relay.validateProposedMatch(proposedRow(bad)),
                    'should refuse ' + JSON.stringify(bad)).to.equal(false);
            }
        });

        it('refuses a stale snapshot_block far from its own BTC tip view', async function () {
            const relay = makeRelay();
            expect(await relay.validateProposedMatch(proposedRow({ snapshot_block: 100 }))).to.equal(false);
        });

        it('refuses a row for a chain that is not a known origin chain', async function () {
            const relay = makeRelay();
            expect(await relay.validateProposedMatch(proposedRow({ origin_chain: 'BTC' }))).to.equal(false);
        });

        it('refuses a row whose network does not match its own', async function () {
            const relay = makeRelay();
            expect(await relay.validateProposedMatch(proposedRow({ network: 'mainnet' }))).to.equal(false);
        });

        it('refuses when its own origin indexer does not have the request', async function () {
            const relay = makeRelay({}, []);
            expect(await relay.validateProposedMatch(proposedRow())).to.equal(false);
        });

        it('refuses when its own origin indexer is unreachable', async function () {
            const relay = makeRelay();
            relay._indexerCall = sinon.stub().callsFake(async (coin) => {
                if (coin === 'BTC') return { latest_block_index: 1000, requests: [] };
                throw new Error('connect ECONNREFUSED');
            });
            expect(await relay.validateProposedMatch(proposedRow())).to.equal(false);
        });
    });

    // ── 4b. Follower re-verification, response leg  ─────────────────

    describe('validateProposedMatch, response leg', function () {

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

        it('accepts a row it can independently confirm at BOTH ends', async function () {
            expect(await relayForResponse().validateProposedMatch(responseRow())).to.equal(true);
        });

        it('refuses a row whose round id does not bind the response leg', async function () {
            const relay = relayForResponse();
            // The REQUEST leg's round id for the same request must not co-sign here, or
            // the two legs collide in one idempotency slot.
            expect(await relay.validateProposedMatch(responseRow({
                round_id: sha256('ATTESTRELAYROUND|request|' + REQ_ID),
            }))).to.equal(false);
        });

        it('refuses every field the home chain does not agree with', async function () {
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
        });

        it('refuses a payload whose bytes do not hash to the row hash', async function () {
            // The origin recomputes the hash from the wire payload, so a leader that
            // pairs an honest hash with a tampered body produces a canonical the
            // signatures do not cover. Refusing here fails earlier and cheaper.
            const relay = relayForResponse();
            expect(await relay.validateProposedMatch(responseRow({
                response_payload_b64: Buffer.from('other body', 'utf8').toString('base64'),
            }))).to.equal(false);
        });

        it('refuses when its own origin indexer no longer has the request pending', async function () {
            const relay = relayForResponse({}, []);
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        });

        it('refuses when the origin request names a different provider', async function () {
            // The origin builds its canonical from ITS OWN request row's provider_id,
            // so a mismatch signs bytes the origin will never reproduce.
            const relay = makeRelay({}, [originRow({ provider_id: 'llm' })], [homeRelayedRow()]);
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        });

        it('refuses when its own BTC indexer has no terminal response for the request', async function () {
            const relay = makeRelay({}, [originRow()], []);
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        });

        it('refuses when BTC holds the request but nothing has fulfilled it', async function () {
            const relay = relayForResponse({
                request_status: 'pending', response_action_index: null, response_block_index: null,
                response_hash: null, response_payload: null, response_status: null, meta: null,
            });
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        });

        it('refuses a response BTC has not confirmed deeply enough to settle against', async function () {
            const relay = relayForResponse({ response_block_index: 1000 });
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        });

        it('refuses a row whose origin chain disagrees with the BTC request row', async function () {
            const relay = relayForResponse({ origin_chain: 'DOGE' });
            expect(await relay.validateProposedMatch(responseRow())).to.equal(false);
        });

        it('refuses a stale snapshot_block, a foreign network and an unknown origin chain', async function () {
            const relay = relayForResponse();
            for (const bad of [{ snapshot_block: 100 }, { network: 'mainnet' }, { origin_chain: 'BTC' }]) {
                expect(await relay.validateProposedMatch(responseRow(bad)),
                    'should refuse ' + JSON.stringify(bad)).to.equal(false);
            }
        });

        it('refuses below ATTEST_RELAY_ACTIVATION', async function () {
            const relay = makeRelay({ network: 'mainnet', _resolveBtcLatestBlock: sinon.stub().resolves(969499) },
                [originRow()], [homeRelayedRow()]);
            expect(await relay.validateProposedMatch(responseRow({
                network: 'mainnet', snapshot_block: 969499,
            }))).to.equal(false);
        });

        it('refuses when either indexer is unreachable', async function () {
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
        });
    });

    // ── 5. Wire assembly ────────────────────────────────────────────────────

    describe('ATTEST v3 wire', function () {

        it('emits the field order the indexer parses positionally', function () {
            const relay = new AttestationRelay(makeHub());
            const wire = relay._buildRequestWire({
                request_id: REQ_ID, origin_chain: 'LTC', origin_action_index: 4242,
                provider_id: 'http_get', request_payload: 'https://example.com/score',
                redundancy: 3, deadline_blocks: 10, snapshot_block: 969500,
            }, [{ pubkey: PUBKEY_A, sig: SIG_A }]);

            const parts = wire.split('|');
            // Mirrors xchain-indexer/src/actions/attest.js formats[3] and the
            // params[N] offsets _parseRelayRequest reads.
            expect(parts[0]).to.equal('ATTEST');
            expect(parts[1]).to.equal('3');
            expect(parts[2]).to.equal(REQ_ID);
            expect(parts[3]).to.equal('LTC');
            expect(parts[4]).to.equal('4242');
            expect(parts[5]).to.equal('http_get');
            expect(parts[6]).to.equal('https://example.com/score');
            expect(parts[7]).to.equal('3');
            expect(parts[8]).to.equal('10');
            expect(parts[9]).to.equal('969500');
            // The indexer strips the leading 'ATTEST' before indexing, so its
            // params[N] is wire index N+1: _parseRelaySigs(params, 9) reads the
            // signature count from wire index 10.
            expect(parts[10]).to.equal('1');
            expect(parts[11]).to.equal(PUBKEY_A);
            expect(parts[12]).to.equal(SIG_A);
        });

        it('lowercases the signature tail as the indexer does before verifying', function () {
            const relay = new AttestationRelay(makeHub());
            const wire = relay._buildRequestWire({
                request_id: REQ_ID.toUpperCase(), origin_chain: 'LTC', origin_action_index: 1,
                provider_id: 'p', request_payload: '', redundancy: 1, deadline_blocks: 1, snapshot_block: 1,
            }, [{ pubkey: PUBKEY_A.toUpperCase(), sig: SIG_A.toUpperCase() }]);
            expect(wire.split('|')[2]).to.equal(REQ_ID);
            expect(wire.split('|')[11]).to.equal(PUBKEY_A);
        });

        it('refuses a wire over the encoder payload ceiling', function () {
            const relay = new AttestationRelay(makeHub());
            const row = {
                request_id: REQ_ID, origin_chain: 'LTC', origin_action_index: 1, provider_id: 'p',
                request_payload: 'x'.repeat(9000), redundancy: 1, deadline_blocks: 1, snapshot_block: 1,
            };
            expect(relay._wireFault(row, 1)).to.match(/over the encoder limit/);
        });
    });

    describe('ATTEST v4 wire', function () {

        it('emits the field order the origin indexer parses positionally', function () {
            const relay = new AttestationRelay(makeHub());
            const b64   = Buffer.from(RESPONSE_BODY, 'utf8').toString('base64');
            const wire  = relay._buildResponseWire({
                request_id: REQ_ID, home_response_action_index: 9002, response_payload_b64: b64,
                status: 'ok', meta: '200', snapshot_block: 969500,
            }, [{ pubkey: PUBKEY_A, sig: SIG_A }]);

            const parts = wire.split('|');
            // Mirrors xchain-indexer/src/actions/attest.js formats[4]:
            // VERSION|REQUEST_ID|HOME_RESPONSE_ACTION_INDEX|RESPONSE_PAYLOAD|STATUS|META|
            // SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...
            expect(parts[0]).to.equal('ATTEST');
            expect(parts[1]).to.equal('4');
            expect(parts[2]).to.equal(REQ_ID);
            expect(parts[3]).to.equal('9002');
            expect(parts[4]).to.equal(b64);
            expect(parts[5]).to.equal('ok');
            expect(parts[6]).to.equal('200');
            expect(parts[7]).to.equal('969500');
            // The indexer strips the leading 'ATTEST' before indexing, so its params[N]
            // is wire index N+1: _parseRelaySigs(params, 7) reads the count at index 8.
            expect(parts[8]).to.equal('1');
            expect(parts[9]).to.equal(PUBKEY_A);
            expect(parts[10]).to.equal(SIG_A);
        });

        it('carries an empty body and an empty meta as empty fields, not as gaps', function () {
            const relay = new AttestationRelay(makeHub());
            const wire  = relay._buildResponseWire({
                request_id: REQ_ID, home_response_action_index: 1, response_payload_b64: '',
                status: 'expired', meta: null, snapshot_block: 1,
            }, [{ pubkey: PUBKEY_A, sig: SIG_A }]);
            const parts = wire.split('|');
            expect(parts[4]).to.equal('');
            expect(parts[6]).to.equal('');
            expect(parts[8]).to.equal('1');
        });

        it('refuses a v4 wire over the encoder payload ceiling', function () {
            const relay = new AttestationRelay(makeHub());
            expect(relay._wireFault({
                phase: 'response', request_id: REQ_ID, home_response_action_index: 1,
                response_payload_b64: 'x'.repeat(9000), status: 'ok', meta: '', snapshot_block: 1,
            }, 1)).to.match(/ATTEST v4 wire is .* over the encoder limit/);
        });
    });

    // ── 6. Durable at-most-once ─────────────────────────────────────────────

    describe('broadcast WAL', function () {

        let dir;
        beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-')); });
        afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

        function relayWithWal(lines) {
            const wal = path.join(dir, 'relay.jsonl');
            if (lines) fs.writeFileSync(wal, lines.map(JSON.stringify).join('\n') + '\n');
            process.env.ATTEST_RELAY_QUEUE_PATH = wal;
            const relay = new AttestationRelay(makeHub());
            relay._loadWal();
            return relay;
        }

        it('treats a sent record as relayed', function () {
            expect(relayWithWal([{ rid: REQ_ID, phase: 'intent' }, { rid: REQ_ID, phase: 'sent', txid: 'ab' }])
                ._published.has(REQ_ID)).to.equal(true);
        });

        it('treats a crash between intent and outcome as SENT', function () {
            // Fail closed toward not spending: a duplicate v3 burns a real BTC fee for
            // an action the indexer rejects, while a missed relay merely lets the
            // origin request expire on its own deadline.
            expect(relayWithWal([{ rid: REQ_ID, phase: 'intent' }])._published.has(REQ_ID)).to.equal(true);
        });

        it('leaves a definitively failed broadcast retryable', function () {
            expect(relayWithWal([{ rid: REQ_ID, phase: 'intent' }, { rid: REQ_ID, phase: 'failed' }])
                ._published.has(REQ_ID)).to.equal(false);
        });

        it('keeps a sent record sticky against a later failed record', function () {
            expect(relayWithWal([{ rid: REQ_ID, phase: 'sent' }, { rid: REQ_ID, phase: 'failed' }])
                ._published.has(REQ_ID)).to.equal(true);
        });

        it('survives a truncated or corrupt line', function () {
            const wal = path.join(dir, 'relay.jsonl');
            fs.writeFileSync(wal, '{"rid":"' + REQ_ID + '","phase":"sent"}\n{not json\n');
            process.env.ATTEST_RELAY_QUEUE_PATH = wal;
            const relay = new AttestationRelay(makeHub());
            relay._loadWal();
            expect(relay._published.has(REQ_ID)).to.equal(true);
        });

        it('starts clean when no WAL exists yet', function () {
            process.env.ATTEST_RELAY_QUEUE_PATH = path.join(dir, 'absent.jsonl');
            const relay = new AttestationRelay(makeHub());
            relay._loadWal();
            expect(relay._published.size).to.equal(0);
        });

        it('keys on (request_id, leg) so one request can relay both legs', function () {
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
        });

        it('reads a leg-less record written before  as a request-leg record', function () {
            const relay = relayWithWal([{ rid: REQ_ID, phase: 'sent' }]);
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(false);
        });

        it('keeps a failed response record retryable without touching the request leg', function () {
            const relay = relayWithWal([
                { rid: REQ_ID, leg: 'request',  phase: 'sent' },
                { rid: REQ_ID, leg: 'response', phase: 'intent' },
                { rid: REQ_ID, leg: 'response', phase: 'failed' },
            ]);
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(false);
        });
    });

    // ── 7. Broadcast and failover ───────────────────────────────────────────

    describe('broadcast', function () {

        let dir;
        beforeEach(function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-relay-bc-'));
            process.env.ATTEST_RELAY_QUEUE_PATH = path.join(dir, 'relay.jsonl');
        });
        afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

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

        it('broadcasts once when this node holds rank 0', async function () {
            const relay = new AttestationRelay(makeHub());
            const sent = [];
            relay.setBroadcastHook(async (payload) => { sent.push(payload); return { txid: 'deadbeef' }; });
            // Sole signer, so this node is unambiguously rank 0.
            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(sent).to.have.length(1);
            expect(sent[0].split('|')[1]).to.equal('3');
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._broadcastSucceeded).to.equal(1);
        });

        it('does not broadcast twice for the same request', async function () {
            const relay = new AttestationRelay(makeHub());
            const sent = [];
            relay.setBroadcastHook(async (payload) => { sent.push(payload); return { txid: 'deadbeef' }; });
            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(sent).to.have.length(1);
        });

        it('holds a non-zero rank until its failover window elapses', async function () {
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

            await relay._onRoundFinalized(finalizedEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            expect(sent).to.have.length(0);
            expect(relay._finalizedWire.get(REQ_ID).rank).to.equal(1);

            await relay._sweepFinalized();
            expect(sent).to.have.length(0);   // window has not elapsed

            relay._finalizedWire.get(REQ_ID).finalizedAt = Date.now() - (relay.failoverWindowMs + 1000);
            await relay._sweepFinalized();
            expect(sent).to.have.length(1);
        });

        it('drops a retained round once the request appears on BTC', async function () {
            const relay = new AttestationRelay(makeHub({
                getIdentity: () => ({ getPubkeyHex: () => PUBKEY_B, sign: () => SIG_A }),
            }));
            relay.setBroadcastHook(async () => ({ txid: 'x' }));
            await relay._onRoundFinalized(finalizedEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            relay._homePending = new Set([REQ_ID]);
            await relay._sweepFinalized();
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(false);
        });

        it('does not broadcast a round that finalized with no signatures', async function () {
            const relay = new AttestationRelay(makeHub());
            const sent = [];
            relay.setBroadcastHook(async (p) => { sent.push(p); return { txid: 'x' }; });
            await relay._onRoundFinalized(finalizedEvent([]));
            expect(sent).to.have.length(0);
        });

        it('retains the round when no broadcast rail is configured', async function () {
            const relay = new AttestationRelay(makeHub());
            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(true);
            expect(relay._published.has(REQ_ID)).to.equal(false);
        });

        it('marks an ambiguous send as relayed rather than re-spending', async function () {
            const relay = new AttestationRelay(makeHub());
            relay.setBroadcastHook(async () => {
                const e = new Error('socket hang up');
                e.code = 'ECONNRESET';
                throw e;
            });
            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(true);
            expect(relay._broadcastFailed).to.equal(1);
        });

        it('leaves a never-sent transport failure retryable', async function () {
            const relay = new AttestationRelay(makeHub());
            relay.setBroadcastHook(async () => {
                const e = new Error('connect ECONNREFUSED');
                e.code = 'ECONNREFUSED';
                throw e;
            });
            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(false);
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(true);
        });

        it('leaves a PRE-SEND failure on its own encoder rail retryable', async function () {
            // The shared classifier defaults an unrecognised error to ambiguous, which
            // is right for an opaque operator hook but would permanently suppress a
            // request that merely found the wallet empty. Nothing left the process
            // here, so it must stay retryable.
            const relay = new AttestationRelay(makeHub());
            relay.setEncoder({ getUtxos: async () => [], createTx: async () => ({}), broadcastTx: async () => ({ txid: 'x' }) });
            relay.setWalletSignHook(async () => 'deadbeef');
            relay.btcAddress   = 'mtest';
            relay.btcPubkeyHex = 'ab'.repeat(33);

            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(false);
            expect(relay._finalizedWire.has(REQ_ID)).to.equal(true);
            expect(relay._broadcastFailed).to.equal(1);
        });

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

        it('broadcasts the v4 on the ORIGIN chain, not on the home chain', async function () {
            const relay = new AttestationRelay(makeHub());
            const home = [], origin = [];
            relay.setBroadcastHook(async (p) => { home.push(p); return { txid: 'btc' }; });
            relay.setChainBroadcastHook('LTC', async (p) => { origin.push(p); return { txid: 'ltc' }; });

            await relay._onRoundFinalized(finalizedResponseEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(origin).to.have.length(1);
            expect(origin[0].split('|')[1]).to.equal('4');
            // Handing a v4 to the home hook would put it on BTC, where it is rejected
            // outright ('relay responses land on origin chains only') after the fee.
            expect(home).to.have.length(0);
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(true);
            expect(relay._published.has(REQ_ID)).to.equal(false);
        });

        it('never falls back to the home rail when the origin chain has none', async function () {
            const relay = new AttestationRelay(makeHub());
            const home = [];
            relay.setBroadcastHook(async (p) => { home.push(p); return { txid: 'btc' }; });
            relay.setEncoder({ getUtxos: async () => [{ txid: 'a', vout: 0, value: 1 }], createTx: async () => ({ psbt: 'p' }), broadcastTx: async () => ({ txid: 'x' }) });
            relay.setWalletSignHook(async () => 'deadbeef');
            relay.btcAddress   = 'mtest';
            relay.btcPubkeyHex = 'ab'.repeat(33);

            await relay._onRoundFinalized(finalizedResponseEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(home).to.have.length(0);
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(true);   // retained, not dropped
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(false);
        });

        it('builds the v4 through the origin encoder and signs it with the coin named', async function () {
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

            await relay._onRoundFinalized(finalizedResponseEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(seen.address).to.equal('ltc1qtest');
            expect(seen.coin).to.equal('LTC');
            expect(seen.data.split('|')[1]).to.equal('4');
            expect(relay._publishedResponses.has(REQ_ID)).to.equal(true);
        });

        it('retires a retained v4 once the origin request leaves the pending set', async function () {
            const relay = new AttestationRelay(makeHub({
                getIdentity: () => ({ getPubkeyHex: () => PUBKEY_B, sign: () => SIG_A }),
            }));
            relay.setChainBroadcastHook('LTC', async () => ({ txid: 'ltc' }));
            await relay._onRoundFinalized(finalizedResponseEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(true);

            // A null view is "unknown" and must NOT retire the round.
            relay._originPending.LTC = null;
            await relay._sweepFinalized();
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(true);

            relay._originPending.LTC = new Set();   // the origin closed it: a v4 landed
            await relay._sweepFinalized();
            expect(relay._finalizedResponse.has(REQ_ID)).to.equal(false);
        });

        it('steps in on the response leg only after its failover window', async function () {
            const rankOf = (pk) => sha256(REQ_ID + pk);
            const [first] = [PUBKEY_A, PUBKEY_B].sort((a, b) => (rankOf(a) < rankOf(b) ? -1 : 1));
            const other = first === PUBKEY_A ? PUBKEY_B : PUBKEY_A;

            const relay = new AttestationRelay(makeHub({
                getIdentity: () => ({ getPubkeyHex: () => other, sign: () => SIG_A }),
            }));
            const sent = [];
            relay.setChainBroadcastHook('LTC', async (p) => { sent.push(p); return { txid: 'ltc' }; });
            relay._originPending.LTC = new Set([REQ_ID]);   // still owed

            await relay._onRoundFinalized(finalizedResponseEvent([
                { pubkey: PUBKEY_A, sig: SIG_A }, { pubkey: PUBKEY_B, sig: SIG_A },
            ]));
            expect(sent).to.have.length(0);
            await relay._sweepFinalized();
            expect(sent).to.have.length(0);

            relay._finalizedResponse.get(REQ_ID).finalizedAt = Date.now() - (relay.failoverWindowMs + 1000);
            await relay._sweepFinalized();
            expect(sent).to.have.length(1);
        });

        it('treats an ambiguous failure from the send step as sent', async function () {
            const relay = new AttestationRelay(makeHub());
            relay.setEncoder({
                getUtxos:    async () => [{ txid: 'a', vout: 0, value: 100000 }],
                createTx:    async () => ({ psbt: 'psbt' }),
                broadcastTx: async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; },
            });
            relay.setWalletSignHook(async () => 'deadbeef');
            relay.btcAddress   = 'mtest';
            relay.btcPubkeyHex = 'ab'.repeat(33);

            await relay._onRoundFinalized(finalizedEvent([{ pubkey: PUBKEY_A, sig: SIG_A }]));
            expect(relay._published.has(REQ_ID)).to.equal(true);
        });
    });
});
