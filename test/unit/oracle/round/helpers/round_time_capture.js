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

const sinon             = require('sinon');
const proxyquire        = require('proxyquire');
const { createMockHub } = require('../../../../helpers/mockHub');
const { waitUntil }     = require('../../../../helpers/waitUntil');

function makeRoundTimeCapture({ network, quorum, height, blockTime, fallbackActive }) {
    const OracleRound = proxyquire('../../../../../src/oracle/round', {
        './price_fetcher': function () {
            return { fetchPrices: sinon.stub().resolves([]) };
        }
    });
    const hub = createMockHub({
        network,
        p2pConfig: {
            ORACLE_ROUND_INTERVAL:    '60000',
            ORACLE_SUBMISSION_WINDOW: '10'
        }
    });
    const round = new OracleRound(hub);
    const consensus = {
        finalizeRound:     sinon.stub().resolves(),
        storeSkippedRound: sinon.stub().resolves(),
        getQuorum:         () => quorum
    };

    round.currentBtcBlockHeight         = height;
    round.currentBtcBlockTime           = blockTime;
    round.chainTipFallbackActive        = fallbackActive;
    round.lastSuccessfulChainTipFetchAt = Date.now();
    round.submissionWindow               = 10;
    round.oracleConsensus                = consensus;

    async function finalize(roundNo) {
        const finalizedBefore = consensus.finalizeRound.callCount;
        const skippedBefore = consensus.storeSkippedRound.callCount;
        round.scheduleFinalization(roundNo);
        await waitUntil(() => consensus.finalizeRound.callCount > finalizedBefore ||
            consensus.storeSkippedRound.callCount > skippedBefore,
        { label: 'the captured round finalization' });
        if (consensus.finalizeRound.callCount > finalizedBefore) {
            return { kind: 'finalized', args: consensus.finalizeRound.getCall(finalizedBefore).args };
        }
        return { kind: 'skipped', args: consensus.storeSkippedRound.getCall(skippedBefore).args };
    }

    async function stopInFlight(roundNos) {
        const skippedBefore = consensus.storeSkippedRound.callCount;
        round.submissionWindow = 60000;
        for (const roundNo of roundNos) round.scheduleFinalization(roundNo);
        await round.stop();
        return consensus.storeSkippedRound.getCalls().slice(skippedBefore).map(call => call.args);
    }

    function restore() {
        for (const timer of round.finalizationTimers.values()) clearTimeout(timer);
        round.finalizationTimers.clear();
        sinon.restore();
    }

    return { round, consensus, finalize, stopInFlight, restore };
}

module.exports = { makeRoundTimeCapture };
