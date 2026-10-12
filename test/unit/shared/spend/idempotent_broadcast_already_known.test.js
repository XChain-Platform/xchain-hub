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

// The encoder's broadcast_tx answers a node error that carries a node code as
// JSON-RPC -32010 with data.reason TX_ALREADY_IN_CHAIN (the node already holds this
// exact transaction) or NODE_REJECTED. The first is a landed send, so the shared
// classifier must read it as ambiguous and never as a retry-safe rejection: a caller
// that rebuilds on it pays a second fee for work already on chain.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const {
    isAmbiguousSendError, isNeverSentError, isAlreadyKnownTx, broadcastOnce
} = require('../../../../src/lib/guards/idempotent_broadcast.js');

function nodeAnswer(reason, extra) {
    return Object.assign(new Error('Encoder RPC error: Transaction already in block chain'), {
        rpcCode: -32010, rpcData: { reason, node_code: reason === 'TX_ALREADY_IN_CHAIN' ? -27 : -26 }
    }, extra || {});
}

describe('idempotent-broadcast: an already-known transaction is a landed send', function () {

    it('reads TX_ALREADY_IN_CHAIN as ambiguous and never as never-sent', function () {
        const e = nodeAnswer('TX_ALREADY_IN_CHAIN');
        expect(isAlreadyKnownTx(e)).to.equal(true);
        expect(isAmbiguousSendError(e)).to.equal(true);
        expect(isNeverSentError(e)).to.equal(false);
    });

    it('keeps TX_ALREADY_IN_CHAIN ambiguous behind a sub-500 status or a neverSent tag', function () {
        const e = nodeAnswer('TX_ALREADY_IN_CHAIN', { response: { status: 400 }, neverSent: true });
        expect(isAmbiguousSendError(e)).to.equal(true);
        expect(isNeverSentError(e)).to.equal(false);
    });

    it('leaves NODE_REJECTED a definitive rejection', function () {
        const e = nodeAnswer('NODE_REJECTED');
        expect(isAlreadyKnownTx(e)).to.equal(false);
        expect(isAmbiguousSendError(e)).to.equal(false);
    });

    it('is false for an error with no structured reason', function () {
        expect(isAlreadyKnownTx(null)).to.equal(false);
        expect(isAlreadyKnownTx(new Error('Encoder RPC error: x'))).to.equal(false);
        expect(isAlreadyKnownTx(Object.assign(new Error('x'), { rpcData: null }))).to.equal(false);
    });

    it('broadcastOnce commits the reservation and tags the error on an already-known answer', async function () {
        const guard = {
            check: () => ({ ok: true }), reserve: () => 'tok',
            commit: sinon.spy(), release: sinon.spy()
        };
        let threw = null;
        try {
            await broadcastOnce({ key: 'r1', guard, ambiguousTag: 'testAmbiguous',
                send: async () => { throw nodeAnswer('TX_ALREADY_IN_CHAIN'); } });
        } catch (e) { threw = e; }
        expect(threw).to.be.an('error');
        expect(threw.testAmbiguous).to.equal(true);
        expect(guard.commit.calledOnceWithExactly('tok')).to.equal(true);
        expect(guard.release.called).to.equal(false);
    });

    it('classifies the reason the encoder client copies off a 200 RPC error body', async function () {
        const axios = { post: sinon.stub().resolves({ data: { jsonrpc: '2.0', id: 1, error: {
            code: -32010, message: 'Transaction already in block chain',
            data: { reason: 'TX_ALREADY_IN_CHAIN', node_code: -27 }
        } } }) };
        const EncoderClient = proxyquire('../../../../src/peers/encoder_client', { axios });
        let caught = null;
        try { await new EncoderClient('http://enc/rpc', '').broadcastTx('aabbcc'); } catch (e) { caught = e; }
        expect(caught.rpcData.reason).to.equal('TX_ALREADY_IN_CHAIN');
        expect(isAmbiguousSendError(caught)).to.equal(true);
    });
});
