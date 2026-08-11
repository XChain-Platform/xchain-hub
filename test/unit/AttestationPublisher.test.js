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
 * XChain Hub - AttestationPublisher unit tests
 *
 * Covers: constructor defaults, start/stop lifecycle, buildAttestationResponseWire,
 * _enqueue/_readQueue/_rewriteQueue/_removeFromQueue, _getBroadcaster, _myRank,
 * _computeResponsible, _fetchPendingRequestIds, _resolveBtcIndexerUrl,
 * _defaultBroadcast, onRequestFinalized edge cases (no-sigs, oversized payload).
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const sinon = require('sinon');
const nock  = require('nock');
const { expect } = require('chai');
const AttestationPublisher = require('../../src/AttestationPublisher');

const MY_PUB     = 'aa'.repeat(32);
const LEADER_PUB = 'bb'.repeat(32);
const OTHER_PUB  = 'cc'.repeat(32);

// ---------- hub factory (mirrors AttestationPublisherReplay pattern) --------

function makeHub(myPub, overrides) {
    overrides = overrides || {};
    return Object.assign({
        getIdentity: () => ({ getPubkeyHex: () => myPub }),
        p2pConfig: {},
        attestationConsensus: null,
        capabilitySnapshot: {
            getSnapshot: async () => ({ validators: [{ pubkey: myPub }, { pubkey: LEADER_PUB }] })
        },
        _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
        _btcIndexerHeaders: () => ({})
    }, overrides);
}

// Create a publisher with a unique tmpdir queue path per test.
function makePublisher(myPub, hubOverrides) {
    const pub = new AttestationPublisher(makeHub(myPub || MY_PUB, hubOverrides));
    pub.queuePath = path.join(os.tmpdir(), 'attest-pub-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    return pub;
}

function writeQueue(file, entries) {
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function readQueue(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ---------- constructor --------------------------------------------------

describe('AttestationPublisher: constructor', function () {

    afterEach(function () { sinon.restore(); });

    it('reads failover tuning from p2pConfig', function () {
        const hub = makeHub(MY_PUB, {
            p2pConfig: {
                ATTESTATION_FAILOVER_WINDOW_BLOCKS: '5',
                ATTESTATION_FAILOVER_POLL_MS:       '15000',
                ATTESTATION_LEADER_RETRY_MS:        '45000',
                ATTESTATION_BLOCK_MS:               '120000',
                ATTESTATION_QUEUE_PATH:             '/tmp/test-queue.jsonl'
            }
        });
        const pub = new AttestationPublisher(hub);
        expect(pub.failoverWindowBlocks).to.equal(5);
        expect(pub.failoverPollMs).to.equal(15000);
        expect(pub.leaderRetryMs).to.equal(45000);
        expect(pub.approxBlockMs).to.equal(120000);
        expect(pub.queuePath).to.equal('/tmp/test-queue.jsonl');
    });

    it('falls back to env vars for tuning', function () {
        process.env.ATTESTATION_FAILOVER_WINDOW_BLOCKS = '7';
        process.env.ATTESTATION_FAILOVER_POLL_MS       = '20000';
        process.env.ATTESTATION_LEADER_RETRY_MS        = '90000';
        process.env.ATTESTATION_BLOCK_MS               = '300000';
        process.env.ATTESTATION_QUEUE_PATH             = '/tmp/env-queue.jsonl';
        try {
            const pub = new AttestationPublisher(makeHub(MY_PUB));
            expect(pub.failoverWindowBlocks).to.equal(7);
            expect(pub.failoverPollMs).to.equal(20000);
            expect(pub.leaderRetryMs).to.equal(90000);
            expect(pub.approxBlockMs).to.equal(300000);
            expect(pub.queuePath).to.equal('/tmp/env-queue.jsonl');
        } finally {
            delete process.env.ATTESTATION_FAILOVER_WINDOW_BLOCKS;
            delete process.env.ATTESTATION_FAILOVER_POLL_MS;
            delete process.env.ATTESTATION_LEADER_RETRY_MS;
            delete process.env.ATTESTATION_BLOCK_MS;
            delete process.env.ATTESTATION_QUEUE_PATH;
        }
    });

    it('wires up encoder from env vars when BTC_ENCODER_URL is set', function () {
        process.env.BTC_ENCODER_URL     = 'http://encoder.local:3000';
        process.env.BTC_ENCODER_API_KEY = 'key123';
        process.env.BTC_ADDRESS         = '1ABCaddress';
        process.env.BTC_PUBKEY_HEX      = 'ab'.repeat(33);
        try {
            const pub = new AttestationPublisher(makeHub(MY_PUB));
            expect(pub.encoder).to.not.be.null;
            expect(pub.btcAddress).to.equal('1ABCaddress');
            expect(pub.btcPubkeyHex).to.equal('ab'.repeat(33));
        } finally {
            delete process.env.BTC_ENCODER_URL;
            delete process.env.BTC_ENCODER_API_KEY;
            delete process.env.BTC_ADDRESS;
            delete process.env.BTC_PUBKEY_HEX;
        }
    });

    it('leaves encoder null when no BTC_ENCODER_URL is configured', function () {
        const pub = makePublisher();
        expect(pub.encoder).to.be.null;
    });

    it('assigns identity from hub.getIdentity()', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.identity).to.exist;
        expect(pub.identity.getPubkeyHex()).to.equal(MY_PUB);
    });

    it('sets identity to null when hub has no getIdentity method', function () {
        const hub = { p2pConfig: {}, attestationConsensus: null };
        const pub = new AttestationPublisher(hub);
        expect(pub.identity).to.be.null;
    });

    it('uses empty p2pConfig when hub.p2pConfig is undefined (hub.p2pConfig || {} branch)', function () {
        // This exercises the `hub.p2pConfig || {}` fallback on line 75.
        const hub = { getIdentity: () => null, attestationConsensus: null };
        // p2pConfig deliberately omitted
        const pub = new AttestationPublisher(hub);
        expect(pub.queuePath).to.be.a('string');
    });
});

// ---------- setBroadcastHook / setWalletSignHook / setEncoder ---------------

describe('AttestationPublisher: hook setters', function () {

    it('setBroadcastHook stores the function', function () {
        const pub = makePublisher();
        const fn = () => {};
        pub.setBroadcastHook(fn);
        expect(pub.broadcastFn).to.equal(fn);
    });

    it('setWalletSignHook stores the function', function () {
        const pub = makePublisher();
        const fn = () => {};
        pub.setWalletSignHook(fn);
        expect(pub.walletSignFn).to.equal(fn);
    });

    it('setEncoder stores the encoder', function () {
        const pub = makePublisher();
        const enc = { getUtxos: sinon.stub() };
        pub.setEncoder(enc);
        expect(pub.encoder).to.equal(enc);
    });
});

// ---------- start / stop ----------------------------------------------------

describe('AttestationPublisher: start / stop', function () {

    afterEach(function () { sinon.restore(); });

    it('start() creates the queue file when it does not exist', async function () {
        const pub = makePublisher();
        // Stub _processQueue to avoid network calls
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        try {
            expect(fs.existsSync(pub.queuePath)).to.equal(true);
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });

    it('start() does not error if queue file already exists', async function () {
        const pub = makePublisher();
        fs.mkdirSync(path.dirname(pub.queuePath), { recursive: true });
        fs.writeFileSync(pub.queuePath, 'existing content\n');
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        try {
            expect(fs.existsSync(pub.queuePath)).to.equal(true);
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });

    it('start() subscribes to attestationConsensus when present', async function () {
        const EventEmitter = require('events');
        const emitter = new EventEmitter();
        const hub = makeHub(MY_PUB, { attestationConsensus: emitter });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-start-' + process.pid + '.jsonl');
        sinon.stub(pub, '_processQueue').resolves();

        await pub.start();
        try {
            // Emit a finalized event and verify onRequestFinalized is called
            const onStub = sinon.stub(pub, 'onRequestFinalized').resolves();
            emitter.emit('request:finalized', { requestId: 'test' });
            // Flush microtasks
            await new Promise(r => setImmediate(r));
            expect(onStub.calledOnce).to.equal(true);
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });

    it('start() sets up the sweep interval', async function () {
        const pub = makePublisher();
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        try {
            expect(pub._sweepTimer).to.not.be.null;
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });

    it('stop() clears the sweep timer', async function () {
        const pub = makePublisher();
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        expect(pub._sweepTimer).to.not.be.null;
        await pub.stop();
        expect(pub._sweepTimer).to.be.null;
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('stop() is safe to call when no timer is set', async function () {
        const pub = makePublisher();
        pub._sweepTimer = null;
        await pub.stop();  // should not throw
    });

    it('start() logs a warning when the queue path is unwritable', async function () {
        const pub = makePublisher();
        // Point to an impossible path to trigger the catch branch
        pub.queuePath = '/nonexistent-root/deep/path/queue.jsonl';
        sinon.stub(pub, '_processQueue').resolves();
        const warnStub = sinon.stub(console, 'warn');
        await pub.start();
        try {
            expect(warnStub.called).to.equal(true);
        } finally {
            await pub.stop();
            warnStub.restore();
        }
    });

    it('start() catches and logs errors from onRequestFinalized when the event handler throws', async function () {
        const EventEmitter = require('events');
        const emitter = new EventEmitter();
        const hub = makeHub(MY_PUB, { attestationConsensus: emitter });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-catch-' + process.pid + '.jsonl');
        sinon.stub(pub, '_processQueue').resolves();

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            // Make onRequestFinalized reject with a real Error (tests the err.message branch)
            sinon.stub(pub, 'onRequestFinalized').rejects(new Error('handler exploded'));
            emitter.emit('request:finalized', { requestId: 'test' });
            await new Promise(r => setTimeout(r, 20));
            expect(errStub.called).to.equal(true);
            const loggedMsg = errStub.args.find(a => String(a[0]).match(/onRequestFinalized error/));
            expect(loggedMsg).to.exist;
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });

    it('start() catches and logs non-Error from onRequestFinalized (err.message falsy → err branch)', async function () {
        // Line 117: `err && err.message ? err.message : err` (the `: err` path)
        const EventEmitter = require('events');
        const emitter = new EventEmitter();
        const hub = makeHub(MY_PUB, { attestationConsensus: emitter });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-nonerrorcatch-' + process.pid + '.jsonl');
        sinon.stub(pub, '_processQueue').resolves();

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            // Reject with a plain string (no .message property) to exercise the `: err` branch
            sinon.stub(pub, 'onRequestFinalized').rejects('plain string error');
            emitter.emit('request:finalized', { requestId: 'test' });
            await new Promise(r => setTimeout(r, 20));
            expect(errStub.called).to.equal(true);
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });

    it('start() catches and logs errors when the sweep interval _processQueue rejects', async function () {
        const pub = makePublisher();
        pub.failoverPollMs = 20;  // fire quickly for testing
        let firstCall = true;
        sinon.stub(pub, '_processQueue').callsFake(async () => {
            if (firstCall) { firstCall = false; return; }  // startup call succeeds
            throw new Error('sweep exploded');
        });

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            // Wait for the interval to fire
            await new Promise(r => setTimeout(r, 60));
            expect(errStub.called).to.equal(true);
            const loggedMsg = errStub.args.find(a => String(a[0]).match(/sweep error/));
            expect(loggedMsg).to.exist;
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });

    it('start() sweep logs non-Error (err.message falsy → err branch) when _processQueue rejects with non-Error', async function () {
        // Line 131: `err && err.message ? err.message : err` (the `: err` path)
        const pub = makePublisher();
        pub.failoverPollMs = 20;
        let firstCall = true;
        sinon.stub(pub, '_processQueue').callsFake(async () => {
            if (firstCall) { firstCall = false; return; }
            // Throw a non-Error value (plain object without .message)
            throw { code: 'UNKNOWN_ERR' };
        });

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            await new Promise(r => setTimeout(r, 60));
            expect(errStub.called).to.equal(true);
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    });
});

// ---------- buildAttestationResponseWire ------------------------------------

describe('AttestationPublisher: buildAttestationResponseWire', function () {

    let pub;
    before(function () { pub = makePublisher(); });

    it('builds a pipe-delimited ATTEST v1 wire with Buffer body', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    'req' + '11'.repeat(30),
            providerId:   'http_get',
            responseBody: Buffer.from('hello', 'utf8'),
            status:       'ok',
            meta:         '200',
            signatures:   [
                { pubkey: MY_PUB,     sig: 'ee'.repeat(64) },
                { pubkey: LEADER_PUB, sig: 'ff'.repeat(64) }
            ]
        });
        const parts = wire.split('|');
        expect(parts[0]).to.equal('ATTEST');
        expect(parts[1]).to.equal('1');
        expect(parts[2]).to.equal(('req' + '11'.repeat(30)).toLowerCase());
        expect(parts[3]).to.equal('http_get');
        // parts[4] is base64 of "hello"
        expect(Buffer.from(parts[4], 'base64').toString()).to.equal('hello');
        expect(parts[5]).to.equal('ok');
        expect(parts[6]).to.equal('200');
        expect(parts[7]).to.equal('2');  // 2 signatures
        expect(parts[8]).to.equal(MY_PUB.toLowerCase());
        expect(parts[9]).to.equal('ee'.repeat(64));
        expect(parts[10]).to.equal(LEADER_PUB.toLowerCase());
        expect(parts[11]).to.equal('ff'.repeat(64));
    });

    it('handles null responseBody (uses empty Buffer)', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    '00'.repeat(32),
            providerId:   'llm',
            responseBody: null,
            status:       'error',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        const parts = wire.split('|');
        // base64 of empty buffer is empty string
        expect(parts[4]).to.equal('');
        expect(parts[5]).to.equal('error');
    });

    it('handles string responseBody (converts to UTF-8 Buffer)', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    '11'.repeat(32),
            providerId:   'http_get',
            responseBody: 'string content',
            status:       'ok',
            meta:         '200',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        const parts = wire.split('|');
        expect(Buffer.from(parts[4], 'base64').toString()).to.equal('string content');
    });

    it('lowercases requestId in the wire', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    'AAAA' + '00'.repeat(30),
            providerId:   'http_get',
            responseBody: null,
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        expect(wire.split('|')[2]).to.equal(('AAAA' + '00'.repeat(30)).toLowerCase());
    });

    it('handles missing meta (uses empty string)', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    '22'.repeat(32),
            providerId:   'llm',
            responseBody: null,
            status:       'ok',
            meta:         undefined,
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        expect(wire.split('|')[6]).to.equal('');
    });
});

// ---------- _enqueue / _readQueue / _rewriteQueue / _removeFromQueue --------

describe('AttestationPublisher: queue I/O', function () {

    let pub;

    beforeEach(function () {
        pub = makePublisher();
        // Ensure the queue file exists (start() would do this normally)
        fs.mkdirSync(path.dirname(pub.queuePath), { recursive: true });
        fs.writeFileSync(pub.queuePath, '');
    });

    afterEach(function () {
        sinon.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('_enqueue appends a JSON line and _readQueue parses it back', function () {
        const entry = { ts: 12345, requestId: '11'.repeat(32), wire: 'ATTEST|1|...' };
        pub._enqueue(entry);
        const entries = pub._readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('11'.repeat(32));
        expect(entries[0].wire).to.equal('ATTEST|1|...');
    });

    it('_enqueue appends multiple entries correctly', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._enqueue({ ts: 2, requestId: 'bb'.repeat(32), wire: 'W2' });
        const entries = pub._readQueue();
        expect(entries).to.have.length(2);
        expect(entries[0].requestId).to.equal('aa'.repeat(32));
        expect(entries[1].requestId).to.equal('bb'.repeat(32));
    });

    it('_readQueue returns [] when the file does not exist', function () {
        fs.unlinkSync(pub.queuePath);
        expect(pub._readQueue()).to.deep.equal([]);
    });

    it('_readQueue skips malformed JSON lines', function () {
        fs.writeFileSync(pub.queuePath, 'not json\n{"requestId":"aa".repeat(32),"wire":"W"}\n');
        // The second line is also not valid JSON as written; let's write proper content
        fs.writeFileSync(pub.queuePath,
            'not json\n' +
            JSON.stringify({ requestId: 'aa'.repeat(32), wire: 'W' }) + '\n'
        );
        const entries = pub._readQueue();
        // malformed line is skipped; valid line is parsed
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('aa'.repeat(32));
    });

    it('_readQueue filters entries without requestId or wire', function () {
        fs.writeFileSync(pub.queuePath,
            JSON.stringify({ requestId: 'aa'.repeat(32) }) + '\n' +  // missing wire
            JSON.stringify({ wire: 'W' }) + '\n' +                     // missing requestId
            JSON.stringify({ requestId: 'bb'.repeat(32), wire: 'W2' }) + '\n'
        );
        const entries = pub._readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('bb'.repeat(32));
    });

    it('_rewriteQueue replaces file contents with the given entries', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._enqueue({ ts: 2, requestId: 'bb'.repeat(32), wire: 'W2' });
        pub._rewriteQueue([{ ts: 3, requestId: 'cc'.repeat(32), wire: 'W3' }]);
        const entries = pub._readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('cc'.repeat(32));
    });

    it('_rewriteQueue with empty array clears the file', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._rewriteQueue([]);
        const entries = pub._readQueue();
        expect(entries).to.have.length(0);
    });

    it('_removeFromQueue removes matching IDs and keeps others', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._enqueue({ ts: 2, requestId: 'BB'.repeat(32), wire: 'W2' });  // uppercase, tests lowercasing
        pub._enqueue({ ts: 3, requestId: 'cc'.repeat(32), wire: 'W3' });
        pub._removeFromQueue(new Set(['aa'.repeat(32), 'bb'.repeat(32)]));  // lowercase drop set
        const entries = pub._readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('cc'.repeat(32));
    });

    it('_removeFromQueue is a no-op for empty drop set', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._removeFromQueue(new Set());
        expect(pub._readQueue()).to.have.length(1);
    });

    it('_removeFromQueue is a no-op for null drop set', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._removeFromQueue(null);
        expect(pub._readQueue()).to.have.length(1);
    });

    it('_enqueue logs critical + returns false (does not throw) when queue path is unwritable (item 2681)', function () {
        const errStub = sinon.stub(console, 'error');
        pub.queuePath = '/nonexistent-root/cannot-write.jsonl';
        let ok = pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        expect(ok).to.equal(false);
        expect(errStub.called).to.equal(true);
        expect(pub._enqueueFailures).to.equal(1);
        errStub.restore();
    });

    it('_enqueue returns true on a durable write (item 2681)', function () {
        expect(pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' })).to.equal(true);
    });

    it('_rewriteQueue logs error (does not throw) on unwritable path', function () {
        const errStub = sinon.stub(console, 'error');
        pub.queuePath = '/nonexistent-root/cannot-write.jsonl';
        pub._rewriteQueue([]);
        expect(errStub.called).to.equal(true);
        errStub.restore();
    });
});

// ---------- _getBroadcaster -------------------------------------------------

describe('AttestationPublisher: _getBroadcaster', function () {

    it('returns a function wrapping broadcastFn when set', function () {
        const pub = makePublisher();
        const fn = sinon.stub().resolves({ txid: 'abc' });
        pub.setBroadcastHook(fn);
        const broadcaster = pub._getBroadcaster();
        expect(typeof broadcaster).to.equal('function');
    });

    it('returns null when no hooks and no encoder are configured', function () {
        const pub = makePublisher();
        expect(pub._getBroadcaster()).to.be.null;
    });

    it('returns the _defaultBroadcast pipeline when encoder + walletSignFn + address + pubkey are all set', function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub(), createTx: sinon.stub(), broadcastTx: sinon.stub() });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress    = '1TestAddress';
        pub.btcPubkeyHex  = 'ab'.repeat(33);
        const broadcaster = pub._getBroadcaster();
        expect(typeof broadcaster).to.equal('function');
    });

    it('returns null when encoder is set but walletSignFn or address is missing', function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        // No walletSignFn, no address
        expect(pub._getBroadcaster()).to.be.null;
    });

    it('broadcastFn path: broadcaster calls broadcastFn with payload and event', async function () {
        const pub = makePublisher();
        const fn = sinon.stub().resolves({ txid: 'xyz' });
        pub.setBroadcastHook(fn);
        const broadcaster = pub._getBroadcaster();
        const result = await broadcaster('wire-payload', { requestId: 'test' });
        expect(fn.calledWith('wire-payload', { requestId: 'test' })).to.equal(true);
        expect(result.txid).to.equal('xyz');
    });
});

// ---------- _myRank ---------------------------------------------------------

describe('AttestationPublisher: _myRank', function () {

    it('returns null when identity is not set', function () {
        const hub = makeHub(MY_PUB, { p2pConfig: {} });
        hub.getIdentity = () => null;
        const pub = new AttestationPublisher(hub);
        pub.queuePath = '/tmp/test.jsonl';
        expect(pub._myRank({ responsible: [MY_PUB] })).to.be.null;
    });

    it('returns 0 when this node is the leader in the responsible set', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub._myRank({ responsible: [MY_PUB, LEADER_PUB] })).to.equal(0);
    });

    it('returns 1 when this node is rank-1 follower in the responsible set', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub._myRank({ responsible: [LEADER_PUB, MY_PUB] })).to.equal(1);
    });

    it('returns null when this node is not in the responsible set', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub._myRank({ responsible: [LEADER_PUB, OTHER_PUB] })).to.be.null;
    });

    it('uses leaderPubkey fallback when responsible array is empty/absent (we are leader)', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub._myRank({ leaderPubkey: MY_PUB })).to.equal(0);
    });

    it('uses leaderPubkey fallback when responsible array is empty/absent (we are follower)', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub._myRank({ leaderPubkey: LEADER_PUB })).to.equal(1);
    });

    it('returns 0 when neither responsible nor leaderPubkey is present', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub._myRank({})).to.equal(0);
    });

    it('is case-insensitive for pubkey comparison', function () {
        const pub = makePublisher(MY_PUB);
        // MY_PUB already lowercase, but verify the uppercase variant is matched
        expect(pub._myRank({ responsible: [MY_PUB.toUpperCase(), LEADER_PUB] })).to.equal(0);
    });
});

// ---------- _computeResponsible ---------------------------------------------

describe('AttestationPublisher: _computeResponsible', function () {

    afterEach(function () { sinon.restore(); });

    it('returns null when capabilitySnapshot is not available', async function () {
        const pub = makePublisher(MY_PUB, { capabilitySnapshot: null });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    });

    it('returns null when snapshot returns no validators', async function () {
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators: [] }) }
        });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    });

    it('returns null when snapshot returns null', async function () {
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => null }
        });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    });

    it('returns a sorted slice of pubkeys based on SHA256(rid || pubkey)', async function () {
        const validators = [MY_PUB, LEADER_PUB, OTHER_PUB].map(pk => ({ pubkey: pk }));
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators }) }
        });
        const rid = '11'.repeat(32);
        const result = await pub._computeResponsible(rid, 100, 2);
        expect(Array.isArray(result)).to.equal(true);
        expect(result.length).to.equal(2);
        // All results should be known pubkeys
        for (const pk of result) {
            expect([MY_PUB, LEADER_PUB, OTHER_PUB]).to.include(pk);
        }
    });

    it('is deterministic (same inputs → same ordering)', async function () {
        const validators = [MY_PUB, LEADER_PUB, OTHER_PUB].map(pk => ({ pubkey: pk }));
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators }) }
        });
        const rid = 'deadbeef'.repeat(8);
        const r1 = await pub._computeResponsible(rid, 100, 3);
        const r2 = await pub._computeResponsible(rid, 100, 3);
        expect(r1).to.deep.equal(r2);
    });

    it('returns null when getSnapshot throws', async function () {
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => { throw new Error('DB down'); } }
        });
        const result = await pub._computeResponsible('req' + '00'.repeat(30), 100, 2);
        expect(result).to.be.null;
    });

    it('limits result to redundancy (max 1 when redundancy=1)', async function () {
        const validators = [MY_PUB, LEADER_PUB, OTHER_PUB].map(pk => ({ pubkey: pk }));
        const pub = makePublisher(MY_PUB, {
            capabilitySnapshot: { getSnapshot: async () => ({ validators }) }
        });
        const result = await pub._computeResponsible('11'.repeat(32), 100, 1);
        expect(result.length).to.equal(1);
    });
});

// ---------- _resolveBtcIndexerUrl -------------------------------------------

describe('AttestationPublisher: _resolveBtcIndexerUrl', function () {

    it('delegates to hub._resolveBtcIndexerUrl when present', async function () {
        const pub = makePublisher(MY_PUB);
        const url = await pub._resolveBtcIndexerUrl();
        expect(url).to.equal('http://indexer.local/rpc');
    });

    it('returns null when hub has no _resolveBtcIndexerUrl method', async function () {
        const hub = makeHub(MY_PUB);
        delete hub._resolveBtcIndexerUrl;
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'test-' + process.pid + '.jsonl');
        const url = await pub._resolveBtcIndexerUrl();
        expect(url).to.be.null;
    });
});

// ---------- _fetchPendingRequestIds -----------------------------------------

describe('AttestationPublisher: _fetchPendingRequestIds', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    it('returns null when indexer URL is unavailable', async function () {
        const hub = makeHub(MY_PUB, { _resolveBtcIndexerUrl: async () => null });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'test-' + process.pid + '.jsonl');
        const result = await pub._fetchPendingRequestIds();
        expect(result).to.be.null;
    });

    it('returns a Set of request IDs from the indexer response', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: {
                    requests: [
                        { request_id: 'AA'.repeat(32), block_index: 10, action_index: 1 },
                        { request_id: 'BB'.repeat(32), block_index: 10, action_index: 2 }
                    ]
                }
            });

        const ids = await pub._fetchPendingRequestIds();
        expect(ids).to.be.instanceof(Set);
        expect(ids.has('aa'.repeat(32))).to.equal(true);
        expect(ids.has('bb'.repeat(32))).to.equal(true);
        expect(ids.size).to.equal(2);
    });

    it('returns an empty Set when there are no pending requests', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: { requests: [] }
            });

        const ids = await pub._fetchPendingRequestIds();
        expect(ids).to.be.instanceof(Set);
        expect(ids.size).to.equal(0);
    });

    it('returns null when the indexer returns a result.error', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: { error: 'method not found' }
            });

        const ids = await pub._fetchPendingRequestIds();
        expect(ids).to.be.null;
    });

    it('returns null when the indexer call fails (network error)', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .replyWithError('ECONNREFUSED');

        const ids = await pub._fetchPendingRequestIds();
        expect(ids).to.be.null;
    });

    it('returns null when the indexer call throws a non-Error value (e.message falsy branch)', async function () {
        // Line 418: `e && e.message ? e.message : e` (the `e` branch when message is absent)
        const pub = makePublisher(MY_PUB);
        const axios = require('axios');
        sinon.stub(axios, 'post').rejects({ code: 'ECONNREFUSED' });  // plain object, no .message
        const ids = await pub._fetchPendingRequestIds();
        expect(ids).to.be.null;
        sinon.restore();
    });

    it('handles result without requests field (result.requests || [] fallback)', async function () {
        const pub = makePublisher(MY_PUB);
        // Return a result that has no `requests` field; should fall back to []
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: {}  // no requests field
            });

        const ids = await pub._fetchPendingRequestIds();
        expect(ids).to.be.instanceof(Set);
        expect(ids.size).to.equal(0);
    });

    it('skips entries with empty request_id', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: {
                    requests: [
                        { request_id: '', block_index: 1, action_index: 1 },
                        { request_id: 'AA'.repeat(32), block_index: 1, action_index: 2 }
                    ]
                }
            });

        const ids = await pub._fetchPendingRequestIds();
        expect(ids.size).to.equal(1);
        expect(ids.has('aa'.repeat(32))).to.equal(true);
    });

    it('handles pagination: stops when result count < PENDING_PAGE_LIMIT (100)', async function () {
        const pub = makePublisher(MY_PUB);
        // Return 50 entries (< 100); should stop after 1 page
        const requests = Array.from({ length: 50 }, (_, i) => ({
            request_id: String(i).padStart(64, '0'),
            block_index: i,
            action_index: i
        }));
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, { jsonrpc: '2.0', id: 1, result: { requests } });

        const ids = await pub._fetchPendingRequestIds();
        expect(ids.size).to.equal(50);
    });

    it('paginates when first response has exactly 100 (PENDING_PAGE_LIMIT) entries', async function () {
        const pub = makePublisher(MY_PUB);
        // Page 1: exactly 100 entries → triggers pagination cursor
        const page1 = Array.from({ length: 100 }, (_, i) => ({
            request_id: ('00'.repeat(31) + String(i).padStart(2, '0')).slice(-64),
            block_index: i,
            action_index: i
        }));
        // Page 2: 1 entry → stops pagination
        const page2 = [{
            request_id: 'ff'.repeat(32),
            block_index: 200,
            action_index: 0
        }];

        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, { jsonrpc: '2.0', id: 1, result: { requests: page1 } });
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, { jsonrpc: '2.0', id: 1, result: { requests: page2 } });

        const ids = await pub._fetchPendingRequestIds();
        expect(ids.size).to.equal(101);
        expect(ids.has('ff'.repeat(32))).to.equal(true);
    });
});

// ---------- onRequestFinalized edge cases -----------------------------------

describe('AttestationPublisher: onRequestFinalized edge cases', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('returns early when event is null', async function () {
        const pub = makePublisher();
        await pub.onRequestFinalized(null);  // should not throw
    });

    it('returns early when event has no requestId', async function () {
        const pub = makePublisher();
        await pub.onRequestFinalized({});  // should not throw
    });

    it('proceeds (as follower) when identity is null in onRequestFinalized', async function () {
        // Line 155: `this.identity ? getPubkeyHex() : null` (null branch)
        const hub = makeHub(MY_PUB);
        hub.getIdentity = () => null;
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-noid-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx-noid' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId:    'ef'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: LEADER_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: LEADER_PUB
        });

        // myPubkey = null → isLeader = false → FOLLOWER path → no broadcast
        expect(bcast.called).to.equal(false);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('logs a warning and returns when signatures array is empty', async function () {
        const pub = makePublisher();
        const warnStub = sinon.stub(console, 'warn');
        await pub.onRequestFinalized({
            requestId: '11'.repeat(32),
            providerId: 'http_get',
            responseBody: Buffer.from('foo'),
            status: 'ok',
            meta: '',
            signatures: []
        });
        expect(warnStub.called).to.equal(true);
        expect(warnStub.args[0][0]).to.match(/no sigs/);
        warnStub.restore();
    });

    it('logs a warning and returns when signatures is null/missing', async function () {
        const pub = makePublisher();
        const warnStub = sinon.stub(console, 'warn');
        await pub.onRequestFinalized({
            requestId: '22'.repeat(32),
            providerId: 'http_get',
            responseBody: null,
            status: 'ok',
            meta: '',
            signatures: null
        });
        expect(warnStub.called).to.equal(true);
        warnStub.restore();
    });

    it('drops oversized wire payloads with a console.error and does not enqueue', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-oversize-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const errStub = sinon.stub(console, 'error');

        // Create a responseBody that will make the wire > 8189 bytes
        const hugeBody = Buffer.alloc(8200, 'X');
        await pub.onRequestFinalized({
            requestId:    '33'.repeat(32),
            providerId:   'http_get',
            responseBody: hugeBody,
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 5, redundancy: 1 }
        });

        expect(errStub.called).to.equal(true);
        expect(errStub.args[0][0]).to.match(/exceeds encoder limit/);
        expect(readQueue(pub.queuePath)).to.have.length(0);
        errStub.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('logs a warning when no broadcast hook is configured (leader, no broadcaster)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-nobcast-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const warnStub = sinon.stub(console, 'warn');

        await pub.onRequestFinalized({
            requestId:    '44'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 5, redundancy: 1 }
        });

        expect(warnStub.called).to.equal(true);
        warnStub.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('enqueues and retries on broadcast failure (entry stays on queue)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-bcastfail-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().rejects(new Error('broadcast network error'));
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId:    '55'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 5, redundancy: 1 }
        });

        expect(bcast.calledOnce).to.equal(true);
        // Entry must remain on the queue for the next sweep retry
        expect(readQueue(pub.queuePath)).to.have.length(1);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('uses null leaderPubkey when responsible is null and event has no leaderPubkey', async function () {
        // Line 191: `responsible && responsible.length ? responsible[0] : null`
        // When no leaderPubkey and _computeResponsible returns null (no block_index) → leaderPubkey=null
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-noLeader-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx-noleader' });
        pub.setBroadcastHook(bcast);

        // No leaderPubkey, no request block_index → responsible=null → leaderPubkey=null
        // isLeader = (null && MY_PUB && null === MY_PUB) → false → FOLLOWER path
        await pub.onRequestFinalized({
            requestId:    'ab'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
            // no leaderPubkey, no request
        });

        // With leaderPubkey=null the isLeader check fails → follower path, no broadcast
        expect(bcast.called).to.equal(false);
        expect(readQueue(pub.queuePath)).to.have.length(1);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('normalizes redundancy to 1 (not signatures.length) when request.redundancy is absent (item 2643)', async function () {
        // Canonical rule shared with AttestationRound and the indexer:
        // Math.max(1, Number(redundancy) || 1). The prior signatures.length
        // fallback produced a responsible list of a different LENGTH than
        // consensus derived, mis-ranking failover step-in.
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-redfallback-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx1' });
        pub.setBroadcastHook(bcast);
        const computeStub = sinon.stub(pub, '_computeResponsible').resolves([MY_PUB]);

        await pub.onRequestFinalized({
            requestId:    '66'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            // three signers, but request carries a block and NO redundancy:
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) },
                           { pubkey: LEADER_PUB, sig: 'ff'.repeat(64) },
                           { pubkey: 'cc'.repeat(32), sig: 'dd'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 100 }
        });

        expect(computeStub.calledOnce).to.equal(true);
        // redundancy arg is 1 (canonical), NOT 3 (signatures.length).
        expect(computeStub.firstCall.args[2]).to.equal(1);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('uses "ok" status when event.status is absent (status || "ok" branch)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-status-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx-status-fallback' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId:    '88'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            // no status, should fall back to 'ok'
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB
        });

        expect(bcast.calledOnce).to.equal(true);
        const wire = bcast.args[0][0];
        const parts = wire.split('|');
        expect(parts[5]).to.equal('ok');  // status field
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('logs "?" when broadcaster returns result without txid', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-notxid-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        // Return result without txid to exercise `result.txid ? result.txid : '?'` branch
        const bcast = sinon.stub().resolves({});
        pub.setBroadcastHook(bcast);
        const logStub = sinon.stub(console, 'log');

        await pub.onRequestFinalized({
            requestId:    '99'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB
        });

        const loggedBroadcast = logStub.args.find(a => String(a[0]).match(/broadcast.*txid=\?/));
        expect(loggedBroadcast).to.exist;
        logStub.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });

    it('computes responsible set from block_index when available', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-blk-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx-blk' });
        pub.setBroadcastHook(bcast);

        const computeStub = sinon.stub(pub, '_computeResponsible').resolves([MY_PUB, LEADER_PUB]);

        await pub.onRequestFinalized({
            requestId:    '77'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            request:      { block_index: 42, redundancy: 2 }
            // no leaderPubkey, uses responsible[0]
        });

        expect(computeStub.calledOnce).to.equal(true);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    });
});

// ---------- _processQueue extra paths not covered by replay suite -----------

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () {

    let queueFile;

    beforeEach(function () {
        queueFile = path.join(os.tmpdir(), 'attq-extra-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    });

    afterEach(function () {
        sinon.restore();
        try { fs.unlinkSync(queueFile); } catch (_) {}
    });

    it('logs a warning and retains entry when no broadcaster is configured during sweep', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // No broadcast hook configured
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set(['aa'.repeat(32)]));
        const warnStub = sinon.stub(console, 'warn');

        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,  // old, eligible
            requestId:    'aa'.repeat(32),
            wire:         'ATTEST|1|' + 'aa'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(warnStub.called).to.equal(true);
        const msg = warnStub.args.find(a => String(a[0]).match(/no broadcast pipeline/));
        expect(msg).to.exist;
        // Entry should be retained
        expect(readQueue(queueFile)).to.have.length(1);
        warnStub.restore();
    });

    it('returns immediately (no error) when the queue is empty', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // Write an empty queue
        fs.writeFileSync(queueFile, '');
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set());
        await pub._processQueue();  // should return immediately, no throw
        // Verify _fetchPendingRequestIds was NOT called (early return)
        // (We can check by seeing the stub was not called)
        // Actually the stub is set up; the early return happens before _fetchPendingRequestIds
    });

    it('uses singular "entry" in the unreachable-indexer log when exactly 1 entry is queued', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(null);  // indexer unreachable
        const warnStub = sinon.stub(console, 'warn');

        writeQueue(queueFile, [{
            ts:           Date.now() - 60000,
            requestId:    'aa'.repeat(32),
            wire:         'ATTEST|1|' + 'aa'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();
        expect(warnStub.called).to.equal(true);
        const msg = warnStub.args.find(a => String(a[0]).match(/1 entry retained/));
        expect(msg).to.exist;
        warnStub.restore();
    });

    it('skips a queue entry whose responsible set does not include this node (rank === null continue)', async function () {
        // Line 360: `if (rank === null) continue`
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        const bcast = sinon.stub().resolves({ txid: 'should-not-fire' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set(['cc'.repeat(32)]));

        // responsible array does NOT include MY_PUB → _myRank returns null → skip
        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,
            requestId:    'cc'.repeat(32),
            wire:         'ATTEST|1|' + 'cc'.repeat(32) + '|http_get|Zm9v|ok||1|' + LEADER_PUB + '|' + 'ee'.repeat(64),
            responsible:  [LEADER_PUB, OTHER_PUB],  // MY_PUB not listed
            leaderPubkey: LEADER_PUB
        }]);

        await pub._processQueue();
        expect(bcast.called).to.equal(false);
        expect(readQueue(queueFile)).to.have.length(1);  // entry retained (not our responsibility)
    });

    it('handles queue entry with no ts field (ts || 0 branch) as not-yet-eligible', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        pub.leaderRetryMs = 999999;  // very long; entry without ts treated as ts=0 so age=now >= very-long is false
        const bcast = sinon.stub().resolves({ txid: 'should-not-fire' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set(['dd'.repeat(32)]));

        // Entry with no ts field; ts falls back to 0, age = Date.now() which is large
        // but with leaderRetryMs = 999999 the entry is ONLY eligible if age >= leaderRetryMs
        // Since now - 0 = current epoch ms (~1.7e12) which is >> 999999, it's eligible.
        // So we need an extremely large leaderRetryMs to make it NOT eligible.
        pub.leaderRetryMs = Number.MAX_SAFE_INTEGER;

        writeQueue(queueFile, [{
            requestId:    'dd'.repeat(32),
            wire:         'ATTEST|1|' + 'dd'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
            // no ts, falls back to 0 in the eligibility formula
        }]);

        await pub._processQueue();
        // With MAX_SAFE_INTEGER retryMs, age (now - 0 = ~1.7e12ms) is less than MAX_SAFE_INTEGER
        // so the entry is NOT eligible; broadcast should not be called
        expect(bcast.called).to.equal(false);
    });

    it('logs "?" txid in the replay sweep log when broadcaster returns no txid', async function () {
        // Line 382: `result.txid ? result.txid : '?'`
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // Return result without txid
        const bcast = sinon.stub().resolves({});
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set(['ee'.repeat(32)]));
        const logStub = sinon.stub(console, 'log');

        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,
            requestId:    'ee'.repeat(32),
            wire:         'ATTEST|1|' + 'ee'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ff'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(bcast.calledOnce).to.equal(true);
        const logged = logStub.args.find(a => String(a[0]).match(/txid=\?/));
        expect(logged).to.exist;
        logStub.restore();
    });

    it('logs an error and retains entry when replay broadcast throws', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // Definitive (never-sent) error so this exercises the plain-retry path, not
        // the ambiguous-defer path (item 2674), which has its own tests below.
        const refused = new Error('connect ECONNREFUSED'); refused.code = 'ECONNREFUSED';
        const bcast = sinon.stub().rejects(refused);
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set(['bb'.repeat(32)]));
        const errStub = sinon.stub(console, 'error');

        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,
            requestId:    'bb'.repeat(32),
            wire:         'ATTEST|1|' + 'bb'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(errStub.called).to.equal(true);
        const msg = errStub.args.find(a => String(a[0]).match(/replay broadcast failed/));
        expect(msg).to.exist;
        // Entry must remain in the queue for the next retry
        expect(readQueue(queueFile)).to.have.length(1);
        errStub.restore();
    });
});

// ---------- _defaultBroadcast -----------------------------------------------

describe('AttestationPublisher: _defaultBroadcast', function () {

    afterEach(function () { sinon.restore(); });

    it('throws when encoder is not configured', async function () {
        const pub = makePublisher();
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no encoder/);
    });

    it('throws when walletSignFn is not configured', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no wallet sign hook/);
    });

    it('throws when btcAddress is not configured', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no BTC_ADDRESS/);
    });

    it('throws when btcPubkeyHex is not configured', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress = '1Test';
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no BTC_PUBKEY_HEX/);
    });

    it('throws when encoder returns no UTXOs', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub().resolves([]) });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no UTXOs/);
    });

    it('throws when encoder returns null UTXOs', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub().resolves(null) });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no UTXOs/);
    });

    it('throws when encoder.createTx returns no PSBT', async function () {
        const pub = makePublisher();
        const encoder = {
            getUtxos:  sinon.stub().resolves([{ txid: 'tx', vout: 0, value: 1000 }]),
            createTx:  sinon.stub().resolves(null)  // returns null → no psbt
        };
        pub.setEncoder(encoder);
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no PSBT/);
    });

    it('throws when walletSignFn returns invalid tx hex', async function () {
        const pub = makePublisher();
        const encoder = {
            getUtxos: sinon.stub().resolves([{ txid: 'tx', vout: 0, value: 1000 }]),
            createTx: sinon.stub().resolves({ psbt: 'psbt-hex' })
        };
        pub.setEncoder(encoder);
        pub.setWalletSignHook(sinon.stub().resolves(null));  // returns null, invalid
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub._defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/invalid tx hex/);
    });

    it('succeeds end-to-end: getUtxos → createTx → walletSign → broadcastTx', async function () {
        const pub = makePublisher();
        const encoder = {
            getUtxos:    sinon.stub().resolves([{ txid: 'tx', vout: 0, value: 1000 }]),
            createTx:    sinon.stub().resolves({ psbt: 'psbt-hex' }),
            broadcastTx: sinon.stub().resolves({ txid: 'broadcast-txid' })
        };
        pub.setEncoder(encoder);
        pub.setWalletSignHook(sinon.stub().resolves('signed-tx-hex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);

        const result = await pub._defaultBroadcast('wire-payload');
        expect(result.txid).to.equal('broadcast-txid');
        expect(encoder.createTx.calledOnce).to.equal(true);
        const createTxArgs = encoder.createTx.args[0][0];
        expect(createTxArgs.data).to.equal('wire-payload');
        expect(createTxArgs.encoding).to.equal('P2SH');
    });
});

// ---------- items 2674 / 2676 / 2678 / 2681: effector-safety guards ----------

describe('AttestationPublisher: effector-safety guards', function () {

    const wireFor = (rid) => 'ATTEST|1|' + rid + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64);

    afterEach(function () {
        sinon.restore();
        delete process.env.ATTEST_ENABLED;
        delete process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW;
        delete process.env.ATTEST_SPEND_WINDOW_MS;
    });

    // ── item 2678 kill switch ──
    it('defaults to enabled', function () {
        expect(makePublisher(MY_PUB).enabled).to.equal(true);
    });

    it('disabled: onRequestFinalized enqueues and broadcasts nothing (item 2678)', async function () {
        process.env.ATTEST_ENABLED = 'false';
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        await pub.onRequestFinalized({
            requestId: '33'.repeat(32), providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(bcast.called).to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    });

    it('disabled: _processQueue does not query the indexer or broadcast (item 2678)', async function () {
        process.env.ATTEST_ENABLED = 'false';
        const pub = makePublisher(MY_PUB);
        const fetchStub = sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set());
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: '33'.repeat(32),
            wire: wireFor('33'.repeat(32)), responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(fetchStub.called).to.equal(false);
        expect(bcast.called).to.equal(false);
    });

    // ── item 2681 enqueue-gate: no spend without a durable record ──
    it('leader skips broadcast when the durable enqueue fails (item 2681)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = '/nonexistent-root/cannot-write.jsonl';
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        const errStub = sinon.stub(console, 'error');
        await pub.onRequestFinalized({
            requestId: '77'.repeat(32), providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(bcast.called, 'must not spend a BTC fee without a durable record').to.equal(false);
        expect(pub._enqueueFailures).to.equal(1);
        errStub.restore();
    });

    // ── item 2681 durable spend-audit record ──
    it('writes an append-only spend-audit record on a successful broadcast (item 2681)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.spendLogPath = path.join(os.tmpdir(), 'attest-spend-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
        const rid = 'ab'.repeat(32);
        pub.setBroadcastHook(sinon.stub().resolves({ txid: 'txid-123' }));
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        const recs = readQueue(pub.spendLogPath);
        expect(recs.length).to.equal(1);
        expect(recs[0].txid).to.equal('txid-123');
        expect(recs[0].requestId).to.equal(rid);
        try { fs.unlinkSync(pub.spendLogPath); } catch (_) {}
    });

    // ── item 2676 per-window BTC spend ceiling ──
    it('sweep stops at the per-window ceiling, retaining the rest (item 2676)', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const pub = makePublisher(MY_PUB);
        const rid1 = '88'.repeat(32), rid2 = '99'.repeat(32);
        pub.setBroadcastHook(sinon.stub().resolves({ txid: 'x' }));
        const bcast = pub.broadcastFn;
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid1, rid2]));
        writeQueue(pub.queuePath, [
            { ts: Date.now() - 10 * 60000, requestId: rid1, wire: wireFor(rid1), responsible: [MY_PUB], leaderPubkey: MY_PUB },
            { ts: Date.now() - 10 * 60000, requestId: rid2, wire: wireFor(rid2), responsible: [MY_PUB], leaderPubkey: MY_PUB }
        ]);
        await pub._processQueue();
        expect(bcast.calledOnce).to.equal(true);
        expect(readQueue(pub.queuePath).length).to.equal(1);
    });

    // ── item 2674 ambiguous send: never blind re-broadcast ──
    it('marks an ambiguous live-broadcast failure and retains the entry (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');
        const timeout = new Error('socket timeout'); timeout.code = 'ETIMEDOUT';
        pub.setBroadcastHook(sinon.stub().rejects(timeout));
        const rid = '33'.repeat(32);
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(pub._ambiguousSends.has(rid)).to.equal(true);
        expect(pub._publishedRequests.has(rid)).to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(1);   // retained for the sweep
    });

    it('sweep DEFERS re-broadcast of a recently-ambiguous, still-pending request (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        const rid = '44'.repeat(32);
        pub._ambiguousSends.set(rid, Date.now());   // just now, within cooldown
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'must not re-broadcast within the ambiguous cooldown').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(1);
    });

    it('sweep re-broadcasts once the ambiguous cooldown passes and it is still pending (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        const rid = '55'.repeat(32);
        pub.ambiguousCooldownMs = 1000;
        pub._ambiguousSends.set(rid, Date.now() - 5000);   // older than cooldown
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.calledOnce).to.equal(true);
        expect(pub._ambiguousSends.has(rid)).to.equal(false);
    });

    it('sweep drops an ambiguous request that has LEFT the pending set, without re-broadcast (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        const rid = '66'.repeat(32);
        pub._ambiguousSends.set(rid, Date.now());
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set());   // landed/expired
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called).to.equal(false);
        expect(pub._ambiguousSends.has(rid)).to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    });

    // ── : the spend ceiling must hold across the awaited broadcast ──
    it('two concurrent finalized events cannot both pass a ceiling of 1 ()', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');

        // Park every broadcast until both handlers have reached the await: that is the
        // interleaving the pure-predicate allow() could not survive, since both
        // handlers then read the same pre-send count and both spend a real fee.
        let release;
        const gate = new Promise(res => { release = res; });
        const bcast = sinon.stub().callsFake(async () => { await gate; return { txid: 'x' }; });
        pub.setBroadcastHook(bcast);

        const finalize = (rid) => pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        const inFlight = [finalize('a1'.repeat(32)), finalize('b2'.repeat(32))];
        release();
        await Promise.all(inFlight);

        expect(bcast.callCount, 'a ceiling of 1 must admit exactly one irreversible send').to.equal(1);
        expect(pub.spendGuard.stats().count.inWindow).to.equal(1);
    });

    // ── : the at-most-once guard must survive a restart ──

    // Minimal hub DB double over the attest_published_requests marker table.
    function makeMarkerDb(rows, failOn) {
        const calls = [];
        return {
            calls,
            doQuery: async (sql, params) => {
                calls.push({ sql, params });
                if (failOn && failOn.test(sql)) throw new Error('marker table unreachable');
                if (/^SELECT/.test(sql)) {
                    return /WHERE request_id/.test(sql)
                        ? rows.filter(r => r.request_id === params[0])
                        : rows.slice();
                }
                if (/^INSERT/.test(sql)) {
                    // ON DUPLICATE KEY UPDATE request_id = request_id: an existing row stands.
                    if (!rows.find(r => r.request_id === params[0])) rows.push({ request_id: params[0], txid: null, sent_at: null });
                    return {};
                }
                if (/^UPDATE/.test(sql)) {
                    const row = rows.find(r => r.request_id === params[1]);
                    if (row) { row.txid = params[0]; row.sent_at = new Date(); }
                    return {};
                }
                if (/^DELETE/.test(sql)) {
                    // ... WHERE request_id = ? AND sent_at IS NULL: a confirmed marker survives.
                    const i = rows.findIndex(r => r.request_id === params[0]);
                    if (i >= 0 && (rows[i].sent_at === null || rows[i].sent_at === undefined)) rows.splice(i, 1);
                    return {};
                }
                return {};
            }
        };
    }

    it('startup hydration adopts sent markers and quarantines intent-only rows ()', async function () {
        const sent = 'd4'.repeat(32), intent = 'e5'.repeat(32);
        const db = makeMarkerDb([
            { request_id: sent,   txid: 'tx-1', sent_at: new Date() },
            { request_id: intent, txid: null,   sent_at: null }
        ]);
        const pub = makePublisher(MY_PUB, { db });
        await pub._hydratePublishedMarkers();
        expect(pub._publishedRequests.has(sent)).to.equal(true);
        expect(pub._quarantinedRequests.has(intent)).to.equal(true);
        expect(pub._quarantinedRequests.has(sent)).to.equal(false);
        expect(pub.getPublisherStats().quarantined).to.equal(1);
    });

    it('sweep does NOT re-broadcast a still-pending request with a durable sent marker ()', async function () {
        // The restart case: fresh process (empty in-process guards), the response was
        // broadcast before the crash and is still PENDING because it is not yet mined.
        const rid = 'd6'.repeat(32);
        const db = makeMarkerDb([{ request_id: rid, txid: 'tx-pre-crash', sent_at: new Date() }]);
        const pub = makePublisher(MY_PUB, { db });
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'a second BTC fee for an already-sent response').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    });

    it('sweep never re-broadcasts a quarantined request ()', async function () {
        const rid = 'd7'.repeat(32);
        const db = makeMarkerDb([{ request_id: rid, txid: null, sent_at: null }]);
        const pub = makePublisher(MY_PUB, { db });
        await pub._hydratePublishedMarkers();
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'an unknown-on-chain-state request must await operator replay').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    });

    it('sweep FAILS CLOSED and retains the entry when the marker is unreadable ()', async function () {
        const rid = 'd8'.repeat(32);
        const db = makeMarkerDb([], /^SELECT request_id, txid/);
        const pub = makePublisher(MY_PUB, { db });
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, '_fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'must not spend when the request cannot be proven unpublished').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(1);
    });

    it('live path records durable intent BEFORE the send and confirms it after ()', async function () {
        const rid = 'd9'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        let intentAtSendTime = null;
        pub.setBroadcastHook(async () => {
            intentAtSendTime = db.calls.filter(c => /^INSERT/.test(c.sql)).length;
            return { txid: 'tx-live' };
        });
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(intentAtSendTime, 'intent must be durable before the fee is spent').to.equal(1);
        expect(rows.length).to.equal(1);
        expect(rows[0].txid).to.equal('tx-live');
        expect(rows[0].sent_at).to.not.equal(null);
    });

    // The other half of #4250: the marker must never make a NEVER-SENT request worse
    // off than it was without it. An intent row that outlives a no-send exit is read as
    // a crash-mid-send at the next startup, and quarantine is permanent (operator-only
    // replay), so a routine ceiling trip or RPC rejection plus a restart would strand a
    // request the pre-marker code would simply have published in a later window.

    it('a ceiling-blocked (never sent) request leaves NO intent row and survives a restart ()', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const sent = 'e1'.repeat(32), blocked = 'e2'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        pub.setBroadcastHook(sinon.stub().resolves({ txid: 'tx-1' }));
        const finalize = (rid) => pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        await finalize(sent);
        await finalize(blocked);
        expect(rows.map(r => r.request_id), 'the ceiling trip must not record an intent to send').to.deep.equal([sent]);

        // Restart over the same marker table and the same WAL: the blocked entry must
        // still be publishable, not quarantined.
        const pub2 = makePublisher(MY_PUB, { db });
        pub2.queuePath = pub.queuePath;
        await pub2._hydratePublishedMarkers();
        expect(pub2._quarantinedRequests.size, 'a never-sent request must not be quarantined').to.equal(0);
        const bcast2 = sinon.stub().resolves({ txid: 'tx-2' });
        pub2.setBroadcastHook(bcast2);
        sinon.stub(pub2, '_fetchPendingRequestIds').resolves(new Set([blocked]));
        writeQueue(pub2.queuePath, readQueue(pub2.queuePath).map(e => Object.assign({}, e, { ts: Date.now() - 60 * 60000 })));
        await pub2._processQueue();
        expect(bcast2.called, 'the deferred response must publish in the later window').to.equal(true);
    });

    it('a definitive send failure withdraws its intent row ()', async function () {
        const rid = 'e3'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        pub.setBroadcastHook(sinon.stub().rejects(new Error('Encoder RPC error: rejected')));
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(rows.length, 'a rejected pre-send leaves nothing to quarantine').to.equal(0);
    });

    it('an AMBIGUOUS send failure KEEPS its intent row ()', async function () {
        // The mirror of the test above: the tx may have reached the BTC node, so the
        // intent must survive and quarantine on restart rather than risk a second fee.
        const rid = 'e4'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        const ambiguous = new Error('socket hang up');
        ambiguous.attestAmbiguousSend = true;
        pub.setBroadcastHook(sinon.stub().rejects(ambiguous));
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(rows.length).to.equal(1);
        expect(rows[0].sent_at, 'an ambiguous send stays intent-only, which is what quarantines it').to.equal(null);
    });

    it('a send that never went out releases its reservation ()', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');
        pub.setBroadcastHook(sinon.stub().rejects(new Error('Encoder RPC error: rejected')));
        await pub.onRequestFinalized({
            requestId: 'c3'.repeat(32), providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(pub.spendGuard.stats().count.inWindow, 'a failed send consumes no budget').to.equal(0);
        expect(pub.spendGuard.allow()).to.equal(true);
    });
});
