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

const sinon              = require('sinon');
const { expect }         = require('chai');
const EventEmitter       = require('events');
const SwapTracker        = require('../../src/cross_chain/swap_tracker');
const { createMockHub }  = require('../helpers/mockHub');
const { waitUntil }      = require('../helpers/waitUntil');

// =================================================================
// SwapTracker
// =================================================================

function registerSuitePart1() {
    describe('SwapTracker', function () {
    registerNestedSuite1Part1();
    registerNestedSuite1Part2();
    registerNestedSuite1Part3();
    registerNestedSuite1Part4();
    registerNestedSuite1Part5();
    registerNestedSuite1Part6();

    });
}

describe('Regression: CrossChain & SwapTracker', function () {
    registerSuitePart1();

});
      let hub, st, crossChainEngine;
      function registerNestedSuite1Part1() {
    beforeEach(function () {
            hub = createMockHub();
            st  = new SwapTracker(hub);
            crossChainEngine = new EventEmitter();
        });
}
      function registerNestedSuite1Part2() {
    afterEach(function () {
            st.stop(crossChainEngine);
            sinon.restore();
        });
}
      // REG-XCH-007
    function registerNestedSuite1Part3() {
    describe('REG-XCH-007: SwapTracker auto-progresses on attestation', function () {
            it('attestation:finalized updates initiated swap to attested @regression-p0', async function () {
                hub.db.doQuery.onFirstCall().resolves([{
                    source_chain: 'BTC', source_action_index: 42, status: 'initiated'
                }]);
                hub.db.doQuery.onSecondCall().resolves();

                await st.onAttestationFinalized({
                    sourceChain: 'BTC',
                    sourceActionIndex: 42,
                    attestationId: 'BTC:42:LTC'
                });

                expect(hub.db.doQuery.callCount).to.equal(2);
                let updateArgs = hub.db.doQuery.getCall(1).args;
                expect(updateArgs[0]).to.include("status = ?");
                expect(updateArgs[1][0]).to.equal('attested');
            });

            it('does nothing when no matching swap @regression-p0', async function () {
                hub.db.doQuery.resolves([]);
                await st.onAttestationFinalized({ sourceChain: 'BTC', sourceActionIndex: 42 });
                expect(hub.db.doQuery.callCount).to.equal(1);
            });

            it('does nothing when swap already attested @regression-p0', async function () {
                hub.db.doQuery.resolves([{
                    source_chain: 'BTC', source_action_index: 42, status: 'attested'
                }]);
                await st.onAttestationFinalized({ sourceChain: 'BTC', sourceActionIndex: 42 });
                expect(hub.db.doQuery.callCount).to.equal(1);
            });
        });
}
      // REG-XCH-008
    function registerNestedSuite1Part4() {
    describe('REG-XCH-008: Swap lifecycle', function () {
            it('initiateSwap inserts record @regression-p1', async function () {
                await st.initiateSwap('BTC', 42, 'LTC', 100);
                expect(hub.db.doQuery.calledOnce).to.be.true;
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[0]).to.include('swap_records');
                expect(args[0]).to.include("'initiated'");
            });

            it('getSwap returns record @regression-p1', async function () {
                hub.db.doQuery.resolves([{ source_chain: 'BTC', status: 'initiated' }]);
                let result = await st.getSwap('BTC', 42);
                expect(result.source_chain).to.equal('BTC');
            });

            it('getSwap returns null when not found @regression-p1', async function () {
                hub.db.doQuery.resolves([]);
                let result = await st.getSwap('BTC', 999);
                expect(result).to.be.null;
            });
        });
}
      // Event-driven integration
    function registerNestedSuite1Part5() {
    describe('Event-driven auto-progress', function () {
            it('attestation:finalized event triggers swap update @regression-p1', async function () {
                st.start(crossChainEngine);

                hub.db.doQuery.onFirstCall().resolves([{
                    source_chain: 'BTC', source_action_index: 1, status: 'initiated'
                }]);
                hub.db.doQuery.onSecondCall().resolves();

                crossChainEngine.emit('attestation:finalized', {
                    sourceChain: 'BTC', sourceActionIndex: 1, attestationId: 'BTC:1:LTC'
                });

                await waitUntil(() => hub.db.doQuery.callCount === 2, { label: 'the finalized attestation to drive the swap update' });
                expect(hub.db.doQuery.callCount).to.equal(2);
            });
        });
}
      // Null safety
    function registerNestedSuite1Part6() {
    describe('Null safety', function () {
            it('handles null attestation gracefully @regression-p2', async function () {
                await st.onAttestationFinalized(null);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('handles missing fields gracefully @regression-p2', async function () {
                await st.onAttestationFinalized({ sourceChain: null, sourceActionIndex: null });
                expect(hub.db.doQuery.called).to.be.false;
            });
        });
}
