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

const { expect } = require('chai');
const sinon = require('sinon');
const { positiveIntConfig } = require('../../src/lib/config_int.js');
const AttestationConsensus = require('../../src/AttestationConsensus.js');
const CrossChainDexConsensus = require('../../src/CrossChainDexConsensus.js');
const PeerManager = require('../../src/PeerManager.js');
const { createMockHub } = require('../helpers/mockHub');

// `parseInt(cfg) || DEFAULT` accepted a negative cap, and a negative
// ring cap makes `length > max` true for the entry just inserted, so the
// duplicate-suppression set stays permanently empty.
describe('positiveIntConfig', function () {

    let warn;
    beforeEach(function () { warn = sinon.stub(console, 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('keeps a strictly-positive operator value', function () {
        expect(positiveIntConfig('250', 10000, 'X')).to.equal(250);
        expect(positiveIntConfig(250, 10000, 'X')).to.equal(250);
    });

    it('falls back to the default on a negative value (the reported hole)', function () {
        expect(positiveIntConfig('-1', 10000, 'X')).to.equal(10000);
        expect(warn.calledOnce).to.be.true;
    });

    it('falls back on zero, NaN, and absent values', function () {
        expect(positiveIntConfig('0', 10000, 'X')).to.equal(10000);
        expect(positiveIntConfig('nonsense', 10000, 'X')).to.equal(10000);
        expect(positiveIntConfig(undefined, 10000, 'X')).to.equal(10000);
        expect(positiveIntConfig('', 10000, 'X')).to.equal(10000);
    });

    it('falls back to the default rather than clamping to 1', function () {
        // A ring capped at 1 suppresses nothing beyond the previous entry, so
        // Math.max(1, value) would be as broken as the negative it replaced.
        expect(positiveIntConfig('-9999', 40000, 'X')).to.equal(40000);
    });
});

describe('ring caps reject a negative operator value', function () {

    afterEach(function () { sinon.restore(); });

    it('AttestationConsensus finalized + non-ok rings hold their defaults', function () {
        sinon.stub(console, 'warn');
        let hub = createMockHub();
        hub.p2pConfig = { ATTESTATION_FINALIZED_MAX: '-1', ATTESTATION_NONOK_PUBLISHED_MAX: '-1' };
        let ac = new AttestationConsensus(hub, { getProvider: () => null });
        expect(ac.finalizedMax).to.equal(10000);
        expect(ac.nonOkPublishedMax).to.equal(40000);

        // The eviction the negative cap used to defeat: a just-added id survives.
        ac._markFinalized('req-1');
        expect(ac.finalized.has('req-1')).to.be.true;
    });

    it('CrossChainDexConsensus finalized ring holds its default', function () {
        sinon.stub(console, 'warn');
        let hub = createMockHub();
        hub.p2pConfig = { XDEX_FINALIZED_MAX: '-1' };
        let dex = new CrossChainDexConsensus({ hub, peerManager: hub.getPeerManager(), identity: null });
        expect(dex.finalizedMax).to.equal(10000);
    });

    // Two rings the first pass missed and the verify stage named: the torn-down
    // guard a hundred lines below the edited reads, and the P2P gossip dedup cache.
    it('AttestationConsensus torn-down ring holds its default', function () {
        sinon.stub(console, 'warn');
        let hub = createMockHub();
        hub.p2pConfig = { ATTESTATION_TORNDOWN_MAX: '-1' };
        let ac = new AttestationConsensus(hub, { getProvider: () => null });
        expect(ac.tornDownMax).to.equal(10000);

        // A negative cap evicted the rid just marked, so _bufferEarlyMessage
        // parked the prior-attempt envelopes the mark exists to drop.
        ac._markTornDown('rid-1');
        expect(ac.tornDown.has('rid-1')).to.be.true;
    });

    it('PeerManager gossip dedup cache holds its default', function () {
        sinon.stub(console, 'warn');
        let pm = new PeerManager({ P2P_DEDUP_CACHE_MAX: '-1', REQUIRE_SIGNATURES: false }, null);
        expect(pm.dedupCacheMax).to.equal(100000);

        // The eviction a negative cap defeated: two distinct ids both stay seen,
        // so a re-broadcast of either is still suppressed.
        pm._addToDedup('msg-1');
        pm._addToDedup('msg-2');
        expect(pm.seenIds.has('msg-1')).to.be.true;
        expect(pm.seenIds.has('msg-2')).to.be.true;
    });
});
