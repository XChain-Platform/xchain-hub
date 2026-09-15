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

describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('ATTEST v4 wire', function () { it('emits the field order the origin indexer parses positionally', function () {
            const relay = new AttestationRelay(makeHub());
            const b64   = Buffer.from(RESPONSE_BODY, 'utf8').toString('base64');
            const wire  = relay.buildResponseWire({
                request_id: REQ_ID, home_response_action_index: 9002, response_payload_b64: b64,
                status: 'ok', meta: '200', snapshot_block: 963000,
            }, [{ pubkey: PUBKEY_A, sig: SIG_A }]);

            const parts = wire.split('|');
            // Mirrors xchain-indexer/src/actions/attest/index.js formats[4]:
            // VERSION|REQUEST_ID|HOME_RESPONSE_ACTION_INDEX|RESPONSE_PAYLOAD|STATUS|META|
            // SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...
            expect(parts[0]).to.equal('ATTEST');
            expect(parts[1]).to.equal('4');
            expect(parts[2]).to.equal(REQ_ID);
            expect(parts[3]).to.equal('9002');
            expect(parts[4]).to.equal(b64);
            expect(parts[5]).to.equal('ok');
            expect(parts[6]).to.equal('200');
            expect(parts[7]).to.equal('963000');
            // The indexer strips the leading 'ATTEST' before indexing, so its params[N]
            // is wire index N+1: parseRelaySigs(params, 7) reads the count at index 8.
            expect(parts[8]).to.equal('1');
            expect(parts[9]).to.equal(PUBKEY_A);
            expect(parts[10]).to.equal(SIG_A);
        }); }); });

describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('ATTEST v4 wire', function () { it('carries an empty body and an empty meta as empty fields, not as gaps', function () {
            const relay = new AttestationRelay(makeHub());
            const wire  = relay.buildResponseWire({
                request_id: REQ_ID, home_response_action_index: 1, response_payload_b64: '',
                status: 'expired', meta: null, snapshot_block: 1,
            }, [{ pubkey: PUBKEY_A, sig: SIG_A }]);
            const parts = wire.split('|');
            expect(parts[4]).to.equal('');
            expect(parts[6]).to.equal('');
            expect(parts[8]).to.equal('1');
        }); }); });

describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('ATTEST v4 wire', function () { it('refuses a v4 wire over the encoder payload ceiling', function () {
            const relay = new AttestationRelay(makeHub());
            expect(relay.wireFault({
                phase: 'response', request_id: REQ_ID, home_response_action_index: 1,
                response_payload_b64: 'x'.repeat(9000), status: 'ok', meta: '', snapshot_block: 1,
            }, 1)).to.match(/ATTEST v4 wire is .* over the encoder limit/);
        }); }); });
}
