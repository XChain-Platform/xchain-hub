'use strict';
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub_schema_version.js');

const EventEmitter = require('events');
const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const { MIRRORED_TABLES } = require('../../../../src/peers/hub_db/catchup_verifiers.js');

const HubDbBroadcaster = proxyquire(
    '../../../../src/peers/hub_db_broadcaster.js',
    { ws: { OPEN: 1 } }
);

const PEER = 'ws://validator02.example:10002';

function peerManager() {
    const manager = new EventEmitter();
    const pubkey = 'aa'.repeat(32);
    manager.peers = new Map([[PEER, { state: 'open' }]]);
    manager.validatorPubkeys = new Map([[PEER, pubkey]]);
    manager.effectiveSignerSet = new Set([pubkey]);
    return manager;
}

function socket() {
    return {
        readyState: 1,
        bufferedAmount: 0,
        send: sinon.stub(),
        close: sinon.stub(),
        on: sinon.stub()
    };
}

function finalTableGate() {
    let release;
    let reached;
    const table = MIRRORED_TABLES[MIRRORED_TABLES.length - 1];
    const page = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { reached = resolve; });
    const fetchPage = sinon.stub().callsFake(async (peer, requestedTable) => {
        if (requestedTable !== table)
            return { table: requestedTable, schema_version: HUB_SCHEMA_VERSION, rows: [] };
        reached();
        return page;
    });
    return { table, fetchPage, started, release };
}

function gatedCatchup(fetchPage) {
    return new HubDbPeerCatchup({
        peerManager: peerManager(),
        getVerifier: () => async () => true,
        fetchPage,
        logger: { warn: sinon.stub(), error: sinon.stub() }
    });
}

function expectFinalTablePending(catchup) {
    const state = catchup.caughtUpState();
    expect(MIRRORED_TABLES.slice(0, -1).every(table => state[table] === true)).to.equal(true);
    expect(state[MIRRORED_TABLES[MIRRORED_TABLES.length - 1]]).to.equal(false);
    expect(catchup.isCaughtUp()).to.equal(false);
}

function admissionBroadcaster(catchup) {
    const broadcaster = new HubDbBroadcaster({}, {});
    broadcaster.admissionWatermark = {
        heights: () => ({ cross_chain_matches: { BTC: 99 } })
    };
    Object.assign(broadcaster, {
        _admissionHoldFloor: { cross_chain_matches: { BTC: 50 } },
        _admissionTimer: 1
    });
    broadcaster.attachAdmissionSource({ peerCatchup: catchup });
    return broadcaster;
}

async function readyFrame(broadcaster) {
    const subscriber = socket();
    await broadcaster.addSubscriber(subscriber);
    return JSON.parse(subscriber.send.firstCall.args[0]);
}

describe('peer catch-up admission wiring', function () {
    afterEach(function () { sinon.restore(); });

    it('passes the hub deployment network to the production catch-up worker', function () {
        sinon.stub(HubDbPeerCatchup.prototype, 'start').resolves();
        const broadcaster = new HubDbBroadcaster({}, {});
        broadcaster.sampleAdmission = sinon.stub().resolves();
        const hub = { network: 'mainnet', peerManager: peerManager() };
        broadcaster.attachAdmissionSource(hub);
        expect(hub.peerCatchup.network).to.equal('mainnet');
        broadcaster.stop();
    });

    it('holds the ready frame at the floor until the final mirrored table catches up', async function () {
        const gate = finalTableGate();
        const catchup = gatedCatchup(gate.fetchPage);
        const running = catchup.start();
        await gate.started;

        expectFinalTablePending(catchup);

        const broadcaster = admissionBroadcaster(catchup);
        const waitingReady = await readyFrame(broadcaster);
        expect(waitingReady.caught_up).to.equal(false);
        expect(waitingReady.heights).to.deep.equal({ cross_chain_matches: { BTC: 50 } });

        gate.release({ table: gate.table, schema_version: HUB_SCHEMA_VERSION, rows: [] });
        await running;
        expect(catchup.isCaughtUp()).to.equal(true);

        const ready = await readyFrame(broadcaster);
        expect(ready.caught_up).to.equal(true);
        expect(ready.heights).to.deep.equal({ cross_chain_matches: { BTC: 99 } });

        catchup.stop();
        broadcaster.stop();
    });
});
