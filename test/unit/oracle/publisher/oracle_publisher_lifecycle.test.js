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
const { DB_METHODS } = require('../../../helpers/mockHub');


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
    OraclePublisher = proxyquire('../../../../src/oracle/publisher', {
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

// Build a publisher with a fully-wired encoder + hooks, then let each test
// knock out one prerequisite to exercise the corresponding guard.
function wiredPub() {
    let pub = new OraclePublisher(makeHub());
    pub.encoder = {
        getUtxos:    sinon.stub().resolves([{ txid: 'a', vout: 0, value: 100000 }]),
        createTx:    sinon.stub().resolves({ psbt: 'psbthex' }),
        broadcastTx: sinon.stub().resolves({ txid: 'TXID' })
    };
    pub.walletSignFn  = sinon.stub().resolves('signedtxhex');
    pub.dogeAddress   = 'DwhateverAddress';
    pub.dogePubkeyHex = '02' + 'a'.repeat(64);
    return pub;
}
async function expectThrow(pub, frag) {
    try { await pub.defaultBroadcast('payload'); expect.fail('should throw'); }
    catch (e) { expect(e.message).to.include(frag); }
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


// ── start ────────────────────────────────────────────────────────────────

oraclePublisherTests('start()', function () {
    it('creates queue directory and subscribes to oracle finalization', async function () {
        let EventEmitter = require('events');
        let fakeConsensus = new EventEmitter();
        let hub = makeHub({ oracleConsensus: fakeConsensus });
        let pub = new OraclePublisher(hub);
        fsMock.existsSync.returns(false);
        await pub.start();
        // The oracle consensus event handler should be registered
        expect(fakeConsensus.listenerCount('round:finalized')).to.equal(1);
    });

    it('does not throw when queue file creation fails', async function () {
        fsMock.existsSync.returns(false);
        fsMock.writeFileSync.throws(new Error('read-only fs'));
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        await pub.start();  // must not throw
    });

});


// ── onRoundFinalized ──────────────────────────────────────────────────────

oraclePublisherTests('onRoundFinalized()', function () {
    it('returns early when getMyRank returns null (not a publisher)', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        sinon.stub(pub, 'getMyRank').resolves(null);
        let enqueueSpy = sinon.spy(pub, '_enqueue');
        await pub.onRoundFinalized({ round: 1, btcBlockHeight: 100, prices: [], signatures: [] });
        expect(enqueueSpy.called).to.be.false;
    });

    it('returns early when publisherCount is 0', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        sinon.stub(pub, 'getMyRank').resolves(0);
        sinon.stub(pub, 'getActiveOraclePublishCount').resolves(0);
        let enqueueSpy = sinon.spy(pub, '_enqueue');
        await pub.onRoundFinalized({ round: 1, btcBlockHeight: 100, prices: [] });
        expect(enqueueSpy.called).to.be.false;
    });

    it('returns early when not the designated leader', async function () {
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        // rank=1, count=3, round=0: leaderRank=0%3=0 ≠ rank=1
        sinon.stub(pub, 'getMyRank').resolves(1);
        sinon.stub(pub, 'getActiveOraclePublishCount').resolves(3);
        let enqueueSpy = sinon.spy(pub, '_enqueue');
        await pub.onRoundFinalized({ round: 0, btcBlockHeight: 100, prices: [] });
        expect(enqueueSpy.called).to.be.false;
    });

    it('BUFFERS rather than enqueuing, even as the leader: the per-round v0 rail is retired', async function () {
        // A finalized round does not ride its own transaction. It buffers, and it
        // leaves as part of a signed batch, on every hub and every network. The
        // leader check belongs at window close, because window leadership is decided
        // at the window's anchor and that anchor is not known when the window's
        // first round finalizes.
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        sinon.stub(pub, 'getMyRank').resolves(0);
        sinon.stub(pub, 'getActiveOraclePublishCount').resolves(3);
        let enqueueStub  = sinon.stub(pub, '_enqueue').resolves();
        let processStub  = sinon.stub(pub, 'processQueue').resolves();
        let bufferStub   = sinon.stub(pub, 'bufferFinalizedRound').resolves();
        await pub.onRoundFinalized({ round: 3, btcBlockHeight: 100, btcBlockTime: 0, prices: [], signatures: [{ pubkey: 'pk', sig: 'sig' }] });
        expect(bufferStub.calledOnce).to.be.true;
        expect(enqueueStub.called).to.be.false;
        expect(processStub.called).to.be.false;
    });

});


// ── defaultBroadcast() pipeline ────────────────────────────────────────
oraclePublisherTests('defaultBroadcast()', function () {

    it('throws when the encoder is not configured', async function () {
        let pub = wiredPub(); pub.encoder = null;
        await expectThrow(pub, 'no encoder configured');
    });
    it('throws when no wallet sign hook is configured', async function () {
        let pub = wiredPub(); pub.walletSignFn = null;
        await expectThrow(pub, 'no wallet sign hook');
    });
    it('throws when DOGE_ADDRESS is unset', async function () {
        let pub = wiredPub(); pub.dogeAddress = null;
        await expectThrow(pub, 'no DOGE_ADDRESS');
    });
    it('throws when DOGE_PUBKEY_HEX is unset', async function () {
        let pub = wiredPub(); pub.dogePubkeyHex = null;
        await expectThrow(pub, 'no DOGE_PUBKEY_HEX');
    });
    it('throws when no UTXOs are available', async function () {
        let pub = wiredPub(); pub.encoder.getUtxos = sinon.stub().resolves([]);
        await expectThrow(pub, 'no UTXOs available');
    });
    it('throws when the encoder returns no PSBT', async function () {
        let pub = wiredPub(); pub.encoder.createTx = sinon.stub().resolves({});
        await expectThrow(pub, 'no PSBT');
    });
    it('throws when the wallet hook returns invalid tx hex', async function () {
        let pub = wiredPub(); pub.walletSignFn = sinon.stub().resolves(null);
        await expectThrow(pub, 'invalid tx hex');
    });
    it('signs, broadcasts, and returns the txid on success', async function () {
        let pub = wiredPub();
        let result = await pub.defaultBroadcast('the-payload');
        expect(result).to.deep.equal({ txid: 'TXID' });
        expect(pub.encoder.createTx.getCall(0).args[0].data).to.equal('the-payload');
        expect(pub.walletSignFn.calledWith('psbthex')).to.be.true;
        expect(pub.encoder.broadcastTx.calledWith('signedtxhex')).to.be.true;
    });
    it('falls back to { txid: null } when broadcast returns nothing', async function () {
        let pub = wiredPub(); pub.encoder.broadcastTx = sinon.stub().resolves(null);
        let result = await pub.defaultBroadcast('p');
        expect(result).to.deep.equal({ txid: null });
    });

});


// ── start() ─────────────────────────────────────────────────────────────
oraclePublisherTests('start()', function () {
    it('creates the queue dir, touches the file, and subscribes to round:finalized', async function () {
        let oc = { on: sinon.stub() };
        let pub = new OraclePublisher(makeHub({ oracleConsensus: oc }));
        fsMock.existsSync.returns(false); // force the writeFileSync touch
        await pub.start();
        expect(fsMock.mkdirSync.called).to.be.true;
        expect(fsMock.writeFileSync.called).to.be.true;
        expect(oc.on.calledWith('round:finalized')).to.be.true;
    });

    it('tolerates mkdir/touch failures without throwing', async function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.mkdirSync = sinon.stub().throws(new Error('eperm'));
        fsMock.existsSync.returns(false);
        fsMock.writeFileSync = sinon.stub().throws(new Error('eacces'));
        await pub.start(); // best-effort, must not throw
    });

});


// ── _enqueue() ──────────────────────────────────────────────────────────
oraclePublisherTests('_enqueue()', function () {
    it('appends an fsync-durable JSON line with attempt metadata', async function () {
        let pub = new OraclePublisher(makeHub());
        await pub._enqueue({ round: 5, prices: [], sigs: [] });
        expect(fsMock.openSync.called).to.be.true;
        expect(fsMock.writeSync.called).to.be.true;
        expect(fsMock.fsyncSync.called).to.be.true;
        expect(fsMock.closeSync.called).to.be.true;
        let entry = JSON.parse(fsMock.writeSync.getCall(0).args[1].trim());
        expect(entry.round).to.equal(5);
        expect(entry.attempts).to.equal(0);
        expect(entry).to.have.property('enqueuedAt');
    });

    it('fails loud when the queue write throws', async function () {
        let pub = new OraclePublisher(makeHub());
        fsMock.openSync = sinon.stub().throws(new Error('disk full'));
        try { await pub._enqueue({ round: 5 }); expect.fail('should throw'); }
        catch (e) { expect(e.message).to.include('disk full'); }
    });

});


// ── item 2677: operator kill switch ────────────────────────────────────────
oraclePublisherTests('ORACLE_PUBLISH_ENABLED kill switch (item 2677)', function () {
    afterEach(function () { delete process.env.ORACLE_PUBLISH_ENABLED; });

    it('defaults to enabled', function () {
        expect(new OraclePublisher(makeHub()).enabled).to.be.true;
    });

    it('onRoundFinalized enqueues nothing when disabled', async function () {
        process.env.ORACLE_PUBLISH_ENABLED = 'false';
        let pub = new OraclePublisher(makeHub());
        let enqueue = sinon.stub(pub, '_enqueue');
        let proc    = sinon.stub(pub, 'processQueue');
        await pub.onRoundFinalized({ round: 1, btcBlockHeight: 100, btcBlockTime: 0, prices: [] });
        expect(enqueue.called).to.be.false;
        expect(proc.called).to.be.false;
    });

    it('processQueue broadcasts nothing when disabled', async function () {
        process.env.ORACLE_PUBLISH_ENABLED = 'false';
        let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let pub = new OraclePublisher(makeHub());
        let broadcastStub = sinon.stub().resolves({ txid: 'x' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);
        await pub.processQueue();
        expect(broadcastStub.called).to.be.false;
    });

});

