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
const { expect }        = require('chai');
const proxyquire        = require('proxyquire');
const ChainTips         = require('../../../../src/hub/chain_tips');
const { createMockHub } = require('../../../helpers/mockHub');

const PUSHED_HEIGHT = 900000;
const DIRECT_HEIGHT = 900050;

function tipAged(ageHours) {
    return {
        blockHeight: PUSHED_HEIGHT,
        blockTime: Math.floor(Date.now() / 1000) - ageHours * 60 * 60
    };
}

describe('OracleRound stale pushed BTC reference block', function () {
    let hub, round, savedMaxTipAge;

    beforeEach(function () {
        savedMaxTipAge = process.env.MAX_TIP_AGE_S;
        delete process.env.MAX_TIP_AGE_S;
        const OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () {
                return { fetchPrices: sinon.stub().resolves([]) };
            }
        });
        hub = createMockHub({
            p2pConfig: {
                ORACLE_EPOCH_START: Date.now() - 60000,
                ORACLE_ROUND_INTERVAL: '60000',
                ORACLE_SUBMISSION_WINDOW: '30000'
            }
        });
        hub.btcPushedTipFresh = ChainTips.prototype.btcPushedTipFresh;
        hub.resolveFreshPushedBtcTip = ChainTips.prototype.resolveFreshPushedBtcTip;
        hub.resolveBtcLatestBlock.resolves(DIRECT_HEIGHT);
        round = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
        if (savedMaxTipAge === undefined) delete process.env.MAX_TIP_AGE_S;
        else process.env.MAX_TIP_AGE_S = savedMaxTipAge;
    });

    for (const ageHours of [22, 47]) {
        it('rejects a pushed tip from ' + ageHours + ' hours ago and uses the direct height', async function () {
            hub.db.getChainTip.resolves(tipAged(ageHours));

            await round.executeRound();

            expect(round.currentBtcBlockHeight).to.equal(DIRECT_HEIGHT);
            expect(round.anchorTipBlockTime).to.equal(null);
            expect(round.chainTipFallbackActive).to.equal(false);
            expect(hub.resolveBtcLatestBlock.calledOnce).to.equal(true);
        });
    }

    it('keeps a fresh pushed tip as the round reference block', async function () {
        const freshTip = tipAged(0);
        hub.db.getChainTip.resolves(freshTip);

        await round.executeRound();

        expect(round.currentBtcBlockHeight).to.equal(PUSHED_HEIGHT);
        expect(round.anchorTipBlockTime).to.equal(freshTip.blockTime);
        expect(hub.resolveBtcLatestBlock.called).to.equal(false);
    });
});
