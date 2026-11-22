'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// currentBtcNetwork is the network of the last successful per-round resolve. A resolve that
// throws leaves it as it was, so the derived-pair gate keeps the answer its peers still hold.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMockHub } = require('../../../../helpers/mockHub');

describe('OracleRound: the remembered BTC network across a failed resolve', function () {
    let hub, or;

    beforeEach(function () {
        const OracleRound = proxyquire('../../../../../src/oracle/round', {
            './price_fetcher': function () {
                return { fetchPrices: sinon.stub().resolves([{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }]) };
            }
        });
        hub = createMockHub({ p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' } });
        or = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('stays unset when the very first resolve throws', async function () {
        hub.resolveBtcNetwork.rejects(new Error('no network'));
        await or.executeRound();
        expect(or.currentBtcNetwork).to.equal(undefined);
    });

    it('keeps the last resolved network when a later resolve throws', async function () {
        hub.resolveBtcNetwork.resolves('testnet');
        await or.executeRound();
        expect(or.currentBtcNetwork).to.equal('testnet');

        hub.resolveBtcNetwork.rejects(new Error('no network'));
        // The round number is wall-clock derived, so step back one to let the next tick run.
        or.lastExecutedRound = or.lastExecutedRound - 1;
        await or.executeRound();
        expect(hub.resolveBtcNetwork.callCount, 'the second round resolved again').to.equal(2);
        expect(or.currentBtcNetwork).to.equal('testnet');
    });
});
