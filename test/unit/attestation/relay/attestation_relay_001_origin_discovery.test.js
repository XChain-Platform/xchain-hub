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
        // Restore by key, never by assignment: a module that holds the
        // environment by reference (the activation registry arms its regtest
        // rows from it at each read) must keep seeing the live object.
        for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
        Object.assign(process.env, envSnapshot);
        sinon.restore();
    };

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('materializes a confirmed relay-eligible request onto BTC', async function () {
            const relay = makeRelay();
            await relay.poll();
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
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('ignores a request that carries no origin_chain stamp', async function () {
            const relay = makeRelay({}, [originRow({ origin_chain: null })]);
            await relay.poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('ignores a request stamped for a different origin chain', async function () {
            const relay = makeRelay({}, [originRow({ origin_chain: 'DOGE' })]);
            await relay.poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('holds a request that has not reached the origin confirmation depth', async function () {
            const relay = makeRelay();
            const needed = relay.confirmations.LTC;
            relay.indexerCall = sinon.stub().callsFake(async (coin) => {
                if (coin === 'BTC') return { latest_block_index: 1000, requests: [] };
                if (coin === 'LTC') return {
                    // One block short of the depth.
                    latest_block_index: 3160000 + needed - 2,
                    requests: [originRow()],
                };
                return { latest_block_index: 0, requests: [] };
            });
            await relay.poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('does not re-materialize a request already pending on BTC', async function () {
            const relay = makeRelay();
            relay.indexerCall = sinon.stub().callsFake(async (coin) => {
                if (coin === 'BTC') return { latest_block_index: 1000, requests: [{ request_id: REQ_ID, block_index: 900, action_index: 1 }] };
                if (coin === 'LTC') return { latest_block_index: 3160099, requests: [originRow()] };
                return { latest_block_index: 0, requests: [] };
            });
            await relay.poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('does not re-materialize a request the WAL records as already relayed', async function () {
            const relay = makeRelay();
            relay._published.mark(REQ_ID);
            await relay.poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('refuses a payload containing a pipe, which the positional wire cannot carry', async function () {
            const relay = makeRelay({}, [originRow({ payload: 'https://example.com/a|b' })]);
            await relay.poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('refuses a request whose deadline is not a positive block count', async function () {
            const relay = makeRelay({}, [originRow({ deadline_block: 3160000 })]);
            await relay.poll();
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('does not re-materialize a request BTC has already FULFILLED', async function () {
            // The regression that motivated the relayed-requests read: a fulfilled BTC
            // row is no longer in the pending queue, while the ORIGIN row stays pending
            // until the v4 lands. On the pending view alone that window reads as never
            // materialized, and the duplicate v3 is rejected on-chain after the fee.
            const relay = makeRelay({}, [originRow()], [homeRelayedRow()]);
            await relay.poll();
            expect(proposedRows(relay, 'request')).to.have.length(0);
        }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { it('keeps the previous home-pending view when the BTC indexer is unreachable', async function () {
            const relay = makeRelay();
            relay._homePending = new Set([REQ_ID]);
            relay.indexerCall = sinon.stub().callsFake(async (coin) => {
                if (coin === 'BTC') throw new Error('connect ECONNREFUSED');
                if (coin === 'LTC') return { latest_block_index: 3160099, requests: [originRow()] };
                return { latest_block_index: 0, requests: [] };
            });
            await relay.poll();
            // Relaying while blind to BTC is what double-spends the fee.
            expect(relay.consensus.propose.called).to.equal(false);
        }); }); });
}
