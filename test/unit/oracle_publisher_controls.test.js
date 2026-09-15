'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -


const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const path           = require('path');
const os             = require('os');
const { DB_METHODS } = require('../helpers/mockHub');


let fsMock;
let OraclePublisher;

function loadModule() {
    fsMock = {
        mkdirSync:     sinon.stub(),
        existsSync:    sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        openSync:      sinon.stub().returns(99),
        writeSync:     sinon.stub(),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        readFileSync:  sinon.stub().returns('')
    };
    OraclePublisher = proxyquire('../../src/oracle/publisher', {
        fs: fsMock,
        '../peers/encoder_client': function () { return null; }
    });
}

function makeIdentity(pubkey) {
    return {
        getPubkeyHex: sinon.stub().returns(pubkey || 'aa'.repeat(32)),
        sign:         sinon.stub().returns('bb'.repeat(64))
    };
}

function makeHub(overrides) {
    return {
        p2pConfig:          overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getIdentity:        sinon.stub().returns(makeIdentity()),
        capabilityRegistry: overrides && overrides.capabilityRegistry !== undefined
            ? overrides.capabilityRegistry : null,
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        oracleConsensus:    overrides && overrides.oracleConsensus !== undefined
            ? overrides.oracleConsensus : null,
        ...(overrides || {})
    };
}


function makeDb(seed) {
    let markers = Object.assign({}, seed || {});
    let db = {


        ...DB_METHODS,
        markers,
        doQuery: sinon.stub().callsFake(async function (q, args) {
            if (/^\s*SELECT/i.test(q)) {
                if (/WHERE\s+round/i.test(q)) {
                    let r = Number(args[0]);
                    return markers[r] ? [markers[r]] : [];
                }
                return Object.keys(markers).map(k => markers[k]);
            }
            if (/^\s*INSERT/i.test(q)) {
                let r = Number(args[0]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                return { affectedRows: 1 };
            }
            if (/^\s*UPDATE/i.test(q)) {
                let txid = args[0];
                let r    = Number(args[args.length - 1]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                markers[r].txid    = txid;
                markers[r].sent_at = '2026-01-01 00:00:00';
                return { affectedRows: 1 };
            }


            if (/^\s*DELETE/i.test(q)) {
                let cutoff       = Number(args[0]);
                let confirmedOnly = /sent_at\s+IS\s+NOT\s+NULL/i.test(q);
                let deleted = 0;
                for (let k of Object.keys(markers)) {
                    let row = markers[k];
                    if (!(Number(row.round) < cutoff)) continue;
                    if (confirmedOnly && (row.sent_at === null || row.sent_at === undefined)) continue;
                    delete markers[k];
                    deleted++;
                }
                return { affectedRows: deleted };
            }
            return [];
        })
    };
    return db;
}


// Only broadcast_tx can leave a transaction on the wire. get_utxos, create_tx
// and the wallet sign hook all run before anything is sent, so their failures
// are definitively never-sent however they look on the socket, and must requeue
// rather than dead-letter. The shared classifier answers "ambiguous" for an
// unrecognised error, which is the right default for a broadcaster this module
// knows nothing about and the wrong one for a stage it knows never sends.
function defaultPipelinePub() {
    let pub = new OraclePublisher(makeHub());
    pub.encoder = {
        getUtxos:    sinon.stub().resolves([{ txid: 'a', vout: 0, value: 100000, confirmations: 10 }]),
        createTx:    sinon.stub().resolves({ psbt: 'psbthex' }),
        broadcastTx: sinon.stub().resolves({ txid: 'TXID' })
    };
    pub.walletSignFn  = sinon.stub().resolves('signedtxhex');
    pub.dogeAddress   = 'DwhateverAddress';
    pub.dogePubkeyHex = '02' + 'a'.repeat(64);
    pub.getBalanceFn  = sinon.stub().resolves(50);
    return pub;
}

async function runQueueWith(pub) {
    let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
    fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
    let dead = sinon.stub(pub, 'deadLetter');
    await pub._processQueue();
    let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
    return { dead, rewritten };
}
function oraclePublisherTests(title, registerTests) {
    describe('OraclePublisher', function () {
        beforeEach(function () {
            loadModule();
        });

        afterEach(function () {
            sinon.restore();
        });

        describe(title, registerTests);
    });
}


// ── item 2676: hard balance floor gate + per-window spend ceiling ──────────
oraclePublisherTests('spend gating (item 2676)', function () {
    afterEach(function () {
        delete process.env.ORACLE_PUBLISH_MAX_PUBLISHES_PER_WINDOW;
        delete process.env.ORACLE_PUBLISH_SPEND_WINDOW_MS;
    });

    it('skips the whole publish pass when balance is below the floor', async function () {
        let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let broadcastStub = sinon.stub().resolves({ txid: 'x' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(3);   // below default floor 10
        await pub._processQueue();
        expect(broadcastStub.called).to.be.false;
    });

    it('skips the whole publish pass when balance is unreadable (fail-closed)', async function () {
        let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let broadcastStub = sinon.stub().resolves({ txid: 'x' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().rejects(new Error('rpc down'));  // -> null
        await pub._processQueue();
        expect(broadcastStub.called).to.be.false;
    });

    // The encoder-summed branch is the production default whenever the signer
    // module exports no getBalance, and it is the branch that summed satoshis
    // into the whole-DOGE floor. Both directions are pinned so a re-scaled sum
    // cannot pass by jamming the gate shut either.
    it('skips the publish pass when the encoder-summed wallet is below the floor', async function () {
        let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let broadcastStub = sinon.stub().resolves({ txid: 'x' });
        pub.broadcastFn = broadcastStub;
        pub.dogeAddress = 'D123';
        pub.encoder = { getUtxos: sinon.stub().resolves([{ value: '400000000', amount: '4.00000000' }]) };
        await pub._processQueue();
        expect(broadcastStub.called).to.be.false;   // 4 DOGE, floor 10
    });

});

oraclePublisherTests('spend gating (item 2676)', function () {
    afterEach(function () {
        delete process.env.ORACLE_PUBLISH_MAX_PUBLISHES_PER_WINDOW;
        delete process.env.ORACLE_PUBLISH_SPEND_WINDOW_MS;
    });

    it('publishes when the encoder-summed wallet clears the floor', async function () {
        let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let broadcastStub = sinon.stub().resolves({ txid: 'x' });
        pub.broadcastFn = broadcastStub;
        pub.dogeAddress = 'D123';
        pub.encoder = { getUtxos: sinon.stub().resolves([{ value: '1500000000', amount: '15.00000000' }]) };
        await pub._processQueue();
        expect(broadcastStub.called).to.be.true;    // 15 DOGE, floor 10
    });

    it('stops broadcasting once the per-window ceiling is reached, keeping rounds queued', async function () {
        process.env.ORACLE_PUBLISH_MAX_PUBLISHES_PER_WINDOW = '1';
        let e1 = { round: 1, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        let e2 = { round: 2, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
        let pub = new OraclePublisher(makeHub());
        let broadcastStub = sinon.stub().resolves({ txid: 'x' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);
        await pub._processQueue();
        expect(broadcastStub.calledOnce).to.be.true;   // only round 1 sent
        // round 2 stays on the durable queue for the next window
        let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
        expect(rewritten).to.include('"round":2');
        expect(rewritten).to.not.include('"round":1');
    });

});


// ── item 2675: ambiguous send is never blind-retried ───────────────────────
oraclePublisherTests('ambiguous send handling (item 2675)', function () {
    it('dead-letters an ambiguous send instead of re-queuing it for re-broadcast', async function () {
        let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let timeout = new Error('socket hang up'); timeout.code = 'ETIMEDOUT';
        let broadcastStub = sinon.stub().rejects(timeout);
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);
        let dead = sinon.stub(pub, 'deadLetter');
        await pub._processQueue();
        expect(broadcastStub.calledOnce).to.be.true;
        expect(dead.calledOnce, 'ambiguous send must be dead-lettered').to.be.true;
        // the round must NOT remain on the live queue (no auto re-broadcast)
        let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
        expect(rewritten).to.not.include('"round":9');
    });

    it('still retries a definitive (never-sent) error normally', async function () {
        let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let refused = new Error('connect ECONNREFUSED'); refused.code = 'ECONNREFUSED';
        pub.broadcastFn  = sinon.stub().rejects(refused);
        pub.getBalanceFn = sinon.stub().resolves(50);
        let dead = sinon.stub(pub, 'deadLetter');
        await pub._processQueue();
        expect(dead.called, 'definitive error must not dead-letter').to.be.false;
        // round retained with attempts incremented
        let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
        expect(rewritten).to.include('"round":9');
    });

});

oraclePublisherTests('ambiguous send handling (item 2675)', function () {

    // A two-phase HUB_SIGNER_MODULE broadcasts its funding tx and can then be
    // rejected DEFINITIVELY on the reveal. Requeuing re-enters the hook, which runs
    // createTx over fresh UTXOs and funds the SAME payload a second time. The pair
    // below is the whole contract: identical error, and only the signer's
    // fundsCommitted tag separates a dead letter from a re-fund.
    it('dead-letters a DEFINITIVE rejection the signer tagged as post-funding', async function () {
        let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let rejected = new Error('Encoder RPC error: bad-txns-inputs-missingorspent');
        rejected.fundsCommitted = true;
        rejected.phase1Txid     = 'f'.repeat(64);
        pub.broadcastFn  = sinon.stub().rejects(rejected);
        pub.getBalanceFn = sinon.stub().resolves(50);
        let dead = sinon.stub(pub, 'deadLetter');
        await pub._processQueue();
        expect(dead.calledOnce, 'a funded payload must never be rebuilt').to.be.true;
        let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
        expect(rewritten).to.not.include('"round":9');
    });

    it('still requeues the SAME rejection when no funding was committed', async function () {
        let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        pub.broadcastFn  = sinon.stub().rejects(
            new Error('Encoder RPC error: bad-txns-inputs-missingorspent'));
        pub.getBalanceFn = sinon.stub().resolves(50);
        let dead = sinon.stub(pub, 'deadLetter');
        await pub._processQueue();
        expect(dead.called, 'an untagged pre-send rejection keeps its retry').to.be.false;
        let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
        expect(rewritten).to.include('"round":9');
    });

    it('requeues a get_utxos timeout instead of dead-lettering it', async function () {
        let pub = defaultPipelinePub();
        let aborted = new Error('timeout of 10000ms exceeded'); aborted.code = 'ECONNABORTED';
        pub.encoder.getUtxos = sinon.stub().rejects(aborted);
        let { dead, rewritten } = await runQueueWith(pub);
        expect(pub.encoder.broadcastTx.called, 'nothing was broadcast').to.be.false;
        expect(dead.called, 'a pre-send timeout must not dead-letter').to.be.false;
        expect(rewritten).to.include('"round":9');
    });

});

oraclePublisherTests('ambiguous send handling (item 2675)', function () {

    it('requeues an empty UTXO set instead of dead-lettering it', async function () {
        let pub = defaultPipelinePub();
        pub.encoder.getUtxos = sinon.stub().resolves([]);
        let { dead, rewritten } = await runQueueWith(pub);
        expect(dead.called, 'an empty UTXO read must not dead-letter').to.be.false;
        expect(rewritten).to.include('"round":9');
    });

    it('requeues a wallet sign-hook failure instead of dead-lettering it', async function () {
        let pub = defaultPipelinePub();
        pub.walletSignFn = sinon.stub().rejects(new Error('signer unavailable'));
        let { dead, rewritten } = await runQueueWith(pub);
        expect(pub.encoder.broadcastTx.called, 'nothing was broadcast').to.be.false;
        expect(dead.called, 'a sign-hook failure must not dead-letter').to.be.false;
        expect(rewritten).to.include('"round":9');
    });

    it('still dead-letters a timeout raised by broadcast_tx itself', async function () {
        let pub = defaultPipelinePub();
        let aborted = new Error('timeout of 10000ms exceeded'); aborted.code = 'ECONNABORTED';
        pub.encoder.broadcastTx = sinon.stub().rejects(aborted);
        let { dead, rewritten } = await runQueueWith(pub);
        expect(dead.calledOnce, 'a send that may have landed must dead-letter').to.be.true;
        expect(rewritten).to.not.include('"round":9');
    });

});

