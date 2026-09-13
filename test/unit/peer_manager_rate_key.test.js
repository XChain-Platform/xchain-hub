'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: PeerManager per-peer rate limiting.
//   - Unverified inbound traffic is keyed on the transport-verified remote IP,
//     not the forgeable envelope.sender, so rotating the sender per message
//     cannot mint a fresh bucket each time (anti-spam bypass + unbounded map).
//   - peerMsgCounts is size-bounded so it cannot grow without limit.

const sinon      = require('sinon');
const { expect } = require('chai');
const PeerManager = require('../../src/PeerManager');

function makePm() {
    let config = {
        P2P_VALIDATOR_ADDR: 'ws://self:10001',
        P2P_PORT: 0,
        P2P_HOST: '127.0.0.1',
        SEED_NODES: [],
        REQUIRE_SIGNATURES: true // bad-sig envelopes drop at verify, before _peerAddr is set
    };
    return new PeerManager(config, { doQuery: sinon.stub().resolves([]) });
}

describe('PeerManager rate-limit keying (stress-sweep 2026-07-08)', function () {

    afterEach(function () { sinon.restore(); });

    it('keys pre-verification traffic on the remote IP, not envelope.sender', function () {
        let pm = makePm();
        let ws = { _remoteIp: '203.0.113.9', _peerAddr: null, readyState: 1, close: sinon.stub() };

        // 5 well-formed envelopes, each naming a DIFFERENT forged sender, all with
        // a bad signature (dropped at verify, after the rate check has keyed them).
        for (let i = 0; i < 5; i++) {
            let env = {
                id: 'id-' + i,
                type: 'PBFT_PREPARE',
                sender: 'ws://forged-' + i + ':10001',
                timestamp: Date.now(),
                sig: 'deadbeef',
                sig_pubkey: 'aa'.repeat(32)
            };
            pm._handleInbound(ws, JSON.stringify(env), null);
        }

        // A single bucket keyed on the remote IP, not five sender-keyed buckets.
        expect(pm.peerMsgCounts.size).to.equal(1);
        expect(pm.peerMsgCounts.has('203.0.113.9')).to.equal(true);
        expect(pm.peerMsgCounts.get('203.0.113.9').count).to.equal(5);
    });

    it('_checkMsgRate enforces the ceiling within a window', function () {
        let pm = makePm();
        expect(pm._checkMsgRate('peerA', 3)).to.equal(true);  // 1
        expect(pm._checkMsgRate('peerA', 3)).to.equal(true);  // 2
        expect(pm._checkMsgRate('peerA', 3)).to.equal(true);  // 3
        expect(pm._checkMsgRate('peerA', 3)).to.equal(false); // 4 > 3
    });

    it('_checkMsgRate evicts the oldest bucket at the size cap (bounded growth)', function () {
        let pm = makePm();
        pm.dedupCacheMax = 3;
        pm._checkMsgRate('a', 100);
        pm._checkMsgRate('b', 100);
        pm._checkMsgRate('c', 100);
        pm._checkMsgRate('d', 100); // full -> evict oldest ('a')
        expect(pm.peerMsgCounts.size).to.equal(3);
        expect(pm.peerMsgCounts.has('a')).to.equal(false);
        expect(pm.peerMsgCounts.has('d')).to.equal(true);
    });
});
