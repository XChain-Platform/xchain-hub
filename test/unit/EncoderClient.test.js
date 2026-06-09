'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');

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

        it('uses 30000ms as default timeout', function () {
            let c = new EncoderClient('http://enc/rpc', '');
            expect(c.timeout).to.equal(30000);
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
