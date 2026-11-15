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
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const CrossChainCallEngine = require('../../../../src/cross_chain/call_engine');

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function row() {
    return {
        round_id: 'round-1', call_id: 'call-1', phase: 'dispatch', snapshot_block: 10,
        network: 'regtest', source_chain: 'BTC', source_action_index: 41,
        source_contract_index: 5, target_chain: 'DOGE', target_contract_index: 9,
        method: 'run', params_json: '[]', gas_limit: 100, cross_hops: 1,
        effective_time: 1700000000, push_generation: 3,
        result_status: null, return_payload_b64: null
    };
}

function makeEngine() {
    const stored = [];
    const db = {
        async setCrossChainCallFinalized(value) {
            stored.push({ ...value, status: 'finalized' });
        },
        async findFinalizedCrossChainCallsInRetractionRange(chain, bounds) {
            return stored.filter(value => value.status === 'finalized' && value.source_chain === chain &&
                value.source_action_index >= bounds.from && (!bounds.bounded || value.source_action_index <= bounds.to) &&
                (!bounds.fenced || value.push_generation <= bounds.gen));
        },
        async updateCrossChainCallsRetractedInRange(chain, bounds) {
            const matches = await this.findFinalizedCrossChainCallsInRetractionRange(chain, bounds);
            for (const value of matches) value.status = 'retracted';
        }
    };
    const engine = Object.create(CrossChainCallEngine.prototype);
    engine.db = db;
    engine.broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() };
    engine.consensus = { forgetFinalized: sinon.stub() };
    engine._resultBackoff = new Map();
    engine._inflight = new Set(['round-1']);
    engine.persistCapabilitySnapshot = sinon.stub().resolves(1);
    engine.resolveBtcChainId = sinon.stub().resolves(null);
    engine.mirrorCallRow = sinon.stub().resolves();
    engine.emit = sinon.stub();
    engine.initRoundTracking();
    engine._inflight.add('round-1');
    return { engine, db, stored };
}

describe('CrossChainCallEngine insert-window retraction fence', function () {
    afterEach(function () { sinon.restore(); });

    it('waits for a covered insert, retracts it, and suppresses its mirror and event', async function () {
        const { engine, db, stored } = makeEngine();
        const entered = deferred();
        const release = deferred();
        const realInsert = db.setCrossChainCallFinalized.bind(db);
        sinon.stub(db, 'setCrossChainCallFinalized').callsFake(async value => {
            entered.resolve();
            await release.promise;
            return realInsert(value);
        });
        const select = sinon.spy(db, 'findFinalizedCrossChainCallsInRetractionRange');

        const writing = engine.writeFinalizedRow({ row: row(), signatures: [] });
        await entered.promise;
        const retracting = engine.retractCallsForReorg('BTC', 40);
        await new Promise(resolve => setImmediate(resolve));
        expect(select.called).to.equal(false);

        release.resolve();
        await Promise.all([writing, retracting]);
        expect(stored).to.have.length(1);
        expect(stored[0].status).to.equal('retracted');
        expect(engine.mirrorCallRow.called).to.equal(false);
        expect(engine.emit.calledWith('call:dispatch')).to.equal(false);
        expect(engine.broadcaster.broadcastDeletion.calledOnce).to.equal(true);
        expect(engine.consensus.forgetFinalized.calledWith('round-1')).to.equal(true);
        expect(engine._inflight.has('round-1')).to.equal(false);
        expect(engine._retractionFence).to.deep.equal([]);
    });

    it('does not wait on or suppress a write outside the retraction range', async function () {
        const { engine, db, stored } = makeEngine();
        const entered = deferred();
        const release = deferred();
        const realInsert = db.setCrossChainCallFinalized.bind(db);
        sinon.stub(db, 'setCrossChainCallFinalized').callsFake(async value => {
            entered.resolve();
            await release.promise;
            return realInsert(value);
        });
        const select = sinon.spy(db, 'findFinalizedCrossChainCallsInRetractionRange');

        const writing = engine.writeFinalizedRow({ row: row(), signatures: [] });
        await entered.promise;
        await engine.retractCallsForReorg('BTC', 100);
        expect(select.calledOnce).to.equal(true);
        release.resolve();
        await writing;

        expect(stored).to.have.length(1);
        expect(stored[0].status).to.equal('finalized');
        expect(engine.mirrorCallRow.calledOnce).to.equal(true);
        expect(engine.emit.calledWith('call:dispatch')).to.equal(true);
    });
});
