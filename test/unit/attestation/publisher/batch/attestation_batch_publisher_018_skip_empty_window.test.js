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
 * XChain Hub - a catch-up sweep over empty ATTEST batch windows.
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

function guard(publisher){
    let touched = [];
    for(let name of ['resolveAnchor', 'electionRank', 'persistAttestationSnapshot', 'collectBatchSignatures']){
        publisher[name] = async () => { touched.push(name); return null; };
    }
    return touched;
}

function registerSeveralEmptyWindows(ctx){
    it('spends nothing across several empty windows in one sweep', async function () {
        let db = makeDb();
        let publisher = makePublisher(ctx.dir, db);
        let touched = guard(publisher);
        let now = 200 * WINDOW_S;
        publisher._floorWindow = now - 3 * WINDOW_S;

        let result = await publisher.sweep(now);

        expect(result).to.deep.equal({ attempted: 3, published: 0 });
        expect(touched).to.deep.equal([]);
        expect(publisher.wires).to.deep.equal([]);
        expect(publisher.stats.windowsEmpty).to.equal(3);
        expect(publisher.stats.windowsPublished).to.equal(0);
        for(let i = 1; i <= 3; i++)
            expect(db.marker(now - i * WINDOW_S)).to.include({ status: 'skipped', row_count: 0 });
    });
}

function registerMixedWindows(ctx){
    it('publishes only the window that holds a response among empty ones', async function () {
        let db = makeDb();
        let publisher = makePublisher(ctx.dir, db);
        let now = 200 * WINDOW_S;
        let busy = now - 2 * WINDOW_S;
        publisher._floorWindow = now - 3 * WINDOW_S;
        db.responses.push(makeRow(busy + 1));

        let result = await publisher.sweep(now);

        expect(result).to.deep.equal({ attempted: 3, published: 1 });
        expect(publisher.wires.length).to.be.greaterThan(0);
        expect(db.marker(busy).status).to.equal('sent');
        expect(db.marker(now - 3 * WINDOW_S).status).to.equal('skipped');
        expect(db.marker(now - WINDOW_S).status).to.equal('skipped');
        expect(publisher.stats.windowsEmpty).to.equal(2);
        expect(publisher.stats.windowsPublished).to.equal(1);
    });
}

function registerFollowingSweep(ctx){
    it('does not re-offer skipped windows to a sweep that follows', async function () {
        let db = makeDb();
        let publisher = makePublisher(ctx.dir, db);
        let now = 200 * WINDOW_S;
        publisher._floorWindow = now - 2 * WINDOW_S;

        await publisher.sweep(now);
        let pending = await publisher.pendingWindows(now);
        let again = await publisher.sweep(now);

        expect(pending).to.deep.equal([]);
        expect(again).to.deep.equal({ attempted: 0, published: 0 });
        expect(publisher.stats.windowsEmpty).to.equal(2);
    });
}

function registerFailedRead(ctx){
    it('records nothing and spends nothing when the window read fails', async function () {
        let db = makeDb();
        let publisher = makePublisher(ctx.dir, db);
        let now = 200 * WINDOW_S;
        let start = now - WINDOW_S;
        publisher._floorWindow = start;
        db.findAttestationResponsesInBatchWindow = async () => { throw new Error('read down'); };

        let result = await publisher.sweep(now);

        expect(result).to.deep.equal({ attempted: 1, published: 0 });
        expect(db.marker(start)).to.equal(undefined);
        expect(publisher.stats.windowsEmpty).to.equal(0);
        expect(publisher.stats.windowsDeferred).to.equal(1);
    });
}

describe('AttestationBatchPublisher skip empty windows', function () {
    let ctx = {};

    beforeEach(function () {
        ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-skip-empty-'));
    });

    afterEach(function () {
        fs.rmSync(ctx.dir, { recursive: true, force: true });
    });

    registerSeveralEmptyWindows(ctx);
    registerMixedWindows(ctx);
    registerFollowingSweep(ctx);
    registerFailedRead(ctx);
});
