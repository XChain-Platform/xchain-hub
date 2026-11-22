'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Every publisher rail reads a signer hook's xchain-sdk errors through the shared
// classifier. These cases drive each rail's own failure handler with the two SDK
// shapes that were misread: an HTTP 429 (refused before the node saw it) and a
// JSON-RPC answer that the node already holds the transaction.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');

const AttestationPublisher = require('../../../../src/attestation/publisher.js');
const AttestationRelay = require('../../../../src/attestation/relay.js');
const { makeEngine, makeState, tick, spendLog } = require('../../../helpers/rollcall_publish_venue.js');

function rateLimited() {
    return Object.assign(new Error('Encoder returned HTTP 429 for method broadcast_tx'), {
        code: 'RATE_LIMITED', details: { method: 'broadcast_tx', status: 429, retryAfterSeconds: 2 }
    });
}

function alreadyInChain() {
    return Object.assign(new Error('Encoder RPC error: transaction already in block chain'), {
        code: 'ENCODER_RPC_ERROR',
        details: { method: 'broadcast_tx', rpcError: { code: -32010, data: { reason: 'TX_ALREADY_IN_CHAIN' } } }
    });
}

const SHAPES = [['an SDK rate limit', rateLimited, false], ['an SDK already-known answer', alreadyInChain, true]];

function guard() {
    return { commit: sinon.spy(), release: sinon.spy() };
}

describe('publisher rails read SDK encoder errors', function () {
    SHAPES.forEach(([label, make, ambiguous]) => {
        it('attestation publisher settles ' + label + ' as ' + (ambiguous ? 'ambiguous' : 'unsent'), async function () {
            const self = {
                _broadcastFailed: 0, _ambiguousSends: new Map(), ambiguousCooldownMs: 1000,
                spendGuard: guard(), clearPublishIntent: sinon.stub().resolves(),
                isAmbiguousSendError: AttestationPublisher.prototype.isAmbiguousSendError
            };
            await AttestationPublisher.prototype.onLiveBroadcastFailure.call(self, 'ab'.repeat(32), 200, 'tok', make());
            expect(self.spendGuard.commit.calledOnce, 'commit').to.equal(ambiguous);
            expect(self.spendGuard.release.calledOnce, 'release').to.equal(!ambiguous);
            expect(self._ambiguousSends.size).to.equal(ambiguous ? 1 : 0);
        });

        it('attestation relay settles ' + label + ' as ' + (ambiguous ? 'relayed' : 'retryable'), function () {
            const published = new Set();
            const self = { _broadcastFailed: 0, spendGuard: guard(), appendWal: sinon.spy() };
            const state = { published: { mark: (rid) => published.add(rid) } };
            const send = { spendToken: 'tok', entry: { coin: 'DOGE' } };
            AttestationRelay.prototype.noteLegSendFailed.call(self, 'v4', 'rid', state, send, make(), 'v4');
            expect(self.spendGuard.commit.calledOnce, 'commit').to.equal(ambiguous);
            expect(self.spendGuard.release.calledOnce, 'release').to.equal(!ambiguous);
            expect(published.has('rid')).to.equal(ambiguous);
        });

        it('rollcall settles ' + label + ' as ' + (ambiguous ? 'held' : 'retried'), async function () {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-sdk-'));
            try {
                const eng = makeEngine(dir, async () => { throw make(); }, new Set());
                await tick(eng, makeState());
                const phases = spendLog(dir).map(r => r.phase);
                expect(phases.includes('ambiguous'), 'ambiguous logged').to.equal(ambiguous);
                expect(phases.includes('failed'), 'failed logged').to.equal(!ambiguous);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
