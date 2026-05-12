'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const EventEmitter   = require('events');
const SwapTracker    = require('../../src/SwapTracker');
const { createMockHub }     = require('../helpers/mockHub');

describe('SwapTracker', function () {

    let hub, st, crossChainEngine;

    beforeEach(function () {
        hub = createMockHub();
        st  = new SwapTracker(hub);
        crossChainEngine = new EventEmitter();
    });

    afterEach(function () {
        st.stop(crossChainEngine);
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // start() / stop()
    // -----------------------------------------------------------------

    describe('start() / stop()', function () {
        it('subscribes to attestation:finalized events', function () {
            st.start(crossChainEngine);
            expect(crossChainEngine.listenerCount('attestation:finalized')).to.equal(1);
        });

        it('unsubscribes on stop', function () {
            st.start(crossChainEngine);
            st.stop(crossChainEngine);
            expect(crossChainEngine.listenerCount('attestation:finalized')).to.equal(0);
        });

        it('handles null crossChainEngine gracefully', function () {
            expect(() => st.start(null)).to.not.throw();
        });
    });

    // -----------------------------------------------------------------
    // initiateSwap()
    // -----------------------------------------------------------------

    describe('initiateSwap()', function () {
        it('inserts a swap record', async function () {
            await st.initiateSwap('BTC', 42, 'LTC', 100);
            expect(hub.db.doQuery.calledOnce).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('swap_records');
            expect(args[0]).to.include("'initiated'");
            expect(args[1][0]).to.equal('BTC');
            expect(args[1][1]).to.equal(42);
        });

        it('handles null destActionIndex', async function () {
            await st.initiateSwap('BTC', 42, 'LTC', null);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][3]).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // getSwap()
    // -----------------------------------------------------------------

    describe('getSwap()', function () {
        it('returns swap record when found', async function () {
            hub.db.doQuery.resolves([{ source_chain: 'BTC', status: 'initiated' }]);
            let result = await st.getSwap('BTC', 42);
            expect(result.source_chain).to.equal('BTC');
        });

        it('returns null when not found', async function () {
            hub.db.doQuery.resolves([]);
            let result = await st.getSwap('BTC', 999);
            expect(result).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // getSwaps()
    // -----------------------------------------------------------------

    describe('getSwaps()', function () {
        it('filters by status', async function () {
            hub.db.doQuery.resolves([]);
            await st.getSwaps('initiated', 10);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include("status = ?");
            expect(args[1][0]).to.equal('initiated');
        });

        it('no filter when status is null', async function () {
            hub.db.doQuery.resolves([]);
            await st.getSwaps(null, 5);
            expect(hub.db.doQuery.getCall(0).args[0]).to.not.include("status = ?");
        });
    });

    // -----------------------------------------------------------------
    // _onAttestationFinalized()
    // -----------------------------------------------------------------

    describe('_onAttestationFinalized()', function () {

        it('updates matching initiated swap to attested', async function () {
            // First call: getSwap returns initiated swap
            hub.db.doQuery.onFirstCall().resolves([{
                source_chain: 'BTC', source_action_index: 42, status: 'initiated'
            }]);
            // Second call: updateSwapStatus
            hub.db.doQuery.onSecondCall().resolves();

            await st._onAttestationFinalized({
                sourceChain: 'BTC',
                sourceActionIndex: 42,
                attestationId: 'BTC:42:LTC'
            });

            expect(hub.db.doQuery.callCount).to.equal(2);
            let updateArgs = hub.db.doQuery.getCall(1).args;
            expect(updateArgs[0]).to.include("status = ?");
            expect(updateArgs[1][0]).to.equal('attested');
        });

        it('does nothing when no matching swap', async function () {
            hub.db.doQuery.resolves([]); // no swap found
            await st._onAttestationFinalized({
                sourceChain: 'BTC', sourceActionIndex: 42
            });
            expect(hub.db.doQuery.callCount).to.equal(1); // only the getSwap query
        });

        it('does nothing when swap is already attested', async function () {
            hub.db.doQuery.resolves([{
                source_chain: 'BTC', source_action_index: 42, status: 'attested'
            }]);

            await st._onAttestationFinalized({
                sourceChain: 'BTC', sourceActionIndex: 42
            });

            expect(hub.db.doQuery.callCount).to.equal(1); // no update
        });

        it('handles null attestation gracefully', async function () {
            await st._onAttestationFinalized(null);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('handles attestation with missing fields', async function () {
            await st._onAttestationFinalized({ sourceChain: null, sourceActionIndex: null });
            expect(hub.db.doQuery.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Event-driven auto-progress
    // -----------------------------------------------------------------

    describe('event-driven auto-progress', function () {
        it('attestation:finalized event triggers swap status update', async function () {
            st.start(crossChainEngine);

            hub.db.doQuery.onFirstCall().resolves([{
                source_chain: 'BTC', source_action_index: 1, status: 'initiated'
            }]);
            hub.db.doQuery.onSecondCall().resolves();

            crossChainEngine.emit('attestation:finalized', {
                sourceChain: 'BTC', sourceActionIndex: 1, attestationId: 'BTC:1:LTC'
            });

            await new Promise(r => setTimeout(r, 20));
            expect(hub.db.doQuery.callCount).to.equal(2);
        });
    });
});
