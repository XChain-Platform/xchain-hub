'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    isAmbiguousSendError,
    isNeverSentError
} = require('../../../../src/lib/guards/idempotent_broadcast.js');

function sdkError(code, method, rpcError, extra) {
    const reason = rpcError && rpcError.data && rpcError.data.reason;
    const text = reason === 'TX_ALREADY_IN_CHAIN' ? 'transaction already in block chain' : 'Transaction broadcast failed';
    return Object.assign(new Error('Encoder RPC error: ' + text), {
        code,
        details: { method, rpcError }
    }, extra || {});
}

function expectClassification(error, ambiguous, neverSent) {
    expect(isAmbiguousSendError(error)).to.equal(ambiguous);
    expect(isNeverSentError(error)).to.equal(neverSent);
}

describe('idempotent-broadcast SDK encoder error shapes', function () {
    it('reads refusals and pre-send methods as never sent', function () {
        expectClassification(sdkError('RATE_LIMITED', 'broadcast_tx'), false, true);
        expectClassification(sdkError('ENCODER_HTTP_401', 'broadcast_tx'), false, true);
        expectClassification(sdkError('ENCODER_TIMEOUT', 'create_tx'), false, true);
        expectClassification(sdkError('ENCODER_NETWORK', 'get_utxos'), false, true);
    });

    it('lifts the SDK RPC reason without weakening broadcast failures', function () {
        expectClassification(sdkError('ENCODER_RPC_ERROR', 'broadcast_tx', {
            code: -32010, data: { reason: 'TX_ALREADY_IN_CHAIN' }
        }), true, false);
        expectClassification(sdkError('ENCODER_RPC_ERROR', 'broadcast_tx', {
            code: -32010, data: { reason: 'NODE_REJECTED' }
        }), false, false);
        expectClassification(sdkError('ENCODER_RPC_ERROR', 'broadcast_tx', {
            code: -32603
        }), true, false);
        expectClassification(sdkError('ENCODER_HTTP_503', 'broadcast_tx', {
            code: -32010, data: { reason: 'NODE_REJECTED' }
        }), true, false);
    });

    it('keeps funds-committed failures ambiguous and contains hostile accessors', function () {
        expectClassification(sdkError('RATE_LIMITED', 'broadcast_tx', null, {
            fundsCommitted: true
        }), true, false);
        const hostile = {};
        Object.defineProperty(hostile, 'details', { get() { throw new Error('blocked'); } });
        expect(() => isAmbiguousSendError(hostile)).to.not.throw();
        expect(isAmbiguousSendError(hostile)).to.equal(true);
        expect(isNeverSentError(hostile)).to.equal(false);
    });
});
