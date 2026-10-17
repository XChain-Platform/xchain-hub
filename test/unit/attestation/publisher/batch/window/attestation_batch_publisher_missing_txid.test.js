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

// A window wire whose broadcast answers without a txid is latched as an ambiguous failure,
// never recorded as sent with a null head txid.

const { expect } = require('chai');
const AttestationBatchPublisher = require('../../../../../../src/attestation/batch_publisher.js');

// The real broadcastWindow over a publisher whose collaborators only record what happened.
function publisherWith(results) {
    let calls = { sent: [], latched: [], released: 0, committed: 0 };
    let p = Object.create(AttestationBatchPublisher.prototype);
    let i = 0;
    Object.assign(p, {
        broadcastFn: async () => results[i++],
        stats: { windowsDeferred: 0, wiresBroadcast: 0 },
        spendGuard: { commit() { calls.committed++; }, release() { calls.released++; } },
        balanceAllows: async () => true,
        reserveWindowSpend: (w, e) => e.wires.map((_, n) => 't' + n),
        recordIntent: async () => {},
        bufferWindow() {},
        markSent: async (start, txid) => { calls.sent.push(txid); },
        notePublishedWindow() {},
        retryRefusedHead: async () => false,
        latchWireFailure: (w, e, t, n, err, ambiguous) => { calls.latched.push({ wire: n, ambiguous, missing: !!err.missingTxid }); }
    });
    return { p, calls };
}

const WINDOW = { window_start: 100, window_end: 110, row_count: 1 };

describe('AttestationBatchPublisher', function () {
    describe('a window wire that returns no txid', function () {
        it('latches a txid-less head wire as ambiguous and writes no sent marker', async function () {
            let { p, calls } = publisherWith([{}]);
            expect(await p.broadcastWindow(WINDOW, 'k', { wires: ['w0'] })).to.equal(false);
            expect(calls.sent).to.deep.equal([]);
            expect(calls.latched).to.deep.equal([{ wire: 0, ambiguous: true, missing: true }]);
        });

        it('latches a txid-less later wire as ambiguous after the head was sent', async function () {
            let { p, calls } = publisherWith([{ txid: 'aa'.repeat(32) }, { txid: null }]);
            expect(await p.broadcastWindow(WINDOW, 'k', { wires: ['w0', 'w1'] })).to.equal(false);
            expect(calls.sent).to.deep.equal([]);
            expect(calls.latched).to.deep.equal([{ wire: 1, ambiguous: true, missing: true }]);
        });

        it('marks the window sent with the head txid when every wire returns one', async function () {
            let { p, calls } = publisherWith([{ txid: 'aa'.repeat(32) }, 'bb'.repeat(32)]);
            expect(await p.broadcastWindow(WINDOW, 'k', { wires: ['w0', 'w1'] })).to.equal(true);
            expect(calls.sent).to.deep.equal(['aa'.repeat(32)]);
            expect(calls.latched).to.deep.equal([]);
        });
    });
});
