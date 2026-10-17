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

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

let axiosStub;
let EncoderClient;

function registerSetup() {
    beforeEach(function () {
        axiosStub = { post: sinon.stub() };
        EncoderClient = proxyquire('../../../src/peers/encoder_client', { axios: axiosStub });
    });
}

function registerRequestTest() {
    it('sends get_tx_status with the txid and returns the result unchanged', async function () {
        const txid = 'ab'.repeat(32);
        const result = { status: 'mempool', confirmations: 0 };
        axiosStub.post.resolves({ data: { result: result, error: null } });

        const returned = await new EncoderClient('http://enc/rpc', 'key').getTxStatus(txid);

        expect(returned).to.equal(result);
        expect(axiosStub.post.callCount).to.equal(1);
        expect(axiosStub.post.firstCall.args[1]).to.deep.equal({
            jsonrpc: '2.0',
            method: 'get_tx_status',
            params: { txid: txid },
            id: 1
        });
    });
}

function registerValidationTests() {
    [
        ['short non-hex text', 'zz'],
        ['uppercase hex', 'AB'.repeat(32)],
        ['65 lowercase hex characters', 'ab'.repeat(32) + '0'],
        ['an empty string', ''],
        ['null', null],
        ['64 non-hex characters', 'g'.repeat(64)]
    ].forEach(function ([label, txid]) {
        it('refuses ' + label + ' before making an RPC', async function () {
            let caught = null;
            try {
                await new EncoderClient('http://enc/rpc', 'key').getTxStatus(txid);
            } catch (err) {
                caught = err;
            }

            expect(caught).to.be.an('error');
            expect(caught.message).to.include('64-character lowercase hex');
            expect(axiosStub.post.notCalled).to.be.true;
        });
    });
}

function registerRpcErrorTest() {
    it('throws the encoder RPC error', async function () {
        axiosStub.post.resolves({
            data: { error: { code: -1, message: 'node down' } }
        });

        let caught = null;
        try {
            await new EncoderClient('http://enc/rpc', 'key').getTxStatus('ab'.repeat(32));
        } catch (err) {
            caught = err;
        }

        expect(caught).to.be.an('error');
        expect(caught.message).to.include('node down');
        expect(axiosStub.post.callCount).to.equal(1);
    });
}

describe('EncoderClient getTxStatus', function () {
    registerSetup();
    registerRequestTest();
    registerValidationTests();
    registerRpcErrorTest();
});
