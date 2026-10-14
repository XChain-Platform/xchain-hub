'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression guards for the error shapes an anchor broadcaster can throw.
//
// Two families. Odd values: a frozen error, a string, undefined, or an error whose
// field accessors throw. Tagging one of those must never throw, because a throw there
// loses the original failure, sendBundle then withdraws the publish intent, and the
// next flush funds the anchor again. SDK shapes: a signer hook built on xchain-sdk
// throws EncoderClient errors (src/clients/encoder.js handleError), which carry
// `code` and `details` instead of an axios `.response` or a raw transport code. A
// refusal before processing (ENCODER_HTTP_4xx, RATE_LIMITED) and any failure of a
// build call (details.method create_tx) put nothing on a wire and are retried; a
// network fault, timeout or 5xx on broadcast_tx stays ambiguous and is held.
//
// Every case drives the real publisher code with a fake hook. No network, no DB.

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const StateAnchorPublisher = require('../../src/anchor/publisher');
const { deadLetterAnchorSend } = require('../../src/anchor/publisher/send_failure.js');

const PHASE1 = 'f'.repeat(64);
const REVEAL = 'e'.repeat(64);
const group = [{ chain: 'BTC', network: 'regtest', block_index: 100, checkpoint_seq: 7 }];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-anchor-shapes-'));
let dlSeq = 0;

// An xchain-sdk EncoderClient error as handleError and the RPC branch build it.
function sdkError(code, message, details, extra) {
    const e = new Error(message);
    e.name = code === 'RATE_LIMITED' ? 'SDKRateLimitedError' : 'SDKEncoderError';
    e.code = code;
    e.details = details;
    return Object.assign(e, extra || {});
}
const sdk = {
    http: (status, method) => () => sdkError('ENCODER_HTTP_' + status,
        'Encoder returned HTTP ' + status + ' for method ' + method, { method, status }),
    limited: (method, seconds) => () => sdkError('RATE_LIMITED',
        'Encoder returned HTTP 429 for method ' + method + '; retry after ' + seconds + ' seconds',
        { method, status: 429, retryAfterSeconds: seconds }, { status: 429, retryAfterSeconds: seconds }),
    network: (method) => () => sdkError('ENCODER_NETWORK', 'Encoder request failed: connect ECONNREFUSED',
        { method, error: 'connect ECONNREFUSED' }),
    timeout: (method) => () => sdkError('ENCODER_TIMEOUT', 'Encoder request timed out', { method, timeout: 30000 }),
    rpc: (message, rpcError) => () => sdkError('ENCODER_RPC_ERROR', 'Encoder RPC error: ' + message,
        { method: 'broadcast_tx', rpcError, context: rpcError.data || null, retryable: false })
};

function mkPub() {
    const pub = new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    pub.chunkRetryDelayMs = 0;
    pub.rateLimitMaxWaitMs = 60000;
    pub.ambiguousPollAttempts = 1;
    pub.ambiguousPollDelayMs = 0;
    pub.anchorDeadLetterPath = path.join(scratch, 'anchor-' + (++dlSeq) + '.deadletter.jsonl');
    pub.waits = [];
    pub.sleep = async (ms) => { pub.waits.push(ms); };
    pub.log = [];
    pub.recordAnchorIntent   = async () => { pub.log.push('record'); };
    pub.withdrawAnchorIntent = async () => { pub.log.push('withdraw'); };
    pub.findExistingBundle = async () => null;
    return pub;
}

function deadLetters(pub) {
    if (!fs.existsSync(pub.anchorDeadLetterPath)) return [];
    return fs.readFileSync(pub.anchorDeadLetterPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

// Publish one bundle through a hook that always throws make(); what came of it.
async function publishThrough(make) {
    const pub = mkPub();
    let calls = 0;
    let thrown;
    const hook = async () => { calls++; throw make(); };
    try { await pub.sendBundle({ broadcastFn: hook }, group, 'ANCHOR|0|bundle', null); }
    catch (e) { thrown = e; }
    return { pub, calls, thrown, kept: pub.log.indexOf('withdraw') === -1 };
}

function registerOddValueCases() {
    describe('REG-ANCHOR-SHAPE-001: an odd thrown value never loses the failure or the intent', function () {
        it('a frozen fundsCommitted error is held with its intent and dead-lettered @regression-p0', async function () {
            const original = Object.freeze(Object.assign(new Error('Encoder RPC error: x'),
                { fundsCommitted: true, phase1Txid: PHASE1, revealTxid: REVEAL, revealTxHex: 'reveal-hex' }));
            const r = await publishThrough(() => original);
            expect(r.calls).to.equal(1);
            expect(r.kept, 'intent kept').to.equal(true);
            expect(r.thrown.cause).to.equal(original);
            expect(r.thrown.message).to.equal('Encoder RPC error: x');
            expect(r.thrown.anchorAmbiguousSend).to.equal(true);
            expect(deadLetters(r.pub)[0]).to.include({ phase1Txid: PHASE1, revealTxHex: 'reveal-hex' });
        });

        it('a reveal field whose getter throws keeps the original error, the intent and the readable fields @regression-p0', async function () {
            const original = Object.defineProperty(Object.assign(new Error('x'), { fundsCommitted: true, phase1Txid: PHASE1 }),
                'revealTxHex', { get() { throw new Error('getter boom'); }, enumerable: true });
            const r = await publishThrough(() => original);
            expect(r.calls).to.equal(1);
            expect(r.kept, 'intent kept').to.equal(true);
            expect(r.thrown).to.equal(original);
            const recs = deadLetters(r.pub);
            expect(recs).to.have.length(1);
            expect(recs[0].phase1Txid).to.equal(PHASE1);
            expect(recs[0]).to.not.have.property('revealTxHex');
        });

        for (const [label, make] of [['undefined', () => undefined], ['null', () => null],
                                     ['a frozen timeout', () => Object.freeze(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))]]) {
            it('a hook that throws ' + label + ' is held, not retried @regression-p0', async function () {
                const r = await publishThrough(make);
                expect(r.calls).to.equal(1);
                expect(r.kept, 'intent kept').to.equal(true);
                expect(r.thrown).to.be.an('error');
                expect(r.thrown.anchorAmbiguousSend).to.equal(true);
            });
        }

        it('a frozen neverSent error keeps its classification and is retried @regression-p0', async function () {
            const r = await publishThrough(() => Object.freeze(Object.assign(new Error('below dust'), { neverSent: true })));
            expect(r.calls).to.equal(5);
            expect(r.kept, 'intent withdrawn').to.equal(false);
            expect(r.thrown.neverSent).to.equal(true);
        });
    });
}

// The built-in pipeline with one pre-send step throwing `value`.
function pipelineSigner(stage, value) {
    const thrower = async () => { throw value(); };
    const utxo = { txid: 'a'.repeat(64), vout: 0, value: 1e8, confirmations: 6 };
    return {
        walletSignFn: stage === 'sign' ? thrower : async () => 'signed-hex',
        encoder: {
            getUtxos: stage === 'getUtxos' ? thrower : async () => [utxo],
            createTx: stage === 'createTx' ? thrower : async () => ({ psbt: 'psbt-1', encoding: 'OP_RETURN' }),
            broadcastTx: async () => ({ txid: 'tx-ok' })
        }
    };
}

function registerPipelineCases() {
    describe('REG-ANCHOR-SHAPE-002: the built-in pipeline tags every pre-send throw neverSent', function () {
        const cases = [
            ['getUtxos', 'a string', () => 'utxo read failed'],
            ['createTx', 'undefined', () => undefined],
            ['sign', 'a string', () => 'sign failed'],
            ['sign', 'a frozen Error', () => Object.freeze(new Error('sign failed'))]
        ];
        for (const [stage, label, value] of cases) {
            it(stage + ' throwing ' + label + ' is retried and reported neverSent @regression-p0', async function () {
                const pub = mkPub();
                let entries = 0;
                const signer = pipelineSigner(stage, value);
                let thrown;
                try { await pub.broadcastWithRetry((p) => { entries++; return pub.defaultBroadcast(p, signer); }, 'ANCHOR|0|x'); }
                catch (e) { thrown = e; }
                expect(entries).to.equal(5);
                expect(thrown).to.be.an('error');
                expect(thrown.neverSent).to.equal(true);
                expect(thrown.anchorAmbiguousSend).to.not.equal(true);
            });
        }
    });
}

function registerDeadLetterCases() {
    describe('REG-ANCHOR-SHAPE-003: the dead-letter writer never throws', function () {
        it('writes the record when the error message getter throws @regression-p0', function () {
            const file = path.join(scratch, 'msg-getter.jsonl');
            const e = Object.defineProperty(Object.assign(new Error('x'), { phase1Txid: PHASE1 }), 'message',
                { get() { throw new Error('message boom'); } });
            expect(deadLetterAnchorSend(file, 'P', e)).to.equal(true);
            expect(JSON.parse(fs.readFileSync(file, 'utf8')).phase1Txid).to.equal(PHASE1);
        });

        it('returns false rather than throwing for an unwritable path or an error with nothing to record @regression-p0', function () {
            expect(deadLetterAnchorSend(scratch, 'P', { phase1Txid: PHASE1 })).to.equal(false);
            expect(deadLetterAnchorSend(path.join(scratch, 'x.jsonl'), 'P', 'a string')).to.equal(false);
            expect(deadLetterAnchorSend(path.join(scratch, 'x.jsonl'), 'P', undefined)).to.equal(false);
        });
    });
}

function registerSdkRetriedCases() {
    describe('REG-ANCHOR-SHAPE-004: an SDK failure that sent nothing is retried and its intent withdrawn', function () {
        const retried = [
            ['ENCODER_HTTP_400 on broadcast_tx', sdk.http(400, 'broadcast_tx')],
            ['ENCODER_HTTP_401 on broadcast_tx', sdk.http(401, 'broadcast_tx')],
            ['ENCODER_HTTP_503 on create_tx', sdk.http(503, 'create_tx')],
            ['ENCODER_NETWORK on create_tx', sdk.network('create_tx')],
            ['ENCODER_TIMEOUT on create_tx', sdk.timeout('create_tx')],
            ['ENCODER_RPC_ERROR NODE_REJECTED behind the transport fallback text',
                sdk.rpc('Transaction broadcast failed', { code: -32010, message: 'Transaction broadcast failed',
                                                          data: { reason: 'NODE_REJECTED' } })]
        ];
        for (const [label, make] of retried) {
            it(label + ' @regression-p0', async function () {
                const r = await publishThrough(make);
                expect(r.calls).to.equal(5);
                expect(r.kept, 'intent withdrawn').to.equal(false);
                expect(r.thrown.anchorAmbiguousSend).to.not.equal(true);
                expect(r.pub.spendGuard.spentInWindow()).to.equal(0);
            });
        }

        for (const method of ['broadcast_tx', 'create_tx']) {
            it('RATE_LIMITED on ' + method + ' waits its retry-after without spending attempts @regression-p0', async function () {
                const r = await publishThrough(sdk.limited(method, 2));
                expect(r.calls).to.equal(4);   // three honoured waits, then the anchor defers
                expect(r.pub.waits).to.deep.equal([2000, 2000, 2000]);
                expect(r.kept, 'intent withdrawn').to.equal(false);
            });
        }
    });
}

function registerSdkHeldCases() {
    describe('REG-ANCHOR-SHAPE-005: an SDK failure that may have reached the node is held', function () {
        const held = [
            ['ENCODER_NETWORK on broadcast_tx', sdk.network('broadcast_tx')],
            ['ENCODER_TIMEOUT on broadcast_tx', sdk.timeout('broadcast_tx')],
            ['ENCODER_HTTP_503 on broadcast_tx', sdk.http(503, 'broadcast_tx')],
            ['ENCODER_RPC_ERROR TX_ALREADY_IN_CHAIN', sdk.rpc('transaction already in block chain',
                { code: -32010, message: 'transaction already in block chain', data: { reason: 'TX_ALREADY_IN_CHAIN' } })],
            ['RATE_LIMITED on a funded reveal', () => Object.assign(sdk.limited('broadcast_tx', 2)(),
                { fundsCommitted: true, phase1Txid: PHASE1, revealTxid: REVEAL, revealTxHex: 'reveal-hex' })],
            ['ENCODER_NETWORK on create_tx after funding', () => Object.assign(sdk.network('create_tx')(),
                { fundsCommitted: true, phase1Txid: PHASE1 })]
        ];
        for (const [label, make] of held) {
            it(label + ' @regression-p0', async function () {
                const r = await publishThrough(make);
                expect(r.calls).to.equal(1);
                expect(r.kept, 'intent kept').to.equal(true);
                expect(r.thrown.anchorAmbiguousSend).to.equal(true);
                expect(r.pub.spendGuard.spentInWindow()).to.equal(r.pub.spendGuard.estSpendUsdCents);
            });
        }
    });
}

registerOddValueCases();
registerPipelineCases();
registerDeadLetterCases();
registerSdkRetriedCases();
registerSdkHeldCases();
