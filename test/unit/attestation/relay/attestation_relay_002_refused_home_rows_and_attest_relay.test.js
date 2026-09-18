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
const eq               = require('../../../../src/consensus/equivocation_header.js');
// The reject-slot rule is a registry row (W5); discovery reads it through the
// registry module object, which is where the fixture below moves its threshold.
const gateRegistry     = require('../../../../src/consensus/gate_registry');
const REJECT_SLOT_KEY  = 'attest_relay_reject_slot_activation.ATTEST_RELAY_REJECT_SLOT_ACTIVATION';

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

const refusedHomeRow = () => homeRelayedRow({
                request_status:        'rejected',
                response_action_index: null,
                response_block_index:  null,
                response_hash:         null,
                response_payload:      null,
                response_status:       null,
                meta:                  null,
            });

// A hub whose BTC chain_tips row carries `blockTime`, which is the plane the
            // gate resolves on (the indexer half reads the landing block's own time).
            const hubWithTipTime = (blockTime) => ({
                db: {
                    doQuery:     sinon.stub().resolves([]),
                    getChainTip: sinon.stub().resolves({ blockHeight: 1000, blockTime: blockTime, chainId: null }),
                },
            });

// Drive a threshold rather than the armed map, so both sides of the arm are
            // reachable wherever the networks are armed today: activeAt answers the
            // reject-slot key against `value` on the time plane for `network` and every
            // other key as before. Restored after the call.
            function withThreshold(network, value, fn) {
                const real = gateRegistry.activeAt;
                const stub = sinon.stub(gateRegistry, 'activeAt').callsFake((key, net, coin, height, time) => {
                    if (key !== REJECT_SLOT_KEY || net !== network) return real(key, net, coin, height, time);
                    const t = parseInt(time);
                    return Number.isFinite(t) && t >= value;
                });
                return fn().finally(() => stub.restore());
            }

// ── 3. Discovery gating ─────────────────────────────────────────────────



        // ── The reject-slot half, on both sides of the arm ──────────────────
        //
        // A REFUSED home row names a request that was never materialized: a malformed
        // v3 claimed the id, was stamped 'rejected' and (below the arm) stored. Above
        // the arm the indexer stores no such row, so one in the view is residue and
        // must not answer "already materialized" or the origin's request is stranded.
        // Below the arm the stored refusal still occupies the id fleet-wide, so
        // suppressing the broadcast is what keeps the hub from burning a fee per poll
        // on a v3 every indexer drops.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { describe('refused home rows and ATTEST_RELAY_REJECT_SLOT', function () { it('materializes the request when the gate is ARMED, refused row and all', async function () {
                const relay = makeRelay(hubWithTipTime(1786060800), [originRow()], [refusedHomeRow()]);
                await withThreshold('regtest', 1786060800, () => relay.poll());
                expect(proposedRows(relay, 'request')).to.have.length(1);
                expect(relay._homeRelayed.has(REQ_ID)).to.equal(false);
            }); }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────



        // ── The reject-slot half, on both sides of the arm ──────────────────
        //
        // A REFUSED home row names a request that was never materialized: a malformed
        // v3 claimed the id, was stamped 'rejected' and (below the arm) stored. Above
        // the arm the indexer stores no such row, so one in the view is residue and
        // must not answer "already materialized" or the origin's request is stranded.
        // Below the arm the stored refusal still occupies the id fleet-wide, so
        // suppressing the broadcast is what keeps the hub from burning a fee per poll
        // on a v3 every indexer drops.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { describe('refused home rows and ATTEST_RELAY_REJECT_SLOT', function () { it('still suppresses the request one second BELOW the arm', async function () {
                const relay = makeRelay(hubWithTipTime(1786060799), [originRow()], [refusedHomeRow()]);
                await withThreshold('regtest', 1786060800, () => relay.poll());
                expect(proposedRows(relay, 'request')).to.have.length(0);
                expect(relay._homeRelayed.has(REQ_ID)).to.equal(true);
            }); }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────



        // ── The reject-slot half, on both sides of the arm ──────────────────
        //
        // A REFUSED home row names a request that was never materialized: a malformed
        // v3 claimed the id, was stamped 'rejected' and (below the arm) stored. Above
        // the arm the indexer stores no such row, so one in the view is residue and
        // must not answer "already materialized" or the origin's request is stranded.
        // Below the arm the stored refusal still occupies the id fleet-wide, so
        // suppressing the broadcast is what keeps the hub from burning a fee per poll
        // on a v3 every indexer drops.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { describe('refused home rows and ATTEST_RELAY_REJECT_SLOT', function () { it('suppresses the request when the home tip time is unknown, whatever the arming state', async function () {
                // No tip pushed to this hub: the gate cannot be resolved, so the driver
                // keeps the pre-arm behaviour rather than guessing armed and spending.
                const relay = makeRelay({ db: { doQuery: sinon.stub().resolves([]) } },
                    [originRow()], [refusedHomeRow()]);
                await relay.poll();
                expect(proposedRows(relay, 'request')).to.have.length(0);
                expect(relay._homeRelayed.has(REQ_ID)).to.equal(true);

                // A tip row with no time reads 0 through getChainTip, which is "unknown"
                // and must not satisfy a 0 threshold.
                const zero = makeRelay(hubWithTipTime(0), [originRow()], [refusedHomeRow()]);
                await zero.poll();
                expect(proposedRows(zero, 'request')).to.have.length(0);
                expect(zero._homeRelayed.has(REQ_ID)).to.equal(true);
            }); }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────



        // ── The reject-slot half, on both sides of the arm ──────────────────
        //
        // A REFUSED home row names a request that was never materialized: a malformed
        // v3 claimed the id, was stamped 'rejected' and (below the arm) stored. Above
        // the arm the indexer stores no such row, so one in the view is residue and
        // must not answer "already materialized" or the origin's request is stranded.
        // Below the arm the stored refusal still occupies the id fleet-wide, so
        // suppressing the broadcast is what keeps the hub from burning a fee per poll
        // on a v3 every indexer drops.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { describe('refused home rows and ATTEST_RELAY_REJECT_SLOT', function () { it('drops ONLY refused rows when armed: a fulfilled row still suppresses', async function () {
                // The regression the relayed view exists for must survive the exclusion:
                // a fulfilled BTC row is out of the pending queue but the request IS
                // materialized, and re-broadcasting it burns a fee on a duplicate v3.
                const relay = makeRelay(hubWithTipTime(1786060800), [originRow()], [homeRelayedRow()]);
                await withThreshold('regtest', 1786060800, () => relay.poll());
                expect(proposedRows(relay, 'request')).to.have.length(0);
                expect(relay._homeRelayed.has(REQ_ID)).to.equal(true);
            }); }); }); });

// ── 3. Discovery gating ─────────────────────────────────────────────────



        // ── The reject-slot half, on both sides of the arm ──────────────────
        //
        // A REFUSED home row names a request that was never materialized: a malformed
        // v3 claimed the id, was stamped 'rejected' and (below the arm) stored. Above
        // the arm the indexer stores no such row, so one in the view is residue and
        // must not answer "already materialized" or the origin's request is stranded.
        // Below the arm the stored refusal still occupies the id fleet-wide, so
        // suppressing the broadcast is what keeps the hub from burning a fee per poll
        // on a v3 every indexer drops.
describe('AttestationRelay', function () { beforeEach(hookAt6668); afterEach(hookAt6849); describe('origin discovery', function () { describe('refused home rows and ATTEST_RELAY_REJECT_SLOT', function () { it('leaves an armed hub with no refused rows untouched, and asks the DB nothing', async function () {
                const hub   = hubWithTipTime(1786060800);
                const relay = makeRelay(hub, [originRow()], [homeRelayedRow()]);
                await withThreshold('regtest', 1786060800, () => relay.poll());
                expect(relay._homeRelayed.has(REQ_ID)).to.equal(true);
                // The gate read is only taken when there is a refusal to weigh.
                expect(hub.db.getChainTip.called).to.equal(false);
            }); }); }); });
}
