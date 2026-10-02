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
 * XChain Hub - empty ATTEST batch windows.
 *
 * By the operator ruling of 2026-10-02, an empty window records a local
 * skipped marker and publishes nothing. This gives up chain-only proof that
 * a quiet hour was quiet while preserving every window that carries responses.
 *
 ********************************************************************/

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { expect } = require('chai');

const AttestationBatchPublisher = require('../../../../../src/attestation/batch_publisher.js');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');

const WINDOW_S = 10;
const ANCHOR = 941234;

function makeRow(effectiveTime){
    return {
        network: 'regtest',
        request_id: crypto.randomBytes(32).toString('hex'),
        request_action_index: 4400,
        request_block_index: 120,
        provider_id: 'http_get',
        status: 'ok',
        response_payload: '{"ok":true}',
        response_hash: crypto.createHash('sha256').update('body').digest('hex'),
        meta: '200',
        effective_time: effectiveTime,
        admit_block_btc: null,
        signer_pubkeys: '[]',
        signatures: '[]',
        widen: 0
    };
}

function makeDb(){
    let responses = [], markers = [];
    let findMarker = (start) => markers.find(m => Number(m.window_start) === Number(start));
    let upsert = (row) => {
        let current = findMarker(row.window_start);
        if(current) Object.assign(current, row);
        else markers.push(row);
    };
    return {
        responses,
        markers,
        marker: findMarker,
        async doQuery(){ throw new Error('raw SQL was not expected'); },
        async findAttestationResponsesInBatchWindow(network, from, to, limit){
            return responses
                .filter(r => r.network === network && r.effective_time >= from && r.effective_time < to)
                .slice(0, limit);
        },
        async findAttestPublishedBatchesByNetwork(network, start){
            let marker = findMarker(start);
            return marker && marker.network === network ? [Object.assign({}, marker)] : [];
        },
        async deleteAttestPublishedBatch(network, start, status){
            let index = markers.findIndex(m => m.network === network &&
                Number(m.window_start) === Number(start) && m.status === status);
            if(index < 0) return { affectedRows: 0 };
            markers.splice(index, 1);
            return { affectedRows: 1 };
        },
        async setAttestPublishedBatchByNetworkAndWindowStart(
            network, windowStart, windowEnd, rowCount, status
        ){
            upsert({ network, window_start: windowStart, window_end: windowEnd,
                row_count: rowCount, status });
            return { affectedRows: 1 };
        },
        async setAttestPublishedBatchByNetwork(
            network, windowStart, windowEnd, batchKey, rowCount, status
        ){
            if(findMarker(windowStart)) return { affectedRows: 0 };
            markers.push({ network, window_start: windowStart, window_end: windowEnd,
                batch_key: batchKey, row_count: rowCount, status });
            return { affectedRows: 1 };
        },
        async updateAttestPublishedBatch(status, txid, rowCount, network, start, fromStatus){
            let marker = findMarker(start);
            if(!marker || marker.network !== network || marker.status !== fromStatus)
                return { affectedRows: 0 };
            Object.assign(marker, { status, txid, row_count: rowCount });
            return { affectedRows: 1 };
        },
        async setAttestPublishedBatchByNetworkAndWindowStartAndWindowEnd(
            network, windowStart, windowEnd, rowCount, txid, status
        ){
            upsert({ network, window_start: windowStart, window_end: windowEnd,
                row_count: rowCount, txid, status });
            return { affectedRows: 1 };
        }
    };
}

function makePublisher(dir, db){
    let generated = ValidatorIdentity.generate();
    let identity = new ValidatorIdentity(generated.privkeyHex);
    let pubkey = identity.getPubkeyHex().toLowerCase();
    let hub = {
        network: 'regtest',
        db,
        p2pConfig: {
            ATTEST_BATCH_WINDOW_S_OVERRIDE: String(WINDOW_S),
            ATTEST_BATCH_BUFFER_PATH: path.join(dir, 'attest-batch-buffer.jsonl'),
            ATTEST_BATCH_SPEND_STATE_PATH: path.join(dir, 'spend-state.json')
        },
        getIdentity: () => identity,
        capabilitySnapshot: {
            async getWeightSnapshot(){
                return { validators: [{ pubkey, weight: '1', amount: '1', source: 'test' }], count: 1 };
            },
            async getSnapshot(){
                return { validators: [{ pubkey, weight: '1', amount: '1', source: 'test' }], count: 1 };
            }
        }
    };
    let publisher = new AttestationBatchPublisher(hub);
    publisher.resolveAnchor = async () => ANCHOR;
    publisher.persistAttestationSnapshot = async () => 0;
    publisher.wires = [];
    publisher.setBroadcastHook(async (wire) => {
        publisher.wires.push(wire);
        return { txid: 'tx' + publisher.wires.length };
    });
    return publisher;
}

describe('AttestationBatchPublisher empty windows', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-empty-window-'));
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('broadcasts and signs nothing, reads no anchor, and records skipped', async function () {
        let db = makeDb();
        let publisher = makePublisher(dir, db);
        let now = 200 * WINDOW_S;
        let start = now - WINDOW_S;
        let anchorReads = 0;
        publisher.resolveAnchor = async () => { anchorReads++; return ANCHOR; };
        publisher._floorWindow = start;

        let result = await publisher.sweep(now);

        expect(result).to.deep.equal({ attempted: 1, published: 0 });
        expect(anchorReads).to.equal(0);
        expect(publisher.stats.signRounds).to.equal(0);
        expect(publisher.wires).to.deep.equal([]);
        expect(db.marker(start)).to.include({ status: 'skipped', row_count: 0 });
        expect(publisher.stats.windowsEmpty).to.equal(1);
    });

    it('passes over skipped until a late row arrives, then publishes it', async function () {
        let db = makeDb();
        let publisher = makePublisher(dir, db);
        let now = 200 * WINDOW_S;
        let start = now - WINDOW_S;
        publisher._floorWindow = start;

        await publisher.sweep(now);
        let quietSweep = await publisher.sweep(now);
        expect(quietSweep).to.deep.equal({ attempted: 0, published: 0 });
        expect(publisher.wires).to.have.length(0);

        db.responses.push(makeRow(start + 1));
        let lateSweep = await publisher.sweep(now);

        expect(lateSweep).to.deep.equal({ attempted: 1, published: 1 });
        expect(publisher.wires).to.have.length(1);
        expect(db.marker(start).status).to.equal('sent');
    });
});

describe('AttestationBatchPublisher reopened windows', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-empty-window-'));
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does not report a skipped window below a newer sent marker as a gap', async function () {
        let db = makeDb();
        let publisher = makePublisher(dir, db);
        let now = 200 * WINDOW_S;
        let start = now - 2 * WINDOW_S;
        db.markers.push(
            { network: 'regtest', window_start: start, window_end: start + WINDOW_S,
                row_count: 0, status: 'skipped' },
            { network: 'regtest', window_start: start + WINDOW_S, window_end: now,
                row_count: 1, status: 'sent' }
        );
        publisher._floorWindow = start;
        publisher._newestMarkerWindow = start + WINDOW_S;
        db.responses.push(makeRow(start + 1));

        let errors = [];
        let realError = console.error;
        console.error = (line) => errors.push(String(line));
        let pending;
        try { pending = await publisher.pendingWindows(now); }
        finally { console.error = realError; }

        expect(pending).to.deep.equal([{ windowStart: start, age: 1 }]);
        expect(errors.filter(line => /has no batch marker/.test(line))).to.deep.equal([]);
        expect(publisher.stats.coverageGapsDetected).to.equal(0);
        expect(publisher._coverageGaps.size).to.equal(0);
        expect(publisher._quarantined.size).to.equal(0);
    });

    it('publishes a window with rows as before', async function () {
        let db = makeDb();
        let publisher = makePublisher(dir, db);
        let now = 200 * WINDOW_S;
        let start = now - WINDOW_S;
        db.responses.push(makeRow(start + 1));
        publisher._floorWindow = start;

        let result = await publisher.sweep(now);

        expect(result).to.deep.equal({ attempted: 1, published: 1 });
        expect(publisher.wires).to.have.length(1);
        expect(publisher.stats.windowsPublished).to.equal(1);
        expect(publisher.stats.windowsEmpty).to.equal(0);
        expect(db.marker(start).status).to.equal('sent');
    });
});

describe('AttestationBatchPublisher skipped marker landing', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-empty-window-'));
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lets a landed marker replace a skipped marker', async function () {
        let db = makeDb();
        let publisher = makePublisher(dir, db);
        let start = 199 * WINDOW_S;

        await publisher.recordSkipped(start, start + WINDOW_S);
        await publisher.recordLandedWindow(start, start + WINDOW_S, 'dogetxid', 0);

        expect(db.marker(start)).to.include({ status: 'landed', txid: 'dogetxid' });
    });
});
