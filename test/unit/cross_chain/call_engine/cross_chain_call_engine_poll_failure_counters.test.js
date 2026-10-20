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
 **********************************************************************
 * CrossChainCallEngine: indexer read failures on both relay legs are counted
 * and logged, never read as an empty source or a result that is not ready.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const CrossChainCallEngine = require('../../../../src/cross_chain/call_engine');
const { getLogger } = require('../../../../src/observability');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const CALL_ID = 'a'.repeat(64);

function makeEngine() {
    const db = { ...DB_METHODS, async doQuery() { return []; } };
    const hub = {
        db,
        p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge', LTC_INDEXER_URL: 'http://ltc' },
        hubDbBroadcaster: { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() },
        getPeerManager: () => null,
        getIdentity: () => null,
        resolveBtcLatestBlock: async () => 150
    };
    const engine = new CrossChainCallEngine(hub);
    engine.consensus = { propose: sinon.stub().resolves(), start: sinon.stub(), stop: sinon.stub(), on: () => {},
                         forgetFinalized: sinon.stub() };
    db.findCrossChainCallDispatchesAwaitingResult = async () => [{
        id: 1, call_id: CALL_ID, phase: 'dispatch', status: 'finalized',
        target_chain: 'DOGE', source_chain: 'BTC', source_action_index: 1
    }];
    db.findCrossChainCallsByPhase = async () => [];
    return engine;
}

function warnLines() {
    return getLogger().warn.getCalls().map(c => String(c.args[0]));
}

function registerDispatchPollTests() {
    it('counts a thrown source-indexer read and warns once per run of failures', async function () {
        const engine = makeEngine();
        sinon.stub(engine, 'indexerCall').rejects(new Error('connect ECONNREFUSED'));
        const dispatch = sinon.spy(engine, 'maybeDispatch');
        await engine.pollSourceRequests('BTC');
        await engine.pollSourceRequests('BTC');
        expect(dispatch.called).to.equal(false);
        expect((await engine.getStats()).dispatch_poll_failures).to.equal(2);
        const lines = warnLines().filter(l => l.includes('dispatch poll on BTC failed'));
        expect(lines).to.have.length(1);
        expect(lines[0]).to.include('connect ECONNREFUSED');
    });
    it('counts an error body or a malformed request list as a failed read', async function () {
        const engine = makeEngine();
        const call = sinon.stub(engine, 'indexerCall');
        call.onFirstCall().resolves({ error: 'failed to look up pending cross-chain calls' });
        call.onSecondCall().resolves({ calls: [], network: 'regtest', latest_block_index: 'x' });
        await engine.pollSourceRequests('BTC');
        await engine.pollSourceRequests('LTC');
        expect(engine._dispatchPollFailures).to.equal(2);
        expect(warnLines().some(l => l.includes('indexer answered: failed to look up'))).to.equal(true);
        expect(warnLines().some(l => l.includes('dispatch poll on LTC failed'))).to.equal(true);
    });
    it('re-arms the first warn after a good read and leaves a good read uncounted', async function () {
        const engine = makeEngine();
        const call = sinon.stub(engine, 'indexerCall');
        call.onCall(0).rejects(new Error('timeout of 15000ms exceeded'));
        call.onCall(1).resolves({ calls: [], network: 'regtest', latest_block_index: 120 });
        call.onCall(2).rejects(new Error('timeout of 15000ms exceeded'));
        for (let i = 0; i < 3; i++) await engine.pollSourceRequests('BTC');
        expect(engine._dispatchPollFailures).to.equal(2);
        expect(warnLines().filter(l => l.includes('dispatch poll on BTC failed'))).to.have.length(2);
    });
}

function registerResultLookupTests() {
    it('counts a thrown target-indexer result lookup in result_attempt_failures and parks it', async function () {
        const engine = makeEngine();
        sinon.stub(engine, 'indexerCall').rejects(new Error('indexer RPC error: {"code":-32603}'));
        await engine.pollTargetResults('DOGE');
        expect((await engine.getStats()).result_attempt_failures).to.equal(1);
        expect(engine._resultBackoff.has(CALL_ID)).to.equal(true);
        expect(warnLines().some(l => l.includes('result attempt failed') && l.includes('-32603'))).to.equal(true);
    });
    it('counts a refused result lookup body as a failure, not as a result that is not ready', async function () {
        const engine = makeEngine();
        sinon.stub(engine, 'indexerCall').resolves({ error: 'indexer database not ready' });
        await engine.pollTargetResults('DOGE');
        expect(engine._resultAttemptFailures).to.equal(1);
        expect(warnLines().some(l => l.includes('indexer database not ready'))).to.equal(true);
    });
    it('leaves a result that does not exist yet uncounted and quietly parked', async function () {
        const engine = makeEngine();
        sinon.stub(engine, 'indexerCall').resolves({ exists: false, latest_block_index: 120 });
        await engine.pollTargetResults('DOGE');
        expect(engine._resultAttemptFailures).to.equal(0);
        expect(engine._resultBackoff.has(CALL_ID)).to.equal(true);
        expect(warnLines().some(l => l.includes('result attempt failed'))).to.equal(false);
    });
}

describe('CrossChainCallEngine: indexer read failures are counted', function () {
    beforeEach(function () {
        sinon.stub(getLogger(), 'warn');
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('dispatch poll (pollSourceRequests)', registerDispatchPollTests);
    describe('result lookup (maybeRelayResult)', registerResultLookupTests);
});
