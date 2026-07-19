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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { isAmbiguousSendError, AtMostOnce, broadcastOnce } = require('../../src/lib/idempotent_broadcast.js');
const SpendGuard = require('../../src/lib/spend_guard.js');

describe('idempotent-broadcast helper ', function () {

    describe('isAmbiguousSendError', function () {
        it('treats a node/encoder RPC rejection as DEFINITIVE (safe to retry)', function () {
            expect(isAmbiguousSendError(new Error('Encoder RPC error: bad-txns-inputs-missingorspent'))).to.equal(false);
        });
        it('treats an HTTP 4xx refusal as DEFINITIVE', function () {
            expect(isAmbiguousSendError({ response: { status: 400 } })).to.equal(false);
        });
        it('treats a never-connected transport error as DEFINITIVE', function () {
            expect(isAmbiguousSendError({ code: 'ECONNREFUSED' })).to.equal(false);
            expect(isAmbiguousSendError({ code: 'ENOTFOUND' })).to.equal(false);
        });
        it('treats a timeout / 5xx / mid-flight reset as AMBIGUOUS', function () {
            expect(isAmbiguousSendError({ code: 'ETIMEDOUT' })).to.equal(true);
            expect(isAmbiguousSendError({ response: { status: 502 } })).to.equal(true);
            expect(isAmbiguousSendError(new Error('socket hang up'))).to.equal(true);
        });
        it('handles a null error', function () {
            expect(isAmbiguousSendError(null)).to.equal(false);
        });
    });

    describe('AtMostOnce', function () {
        it('records and reports keys, and clears', function () {
            const a = new AtMostOnce();
            expect(a.has('r1')).to.equal(false);
            a.mark('r1');
            expect(a.has('r1')).to.equal(true);
            expect(a.size).to.equal(1);
            a.clear();
            expect(a.has('r1')).to.equal(false);
            expect(a.size).to.equal(0);
        });
        it('coerces keys to strings so numeric and string ids match', function () {
            const a = new AtMostOnce();
            a.mark(42);
            expect(a.has('42')).to.equal(true);
            expect(a.has(42)).to.equal(true);
        });
    });

    describe('broadcastOnce', function () {

        afterEach(function () { SpendGuard.unregister('BO'); });

        it('skips a key already broadcast this process lifetime (no double spend)', async function () {
            const tracker = new AtMostOnce().mark('r1');
            let sent = 0;
            let r = await broadcastOnce({ key: 'r1', tracker, send: async () => { sent++; return { txid: 'x' }; } });
            expect(r.skipped).to.equal(true);
            expect(r.duplicate).to.equal(true);
            expect(sent).to.equal(0);
        });

        it('skips when the SpendGuard blocks (paused), moving no money', async function () {
            const guard = new SpendGuard('BO', {});
            guard.pause('incident');
            let sent = 0;
            let r = await broadcastOnce({ key: 'r1', guard, send: async () => { sent++; return { txid: 'x' }; } });
            expect(r.skipped).to.equal(true);
            expect(r.reason).to.match(/PAUSED/);
            expect(sent).to.equal(0);
        });

        it('sends, then marks the key AND records the spend on success', async function () {
            const guard   = new SpendGuard('BO', {});
            const tracker = new AtMostOnce();
            let r = await broadcastOnce({ key: 'r1', tracker, guard, cost: 250, send: async () => ({ txid: 'abc' }) });
            expect(r.txid).to.equal('abc');
            expect(tracker.has('r1')).to.equal(true);
            expect(guard.spentInWindow()).to.equal(250);
        });

        it('tags an ambiguous send error and does NOT mark the key or record spend', async function () {
            const guard   = new SpendGuard('BO', {});
            const tracker = new AtMostOnce();
            let err;
            try {
                await broadcastOnce({
                    key: 'r1', tracker, guard, ambiguousTag: 'anchorAmbiguousSend',
                    send: async () => { let e = new Error('socket hang up'); throw e; }
                });
            } catch (e){ err = e; }
            expect(err).to.be.an('error');
            expect(err.anchorAmbiguousSend).to.equal(true);
            expect(tracker.has('r1')).to.equal(false);   // not marked => a later existence-checked replay may proceed
            expect(guard.spentInWindow()).to.equal(0);   // no budget consumed by a failed send
        });

        it('does NOT tag a definitive send error', async function () {
            const guard = new SpendGuard('BO', {});
            let err;
            try {
                await broadcastOnce({
                    key: 'r1', guard, ambiguousTag: 'anchorAmbiguousSend',
                    send: async () => { throw new Error('Encoder RPC error: bad tx'); }
                });
            } catch (e){ err = e; }
            expect(err.anchorAmbiguousSend).to.equal(undefined);
        });
    });
});
