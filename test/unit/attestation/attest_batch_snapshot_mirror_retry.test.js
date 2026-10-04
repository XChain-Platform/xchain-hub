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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const AttestationBatchPublisher = require('../../../src/attestation/batch_publisher.js');

const ANCHOR = 941234;
const SET = [
    { pubkey: '02' + '11'.repeat(32), weight: '7', source: 'alpha' },
    { pubkey: '03' + '22'.repeat(32), weight: '5', source: 'beta' }
];

function makeHarness(){
    let stored = new Map();
    let streamed = [];
    let db = {
        async getChainTip(){ return null; },
        async createCapabilitySnapshots(rows){
            for(let row of rows)
                stored.set(row.signing_pubkey + ':' + row.source, Object.assign({}, row));
        },
        async getCapabilitySnapshot(block, capability, pubkey, source){
            let row = stored.get(pubkey + ':' + source);
            return row && row.snapshot_block === block && row.capability === capability ? [row] : [];
        }
    };
    let hub = {
        db: db,
        capabilitySnapshot: {
            async getWeightSnapshot(){ return { validators: SET, count: SET.length }; },
            async getSnapshot(){ return { validators: SET, count: SET.length }; }
        },
        hubDbBroadcaster: {
            broadcastRow(message){ streamed.push(message.row.signing_pubkey); }
        }
    };
    let publisher = Object.create(AttestationBatchPublisher.prototype);
    Object.assign(publisher, {
        hub: hub,
        db: db,
        network: 'regtest',
        identity: null,
        _persistedAnchors: new Set()
    });
    return { publisher, db, hub, streamed };
}

async function expectFailure(promise, message){
    let error = null;
    try { await promise; } catch(e){ error = e; }
    expect(error).to.be.an('error');
    expect(error.message).to.equal(message);
}

describe('Attestation batch snapshot mirror retry', function () {
    it('retries every row after a snapshot read throws', async function () {
        let h = makeHarness();
        let reads = 0;
        let get = h.db.getCapabilitySnapshot.bind(h.db);
        h.db.getCapabilitySnapshot = async function (...args){
            if(++reads === 1) throw new Error('snapshot read failed');
            return get(...args);
        };

        await expectFailure(h.publisher.persistAttestationSnapshot(ANCHOR, SET), 'snapshot read failed');
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(false);

        await h.publisher.persistAttestationSnapshot(ANCHOR, SET);
        expect(h.streamed).to.deep.equal(SET.map(v => v.pubkey));
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(true);
    });

    it('retries every row after a broadcast throws', async function () {
        let h = makeHarness();
        let failed = false;
        h.hub.hubDbBroadcaster.broadcastRow = function (message){
            if(!failed){
                failed = true;
                throw new Error('stream failed');
            }
            h.streamed.push(message.row.signing_pubkey);
        };

        await expectFailure(h.publisher.persistAttestationSnapshot(ANCHOR, SET), 'stream failed');
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(false);

        await h.publisher.persistAttestationSnapshot(ANCHOR, SET);
        expect(h.streamed).to.deep.equal(SET.map(v => v.pubkey));
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(true);
    });

    it('records a clean delivery and does not stream it twice', async function () {
        let h = makeHarness();

        expect(await h.publisher.persistAttestationSnapshot(ANCHOR, SET)).to.equal(SET.length);
        expect(await h.publisher.persistAttestationSnapshot(ANCHOR, SET)).to.equal(0);

        expect(h.streamed).to.deep.equal(SET.map(v => v.pubkey));
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(true);
    });
});

describe('Attestation batch leader snapshot gate', function () {
    it('does not start the leader signing round until snapshot delivery succeeds', async function () {
        let h = makeHarness();
        let signingRounds = 0;
        let fail = true;
        h.db.getCapabilitySnapshot = async function (block, capability, pubkey, source){
            if(fail) throw new Error('leader delivery failed');
            let row = {
                snapshot_block: block,
                capability: capability,
                signing_pubkey: pubkey,
                source: source
            };
            return [row];
        };
        Object.assign(h.publisher, {
            windowS: 10,
            network: 'regtest',
            stats: { windowsDeferred: 0 },
            readWindowRows: async () => [{ request_id: 'row' }],
            reportCoverageGap: () => {},
            resolveAnchor: async () => ANCHOR,
            electionRank: async () => ({ rank: 0, count: SET.length }),
            signAndBroadcastWindow: async () => { signingRounds++; return true; }
        });

        await expectFailure(h.publisher.publishWindow(100, 0, false), 'leader delivery failed');
        expect(signingRounds).to.equal(0);
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(false);

        fail = false;
        expect(await h.publisher.publishWindow(100, 0, false)).to.equal(true);
        expect(signingRounds).to.equal(1);
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(true);
    });
});

describe('Attestation batch follower snapshot gate', function () {
    it('does not send a follower signature until snapshot delivery succeeds', async function () {
        let h = makeHarness();
        let signatures = 0;
        let fail = true;
        let me = SET[0].pubkey;
        h.hub.peerManager = { broadcast(){} };
        h.hub.hubDbBroadcaster.broadcastRow = function (message){
            if(fail) throw new Error('follower delivery failed');
            h.streamed.push(message.row.signing_pubkey);
        };
        Object.assign(h.publisher, {
            network: 'regtest',
            identity: { getPubkeyHex: () => me },
            signReqBounds: () => ({ windowStart: 100, windowEnd: 110 }),
            resolveAnchor: async () => ANCHOR,
            resolveAttestationSet: async () => SET,
            selectWindowRows: async () => [{ request_id: 'row' }],
            coSignVerdict: () => ({ ok: true }),
            sendWindowSignature: () => { signatures++; }
        });
        let envelope = {
            sig_pubkey: SET[1].pubkey,
            data: { network: 'regtest', btc_block_height: ANCHOR, rows: [] }
        };

        await expectFailure(h.publisher.handleSignReq(envelope), 'follower delivery failed');
        expect(signatures).to.equal(0);
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(false);

        fail = false;
        await h.publisher.handleSignReq(envelope);
        expect(signatures).to.equal(1);
        expect(h.streamed).to.deep.equal(SET.map(v => v.pubkey));
        expect(h.publisher._persistedAnchors.has(ANCHOR)).to.equal(true);
    });
});
