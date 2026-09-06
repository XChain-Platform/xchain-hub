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

describe('idempotent-broadcast helper', function () {

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

        // The 'Encoder RPC error' prefix does NOT prove a definitive rejection for
        // broadcast_tx. When the encoder's own call to the coin node fails at the
        // transport layer (ECONNRESET / ETIMEDOUT / a 5xx from the node), errorSanitize
        // replaces the reason with the generic 'Transaction broadcast failed' - stripping
        // err.code and err.response so the internal host:port cannot leak - and the
        // encoder returns it in a normal JSON-RPC error body over HTTP 200. That is
        // exactly the case where the tx MAY ALREADY have reached the node, and it used to
        // be classified retry-safe alongside 'bad-txns-inputs-missingorspent'.
        it('treats the encoder transport-failure fallback as AMBIGUOUS despite the RPC-error envelope', function () {
            expect(isAmbiguousSendError(new Error('Encoder RPC error: Transaction broadcast failed'))).to.equal(true);
        });
        it('still treats a named node rejection in the same envelope as DEFINITIVE', function () {
            expect(isAmbiguousSendError(new Error('Encoder RPC error: bad-txns-inputs-missingorspent'))).to.equal(false);
            expect(isAmbiguousSendError(new Error('Encoder RPC error: min relay fee not met'))).to.equal(false);
            expect(isAmbiguousSendError(new Error('Encoder RPC error: Missing required parameter: tx_hex'))).to.equal(false);
        });
        it('keeps a sub-500 HTTP refusal DEFINITIVE even when it carries that message', function () {
            // A 4xx body proves the encoder refused the call before the node ever saw it,
            // so there is nothing ambiguous to defer for.
            expect(isAmbiguousSendError(Object.assign(
                new Error('Encoder RPC error: Transaction broadcast failed'),
                { response: { status: 400 } }))).to.equal(false);
        });
        it('leaves the prefix-less classification untouched', function () {
            expect(isAmbiguousSendError(new Error('Transaction broadcast failed'))).to.equal(true);
            expect(isAmbiguousSendError(Object.assign(
                new Error('Transaction broadcast failed'), { code: 'ECONNREFUSED' }))).to.equal(false);
        });

        // A multi-phase HUB_SIGNER_MODULE broadcasts its funding tx first and can then be
        // rejected DEFINITIVELY on the reveal. Every rule above would call that safe to
        // retry, and the retry re-enters the hook, funds fresh UTXOs and pays twice. The
        // hook tags the error; the tag outranks every other rule.
        it('treats a post-funding failure as AMBIGUOUS whatever shape the rejection has', function () {
            expect(isAmbiguousSendError(Object.assign(
                new Error('Encoder RPC error: bad-txns-inputs-missingorspent'),
                { fundsCommitted: true, phase1Txid: 'a'.repeat(64) }))).to.equal(true);
            expect(isAmbiguousSendError(Object.assign(
                new Error('Encoder RPC error: no UTXOs available'),
                { fundsCommitted: true, response: { status: 400 } }))).to.equal(true);
            expect(isAmbiguousSendError(Object.assign(
                new Error('connect ECONNREFUSED'),
                { fundsCommitted: true, code: 'ECONNREFUSED' }))).to.equal(true);
        });
        it('leaves an UNTAGGED definitive rejection retryable, so single-phase rails keep their behaviour', function () {
            expect(isAmbiguousSendError(Object.assign(
                new Error('Encoder RPC error: bad-txns-inputs-missingorspent'),
                { fundsCommitted: false }))).to.equal(false);
            expect(isAmbiguousSendError(
                new Error('Encoder RPC error: bad-txns-inputs-missingorspent'))).to.equal(false);
            expect(isAmbiguousSendError({ code: 'ECONNREFUSED' })).to.equal(false);
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

        // An AMBIGUOUS send may already be on the wire with its fee paid, so the window
        // is CHARGED for it. Releasing would hand the ceiling back an allowance a real
        // spend consumed, and the next caller would spend past the ceiling.
        it('tags an ambiguous send error, does NOT mark the key, and CHARGES the window', async function () {
            const guard   = new SpendGuard('BO', {});
            const tracker = new AtMostOnce();
            let err;
            try {
                await broadcastOnce({
                    key: 'r1', tracker, guard, cost: 250, ambiguousTag: 'anchorAmbiguousSend',
                    send: async () => { let e = new Error('socket hang up'); throw e; }
                });
            } catch (e){ err = e; }
            expect(err).to.be.an('error');
            expect(err.anchorAmbiguousSend).to.equal(true);
            expect(tracker.has('r1')).to.equal(false);   // not marked => a later existence-checked replay may proceed
            expect(guard.spentInWindow()).to.equal(250); // the fee may have been paid: fail closed
        });

        // The send is AWAITED, so a check()/record() composition lets every concurrent
        // caller read the same pre-send budget and all of them spend past the ceiling -
        // the window spend_guard's own contract forbids. The reservation consumes the
        // budget in the same synchronous turn, so only the first caller can pass.
        it('admits exactly ONE of N concurrent awaited sends against a one-send budget', async function () {
            const guard = new SpendGuard('BO', { BO_MAX_SPEND_USD_CENTS_PER_WINDOW: 100 });
            let sent = 0;
            let open;
            const gate = new Promise(resolve => { open = resolve; });
            const calls = [0, 1, 2].map(i => broadcastOnce({
                key: 'r' + i, guard, cost: 100,
                send: async () => { sent++; await gate; return { txid: 'tx' + i }; }
            }));
            open();
            let results = await Promise.all(calls);
            expect(sent).to.equal(1);
            expect(results.filter(r => r.skipped === true).length).to.equal(2);
            expect(guard.spentInWindow()).to.equal(100);
        });

        // Only a DEFINITIVE failure frees budget. 'nope' will not do here: the shared
        // classifier defaults an unrecognised error to ambiguous, so an opaque message
        // now keeps its reservation and this case has to name a rejection the encoder
        // is known to have refused before the node saw it.
        it('hands the reserved budget back when the send fails definitively', async function () {
            const guard = new SpendGuard('BO', { BO_MAX_SPEND_USD_CENTS_PER_WINDOW: 100 });
            try {
                await broadcastOnce({ key: 'r1', guard, cost: 100,
                    send: async () => { throw new Error('Encoder RPC error: bad-txns-inputs-missingorspent'); } });
            } catch (e){ /* expected */ }
            expect(guard.spentInWindow()).to.equal(0);
            // The freed budget is usable again: a leaked reservation would block this.
            let r = await broadcastOnce({ key: 'r2', guard, cost: 100, send: async () => ({ txid: 'ok' }) });
            expect(r.txid).to.equal('ok');
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
