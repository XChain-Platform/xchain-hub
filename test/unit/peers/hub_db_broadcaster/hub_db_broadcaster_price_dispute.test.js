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
//
// offrail-mirror lane (2026-10-14): a reorg rollback disputes price_snapshots rows in
// place (updatePriceSnapshotByBlockTimestamp) and emitted nothing, so every running
// indexer mirror kept the round finalized while a fresh or restarted one dropped it.
// The rollback now re-reads the disputed rows and emits them on the mirror channel,
// the re-read-and-emit shape stampBatchLanding uses, and the broadcaster lets a
// disputed row through the late-finalization refusal it has nothing to do with.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const EventEmitter = require('events');

const ReorgHandler = require('../../../../src/anchor/reorg_handler');
const HubGovernance = require('../../../../src/hub/governance.js');
const { createMockHub } = require('../../../helpers/mockHub');
const HubDbBroadcaster = proxyquire('../../../../src/peers/hub_db_broadcaster.js', { ws: { OPEN: 1 } });

function socket() {
    return { readyState: 1, bufferedAmount: 0, _hubBuffered: 0, send: sinon.stub(), close: sinon.stub(), on: sinon.stub() };
}

function disputedRow(round) {
    return { id: 10 + round, round_number: round, coin_pair: 'DOGE/USD', price: '0.' + round, reference_block: 100 + round,
             block_timestamp: 1700000000 + round, status: 'disputed', source_chain: 'DOGE',
             source_action_index: 500 + round, push_generation: 0, admit_block_btc: 1003 };
}

describe('price dispute reaches the hub mirror channel @regression', function () {

    afterEach(function () { sinon.restore(); });

    it('executeRollback emits every disputed row inside the bound as a row:inserted event', async function () {
        const hub = createMockHub();
        const rows = [disputedRow(3), disputedRow(4)];
        hub.db.doQuery.callsFake(async (sql) =>
            (/SELECT \* FROM price_snapshots WHERE status = 'disputed'/.test(sql)) ? rows : []);
        const rh = new ReorgHandler(hub);
        const seen = [];
        rh.on('row:inserted', (event) => seen.push(event));

        const tsMs = Date.now() - 60000;
        await rh.executeRollback('BTC', 800000, tsMs, 'reorg-d', 3, '[]');

        const read = hub.db.doQuery.getCalls().find(c => /status = 'disputed' AND block_timestamp > \? \/ 1000/.test(c.args[0]));
        expect(read, 'the rollback re-reads the rows it disputed').to.exist;
        expect(read.args[1]).to.deep.equal([tsMs]);
        expect(seen.map(e => e.table)).to.deep.equal(['price_snapshots', 'price_snapshots']);
        expect(seen.map(e => e.row.round_number)).to.deep.equal([3, 4]);
        expect(seen.every(e => e.row.status === 'disputed')).to.equal(true);
    });

    it('a failed re-read is logged and the rollback still completes', async function () {
        const hub = createMockHub();
        hub.db.doQuery.callsFake(async (sql) => {
            if (/SELECT \* FROM price_snapshots WHERE status = 'disputed'/.test(sql)) throw new Error('db down');
            return [];
        });
        const rh = new ReorgHandler(hub);
        const confirmed = sinon.spy();
        rh.on('reorg:confirmed', confirmed);
        await rh.executeRollback('BTC', 800000, Date.now() - 60000, 'reorg-e', 3, '[]');
        expect(confirmed.calledOnce).to.equal(true);
    });

    it('hub start-up forwards the handler\'s row events to the mirror broadcaster', async function () {
        class FakeHandler extends EventEmitter {
            constructor(hub) { super(); this.hub = hub; }
            setValidatorSet() {}
            async start() {}
        }
        class Host extends HubGovernance {}
        Host.modules = { ReorgHandler: FakeHandler };
        const host = new Host();
        host.peerManager = {};
        host.loadValidatorSet = async () => [];
        host.hubDbBroadcaster = { broadcastRow: sinon.spy() };
        await host.startReorgHandler();
        const event = { table: 'price_snapshots', row: disputedRow(3) };
        host.reorgHandler.emit('row:inserted', event);
        expect(host.hubDbBroadcaster.broadcastRow.calledOnceWithExactly(event)).to.equal(true);
    });
});

describe('the mirror broadcaster passes a price dispute @regression', function () {

    afterEach(function () { sinon.restore(); });

    it('the broadcaster sends a disputed price row past a late-finalization verdict', async function () {
        const broadcaster = new HubDbBroadcaster({});
        const ws = socket();
        await broadcaster.addSubscriber(ws);
        ws.send.resetHistory();
        broadcaster.admissionWatermark = {
            heights: sinon.stub().returns({}),
            isLateFinalization: sinon.stub().returns({ chain: 'BTC', reason: 'round abandoned', watermark: 1100, admitBlock: 1003 })
        };

        broadcaster.broadcastRow({ table: 'price_snapshots', row: disputedRow(3) });
        expect(ws.send.callCount, 'a dispute binds nothing, so nothing refuses it').to.equal(1);
        const frame = JSON.parse(ws.send.firstCall.args[0]);
        expect(frame.type).to.equal('row:inserted');
        expect(frame.row.status).to.equal('disputed');

        // A finalized row at the same height is still a late finalization and still refused.
        ws.send.resetHistory();
        broadcaster.broadcastRow({ table: 'price_snapshots', row: Object.assign(disputedRow(3), { status: 'finalized' }) });
        expect(ws.send.callCount).to.equal(0);
    });
});
