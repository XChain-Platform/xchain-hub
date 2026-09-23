/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Hub - one durable claim and one broadcast per ATTEST batch window.
 *
 ********************************************************************/

'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const AttestationBatchPublisher = require('../../../../../src/attestation/batch_publisher.js');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const abw = require('../../../../../src/lib/attest_batch_wire.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const WINDOW_S = 10;
const ANCHOR = 941234;

// A shared durable marker table. INSERT executes synchronously before the returned
// promise resolves, matching the unique-key decision made by MariaDB.
function makeDb(){
    let markers = [];
    let insertAttempts = 0;
    return { ...DB_METHODS,
        markers,
        get insertAttempts(){ return insertAttempts; },
        marker(windowStart){
            return markers.find(m => Number(m.window_start) === Number(windowStart)) || null;
        },
        async getChainTip(){ return { blockHeight: ANCHOR, blockTime: 1 }; },
        async doQuery(sql, args){
            if(/^DELETE FROM attest_published_batches/i.test(sql)){
                let [network, windowStart, fromStatus] = args;
                let i = markers.findIndex(m => m.network === network &&
                    Number(m.window_start) === Number(windowStart) && m.status === fromStatus);
                if(i < 0) return { affectedRows: 0 };
                markers.splice(i, 1);
                return { affectedRows: 1 };
            }
            if(/^INSERT (?:IGNORE )?INTO attest_published_batches/i.test(sql)){
                insertAttempts++;
                let [network, windowStart, windowEnd, batchKey, rowCount, status] = args;
                let existing = markers.find(m => m.network === network &&
                    Number(m.window_start) === Number(windowStart));
                if(existing) return { affectedRows: 0 };
                markers.push({ network, window_start: windowStart, window_end: windowEnd,
                    batch_key: batchKey, row_count: rowCount, status, txid: null });
                return { affectedRows: 1 };
            }
            if(/^UPDATE attest_published_batches SET status/i.test(sql)){
                let [status, txid, rowCount, network, windowStart, fromStatus] = args;
                let marker = markers.find(m => m.network === network &&
                    Number(m.window_start) === Number(windowStart) && m.status === fromStatus);
                if(!marker) return { affectedRows: 0 };
                Object.assign(marker, { status, txid, row_count: rowCount });
                return { affectedRows: 1 };
            }
            if(/FROM attest_published_batches WHERE network = \? AND window_start = \?/i.test(sql)){
                let marker = markers.find(m => m.network === args[0] &&
                    Number(m.window_start) === Number(args[1]));
                return marker ? [Object.assign({}, marker)] : [];
            }
            throw new Error('unexpected statement: ' + sql);
        }
    };
}

function makeHub(db, identity, dir, index){
    let pubkey = identity.getPubkeyHex().toLowerCase();
    let snapshot = {
        validators: [{ pubkey, weight: '100', amount: '100', source: 'validator-' + index }],
        count: 1
    };
    return {
        network: 'regtest',
        db,
        p2pConfig: {
            ATTEST_BATCH_WINDOW_S_OVERRIDE: String(WINDOW_S),
            ATTEST_BATCH_BUFFER_PATH: path.join(dir, 'buffer-' + index + '.jsonl'),
            ATTEST_BATCH_SPEND_STATE_PATH: path.join(dir, 'spend-' + index + '.json'),
            ORACLE_BATCH_SIGN_TIMEOUT_MS: '40'
        },
        getIdentity: () => identity,
        capabilitySnapshot: {
            async getWeightSnapshot(){ return snapshot; },
            async getSnapshot(){ return snapshot; }
        },
        peerManager: null
    };
}

function makePublisher(hub){
    let publisher = new AttestationBatchPublisher(hub);
    let wires = [];
    publisher.setBroadcastHook(async payload => {
        wires.push(payload);
        return { txid: 'tx-' + wires.length };
    });
    publisher.wires = wires;
    return publisher;
}

function emptyWindow(){
    let windowStart = 199 * WINDOW_S;
    return {
        network: 'regtest',
        window_start: windowStart,
        window_end: windowStart + WINDOW_S,
        row_count: 0,
        btc_block_height: ANCHOR,
        rows: []
    };
}

// Hold every publisher after signing so they reach the durable claim as peers,
// rather than letting the first finish before the others start.
function holdAtClaim(publishers){
    let arrived = 0;
    let release;
    let gate = new Promise(resolve => { release = resolve; });
    for(let publisher of publishers){
        let collect = publisher.collectBatchSignatures.bind(publisher);
        publisher.collectBatchSignatures = async (window, batchKey) => {
            let signed = await collect(window, batchKey);
            arrived++;
            if(arrived === publishers.length) release();
            await gate;
            return signed;
        };
    }
}

function makeThreePublishers(db, dir){
    return [1, 2, 3].map(index => {
        let identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        return makePublisher(makeHub(db, identity, dir, index));
    });
}

describe('AttestationBatchPublisher', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-one-window-'));
    });

    afterEach(function () {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    });

    describe('one broadcast per window', function () {
        it('lets one of three validator publishers claim and broadcast the shared window', async function () {
            let db = makeDb();
            let publishers = makeThreePublishers(db, dir);
            expect(new Set(publishers.map(p => p.identity.getPubkeyHex())).size).to.equal(3);
            holdAtClaim(publishers);

            let window = emptyWindow();
            let batchKey = abw.computeBatchKey(window);
            let results = await Promise.all(publishers.map(p =>
                p.signAndBroadcastWindow(Object.assign({}, window, { rows: [] }), batchKey)));

            expect(results.filter(Boolean).length).to.equal(1);
            expect(publishers.reduce((n, p) => n + p.wires.length, 0)).to.equal(1);
            expect(db.insertAttempts).to.equal(3);
            expect(db.markers).to.have.length(1);
            expect(db.marker(window.window_start).status).to.equal('sent');
        });

        it('does not claim a window when the broadcast pipeline cannot attempt a send', async function () {
            let db = makeDb();
            let identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
            let publisher = new AttestationBatchPublisher(makeHub(db, identity, dir, 1));
            let window = emptyWindow();

            expect(await publisher.signAndBroadcastWindow(
                window, abw.computeBatchKey(window))).to.equal(false);
            expect(db.insertAttempts).to.equal(0);
            expect(db.marker(window.window_start)).to.equal(null);
        });
    });
});
