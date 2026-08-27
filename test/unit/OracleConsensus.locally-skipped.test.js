'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep #7 LOCALLY-SKIPPED DIVERGENCE: a hub whose gossip lagged below
// minSubmissions at the block boundary stores the round as 'skipped'. That skip
// must NOT land in `finalized` (which would make _handlePropose drop the
// federation's legitimate PROPOSE and _handlePrepare/_handleCommit refuse to
// buffer, permanently pinning a NULL price_snapshot for a round the rest of the
// federation finalized). It must land in a separate `locallySkipped` set so a
// later PROPOSE still processes and can upgrade the skipped rows to finalized.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');
const { pubkeyForTestSender } = require('../helpers/fixtures');

describe('OracleConsensus: locally-skipped rounds stay reprocessable (#7)', function () {
    let hub, oc, oracleRound;
    const ROUND = 7;

    beforeEach(function () {
        hub = createMockHub();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
    });

    afterEach(function () { sinon.restore(); });

    it('records a local-shortfall skip in locallySkipped, NOT finalized', async function () {
        // No submissions -> finalizeRound stores a skipped round.
        await oc.finalizeRound(ROUND, 100, 1700000000);

        expect(oc.locallySkipped.has(ROUND)).to.be.true;
        expect(oc.finalized.has(ROUND)).to.be.false;
    });

    it('does NOT drop a later PROPOSE for a round it locally skipped', async function () {
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(oc.locallySkipped.has(ROUND)).to.be.true;

        // _handlePropose returns at the `finalized.has(round)` guard (before it ever
        // calls _isKnownSender). Spying on _isKnownSender therefore proves whether the
        // PROPOSE was dropped by that guard or allowed to proceed. Return false so the
        // handler still exits promptly (right after the membership gate) without
        // needing a full snapshot/leader setup.
        let known  = sinon.stub(oc, '_isKnownSender').returns(false);
        let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
        await oc._handlePropose({
            sender: 'ws://validator-2:10001', sig_pubkey: pubkeyForTestSender('ws://validator-2:10001'),
            data: { round: ROUND, prices, digest: oc._digest(ROUND, prices), btcBlockHeight: 100 }
        });

        // Reached the membership gate => the finalized guard did NOT drop the PROPOSE.
        expect(known.called).to.be.true;
    });

    it('a genuinely finalized round IS still dropped at the finalized guard (contrast)', async function () {
        oc._markFinalized(ROUND);

        let known  = sinon.stub(oc, '_isKnownSender').returns(false);
        let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
        await oc._handlePropose({
            sender: 'ws://validator-2:10001', sig_pubkey: pubkeyForTestSender('ws://validator-2:10001'),
            data: { round: ROUND, prices, digest: oc._digest(ROUND, prices), btcBlockHeight: 100 }
        });

        // Dropped at the finalized guard, before the membership gate.
        expect(known.called).to.be.false;
    });

    it('finalizing a locally-skipped round moves it out of locallySkipped into finalized', function () {
        oc._markLocallySkipped(ROUND);
        expect(oc.locallySkipped.has(ROUND)).to.be.true;
        expect(oc._locallySkippedOrder).to.include(ROUND);

        oc._markFinalized(ROUND);

        expect(oc.locallySkipped.has(ROUND)).to.be.false;
        expect(oc._locallySkippedOrder).to.not.include(ROUND);
        expect(oc.finalized.has(ROUND)).to.be.true;
    });

    it('a locally-skipped round that reaches commit quorum upgrades to finalized', async function () {
        // Local shortfall first.
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(oc.locallySkipped.has(ROUND)).to.be.true;

        // The federation's PROPOSE re-created the round and it reached commit quorum;
        // _finalizeCommittedRound persists (ON DUPLICATE KEY UPDATE upgrades the
        // skipped rows) and marks it finalized.
        sinon.stub(oc, '_storeSnapshot').resolves();
        oc.pendingRounds.set(ROUND, {
            prepares:       new Set(['pkA', 'pkB', 'pkC']),
            commits:        new Set(['pkA', 'pkB', 'pkC']),
            signatures:     new Map([['pkA', 'sigA']]),
            prices:         [{ coinPair: 'BTC/USD', price: '100000' }],
            btcBlockHeight: 100,
            btcBlockTime:   1700000000,
            finalized:      true
        });

        await oc._finalizeCommittedRound(ROUND);

        expect(oc.locallySkipped.has(ROUND)).to.be.false;
        expect(oc.finalized.has(ROUND)).to.be.true;
    });

    it('_markLocallySkipped is a no-op once the round is already finalized', function () {
        oc._markFinalized(ROUND);
        oc._markLocallySkipped(ROUND);
        expect(oc.locallySkipped.has(ROUND)).to.be.false;
        expect(oc.finalized.has(ROUND)).to.be.true;
    });

    // item 4942: OracleRound's consecutiveSkippedRounds gauge subscribes to this
    // event, so it must fire exactly once per round that becomes a durable
    // non-finalized record - the same round set _hydrateFreshnessCounters counts
    // back from price_snapshots after a restart.
    it('emits round:skipped exactly once per round, and never for a finalized one', function () {
        let seen = [];
        oc.on('round:skipped', e => seen.push(e && e.round));

        oc._markLocallySkipped(ROUND);
        oc._markLocallySkipped(ROUND);
        expect(seen).to.deep.equal([ROUND]);

        oc._markFinalized(ROUND + 1);
        oc._markLocallySkipped(ROUND + 1);
        expect(seen).to.deep.equal([ROUND]);
    });
});
