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

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
// The real classifier, so the 5xx guard below is pinned against the code that
// actually decides whether a failed send may be re-broadcast.
const { isAmbiguousSendError } = require('../../src/lib/idempotent_broadcast.js');

// ────────────────────────────────────────────────────────────────────────────
// Load EncoderClient with axios stubbed
// ────────────────────────────────────────────────────────────────────────────

let axiosStub;
let EncoderClient;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    EncoderClient = proxyquire('../../src/EncoderClient', { axios: axiosStub });
}

function okResponse(result) {
    return { data: { result: result || 'ok', error: null } };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('EncoderClient', function () {

    beforeEach(function () {
        loadModule();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('stores encoderUrl, apiKey, and timeout', function () {
            let c = new EncoderClient('http://enc/rpc', 'key123', 5000);
            expect(c.encoderUrl).to.equal('http://enc/rpc');
            expect(c.apiKey).to.equal('key123');
            expect(c.timeout).to.equal(5000);
        });

        // The default has to be STRICTLY GREATER than the encoder's own worst-case
        // internal budget, not equal to it. Pinned as an inequality against the
        // encoder's shipped NODE_RPC_TIMEOUT (30000) times its longest sequential
        // sendrawtransaction chain (3 hops: _sendRaw, an uncached chainName for the
        // isRegtest gate, and the fee-cap retry _sendRaw), because equality is the
        // defect: an abort here is classified ambiguous and dead-letters the round.
        it('defaults to a budget strictly greater than the encoder worst-case RPC chain', function () {
            let c = new EncoderClient('http://enc/rpc', '');
            expect(c.timeout).to.be.above(3 * 30000);
            expect(c.timeout).to.equal(120000);
        });

        // A timeout is the one knob where 0 must NOT mean "explicitly set": axios reads
        // 0 as no timeout at all, which would wedge a publisher pass on a hung encoder
        // forever. Non-positive and non-finite values fall back rather than disarming.
        it('falls back to the default for a non-positive or non-finite timeout', function () {
            expect(new EncoderClient('http://enc/rpc', '', 0).timeout).to.equal(120000);
            expect(new EncoderClient('http://enc/rpc', '', -1).timeout).to.equal(120000);
            expect(new EncoderClient('http://enc/rpc', '', NaN).timeout).to.equal(120000);
            expect(new EncoderClient('http://enc/rpc', '', 'abc').timeout).to.equal(120000);
        });

        it('initialises _rpcId to 0', function () {
            let c = new EncoderClient('http://enc/rpc', '');
            expect(c._rpcId).to.equal(0);
        });
    });

    // ── _call ───────────────────────────────────────────────────────────────

    describe('_call()', function () {
        it('throws when encoderUrl is empty', async function () {
            let c = new EncoderClient('', '');
            let threw = false;
            try { await c._call('get_utxos', {}); } catch (e) {
                threw = true;
                expect(e.message).to.include('encoderUrl not configured');
            }
            expect(threw).to.be.true;
        });

        it('increments _rpcId with each call', async function () {
            axiosStub.post.resolves(okResponse());
            let c = new EncoderClient('http://enc/rpc', '');
            await c._call('get_utxos', {});
            await c._call('get_utxos', {});
            expect(c._rpcId).to.equal(2);
        });

        it('sends correct JSON-RPC 2.0 body', async function () {
            axiosStub.post.resolves(okResponse({ utxos: [] }));
            let c = new EncoderClient('http://enc/rpc', '');
            await c._call('get_utxos', { address: 'D123' });
            let body = axiosStub.post.firstCall.args[1];
            expect(body.jsonrpc).to.equal('2.0');
            expect(body.method).to.equal('get_utxos');
            expect(body.params).to.deep.equal({ address: 'D123' });
            expect(body.id).to.equal(1);
        });

        it('sets x-api-key header when apiKey is present', async function () {
            axiosStub.post.resolves(okResponse());
            let c = new EncoderClient('http://enc/rpc', 'mykey');
            await c._call('broadcast_tx', { tx_hex: 'ab' });
            let opts = axiosStub.post.firstCall.args[2];
            expect(opts.headers['x-api-key']).to.equal('mykey');
        });

        it('does not set x-api-key when apiKey is empty', async function () {
            axiosStub.post.resolves(okResponse());
            let c = new EncoderClient('http://enc/rpc', '');
            await c._call('get_utxos', {});
            let opts = axiosStub.post.firstCall.args[2];
            expect(opts.headers).to.not.have.property('x-api-key');
        });

        it('returns the result field on success', async function () {
            axiosStub.post.resolves({ data: { result: { utxos: [{ txid: 'abc', vout: 0 }] } } });
            let c = new EncoderClient('http://enc/rpc', '');
            let result = await c._call('get_utxos', {});
            expect(result).to.deep.equal({ utxos: [{ txid: 'abc', vout: 0 }] });
        });

        it('throws when response contains an error', async function () {
            axiosStub.post.resolves({ data: { error: { message: 'bad request', code: -32600 } } });
            let c = new EncoderClient('http://enc/rpc', '');
            let threw = false;
            try { await c._call('bad_method', {}); } catch (e) {
                threw = true;
                expect(e.message).to.include('Encoder RPC error');
                expect(e.message).to.include('bad request');
            }
            expect(threw).to.be.true;
        });

        it('returns null when response has no data', async function () {
            axiosStub.post.resolves({ data: null });
            let c = new EncoderClient('http://enc/rpc', '');
            let result = await c._call('get_utxos', {});
            expect(result).to.be.null;
        });

        it('propagates axios errors', async function () {
            axiosStub.post.rejects(new Error('network timeout'));
            let c = new EncoderClient('http://enc/rpc', '');
            let threw = false;
            try { await c._call('get_utxos', {}); } catch (e) {
                threw = true;
                expect(e.message).to.include('network timeout');
            }
            expect(threw).to.be.true;
        });

        // The encoder answers auth, rate-limit and batch-guard failures with a non-2xx
        // status AND a JSON-RPC error body. axios rejects before the 2xx error check
        // below it runs, so the specific reason used to be replaced by the bare status
        // message on every publisher surface and in every dead-letter record.
        function httpError(status, encoderBody) {
            let e = new Error('Request failed with status code ' + status);
            e.isAxiosError = true;
            e.response = { status: status, data: encoderBody };
            return e;
        }

        it('surfaces the encoder reason for 401 / 429 / 400 bodies', async function () {
            const cases = [
                [401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 'Unauthorized'],
                [429, { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } }, 'Too many requests'],
                [400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch too large (max 20 requests per call)' } }, 'Batch too large']
            ];
            for (let [status, body, reason] of cases) {
                axiosStub.post.rejects(httpError(status, body));
                let c = new EncoderClient('http://enc/rpc', '');
                let caught = null;
                try { await c._call('create_tx', {}); } catch (e) { caught = e; }
                expect(caught, 'status ' + status).to.exist;
                expect(caught.message).to.include('Encoder RPC error');
                expect(caught.message).to.include(reason);
                // The SAME object is rethrown, so the retry classifier and the
                // dead-letter record still see the HTTP status.
                expect(caught.response.status).to.equal(status);
            }
        });

        it('leaves a 5xx message untouched so an ambiguous send is never re-labelled retry-safe', async function () {
            // isAmbiguousSendError reads an 'Encoder RPC error' message as a definitive
            // rejection. A 5xx may already have reached the coin node, so prefixing it
            // would turn a possible double-spend into an auto-retry.
            axiosStub.post.rejects(httpError(503, {
                jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Server busy, retry shortly' }
            }));
            let c = new EncoderClient('http://enc/rpc', '');
            let caught = null;
            try { await c._call('broadcast_tx', { tx_hex: 'ab' }); } catch (e) { caught = e; }
            expect(caught.message).to.equal('Request failed with status code 503');
            expect(caught.message).to.not.include('Encoder RPC error');
            expect(isAmbiguousSendError(caught)).to.equal(true);
        });

        it('leaves a non-2xx carrying no JSON-RPC body alone', async function () {
            axiosStub.post.rejects(httpError(404, '<html>not found</html>'));
            let c = new EncoderClient('http://enc/rpc', '');
            let caught = null;
            try { await c._call('create_tx', {}); } catch (e) { caught = e; }
            expect(caught.message).to.equal('Request failed with status code 404');
        });

        // create_tx reports its operational failures with code -32010 and a stable
        // data.reason so a caller can branch on the condition rather than parse a
        // message. Both failure branches must surface it, or which one the encoder
        // happens to use decides whether the code exists.
        it('mirrors the encoder code and data.reason on the 200-with-error-body branch', async function () {
            axiosStub.post.resolves({ data: { error: {
                code: -32010, message: 'insufficient funds',
                data: { reason: 'INSUFFICIENT_FUNDS', required: 12345 }
            } } });
            let c = new EncoderClient('http://enc/rpc', '');
            let caught = null;
            try { await c._call('create_tx', {}); } catch (e) { caught = e; }
            expect(caught.message).to.include('Encoder RPC error');
            expect(caught.rpcCode).to.equal(-32010);
            expect(caught.rpcData.reason).to.equal('INSUFFICIENT_FUNDS');
            expect(caught.rpcData.required).to.equal(12345);
        });

        // This one is a REAL encoder shape end to end, and is the fixture to copy: a
        // create_tx OperationalError is the only family the encoder forwards
        // structurally, as -32010 with data.reason = its xchainCode
        // (xchain-encoder api.js, the `err.operational === true` branch on create_tx
        // and create_envelope_cancel_tx). CHANGE_ADDRESS_REQUIRED is one of those
        // codes; an invented name here is what the first consumer would branch on and
        // silently never match.
        it('mirrors the encoder code and data.reason on the non-2xx branch, status intact', async function () {
            axiosStub.post.rejects(httpError(400, { jsonrpc: '2.0', id: null, error: {
                code: -32010, message: 'no change address', data: { reason: 'CHANGE_ADDRESS_REQUIRED' }
            } }));
            let c = new EncoderClient('http://enc/rpc', '');
            let caught = null;
            try { await c._call('create_tx', {}); } catch (e) { caught = e; }
            expect(caught.rpcCode).to.equal(-32010);
            expect(caught.rpcData.reason).to.equal('CHANGE_ADDRESS_REQUIRED');
            // Same object still, so the retry classifier and the dead-letter record
            // keep reading the HTTP status.
            expect(caught.response.status).to.equal(400);
        });

        // The 5xx rule is what keeps an ambiguous send from being re-labelled
        // retry-safe; attaching the structured fields must not disturb it.
        //
        // Unlike the create_tx fixture above, this body is DELIBERATELY synthetic and
        // must not be copied as a wire example. The encoder never sends it: broadcast_tx
        // collapses every failure to -32010's sibling -32603 with no `data` at all, its
        // own busy body is -32029 with no reason, and UTXO_TRACKER_STALE reaches a caller
        // only through create_tx's -32010. The fixture exists to prove the passthrough is
        // driven by the STATUS and not by the body, so it carries fields the real 5xx
        // lacks on purpose: a consumer that branches on rpcData.reason after a
        // broadcast_tx would read undefined in production.
        it('a 5xx keeps its untouched message and its ambiguous classification', async function () {
            axiosStub.post.rejects(httpError(503, { jsonrpc: '2.0', id: null, error: {
                code: -32000, message: 'Server busy, retry shortly', data: { reason: 'UTXO_TRACKER_STALE' }
            } }));
            let c = new EncoderClient('http://enc/rpc', '');
            let caught = null;
            try { await c._call('broadcast_tx', { tx_hex: 'ab' }); } catch (e) { caught = e; }
            expect(caught.message).to.equal('Request failed with status code 503');
            expect(caught.rpcData.reason).to.equal('UTXO_TRACKER_STALE');
            expect(isAmbiguousSendError(caught)).to.equal(true);
        });
    });

    // ── getUtxos ─────────────────────────────────────────────────────────────

    describe('getUtxos()', function () {
        it('delegates to _call with get_utxos and address param', async function () {
            axiosStub.post.resolves(okResponse({ utxos: [] }));
            let c = new EncoderClient('http://enc/rpc', '');
            await c.getUtxos('Daddress123');
            let body = axiosStub.post.firstCall.args[1];
            expect(body.method).to.equal('get_utxos');
            expect(body.params.address).to.equal('Daddress123');
        });

        it('unwraps the live encoder { utxos: [...] } envelope to a bare array', async function () {
            // create_tx requires a bare array; passing the envelope through
            // failed every default-pipeline broadcast with "utxos must be an
            // array" (first live mainnet ANCHOR flush, 2026-06-11).
            let utxos = [{ txid: 'ab', vout: 0, value: '100.0' }];
            axiosStub.post.resolves(okResponse({ utxos: utxos }));
            let c = new EncoderClient('http://enc/rpc', '');
            expect(await c.getUtxos('D1')).to.deep.equal(utxos);
        });

        it('passes an already-bare array through unchanged', async function () {
            let utxos = [{ txid: 'cd', vout: 1 }];
            axiosStub.post.resolves(okResponse(utxos));
            let c = new EncoderClient('http://enc/rpc', '');
            expect(await c.getUtxos('D1')).to.deep.equal(utxos);
        });

        it('returns null result untouched (no UTXOs / empty response)', async function () {
            axiosStub.post.resolves({ data: { result: null } });
            let c = new EncoderClient('http://enc/rpc', '');
            expect(await c.getUtxos('D1')).to.equal(null);
        });
    });

    // ── createTx ─────────────────────────────────────────────────────────────

    describe('createTx()', function () {
        it('delegates to _call with create_tx', async function () {
            axiosStub.post.resolves(okResponse({ psbt: 'cHNidP8B...' }));
            let c = new EncoderClient('http://enc/rpc', '');
            let params = { utxos: [], pubkey: 'ab', data: 'XCH|DATA' };
            await c.createTx(params);
            let body = axiosStub.post.firstCall.args[1];
            expect(body.method).to.equal('create_tx');
            expect(body.params).to.equal(params);
        });
    });

    // ── broadcastTx ───────────────────────────────────────────────────────────

    describe('broadcastTx()', function () {
        it('delegates to _call with broadcast_tx and tx_hex param', async function () {
            axiosStub.post.resolves(okResponse({ txid: 'deadbeef' }));
            let c = new EncoderClient('http://enc/rpc', '');
            await c.broadcastTx('aabbcc');
            let body = axiosStub.post.firstCall.args[1];
            expect(body.method).to.equal('broadcast_tx');
            expect(body.params.tx_hex).to.equal('aabbcc');
        });
    });
});
