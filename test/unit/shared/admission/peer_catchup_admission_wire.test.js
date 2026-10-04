'use strict';

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

describe('peer catch-up admission wiring', function () {
    afterEach(function () { sinon.restore(); });

    it('holds the ready frame at the floor until the final mirrored table catches up', async function () {
        let releaseLastTable;
        let reachedLastTable;
        const lastTablePage = new Promise(resolve => { releaseLastTable = resolve; });
        const lastTableStarted = new Promise(resolve => { reachedLastTable = resolve; });
        const fetchPage = sinon.stub().callsFake(async (peer, table) => {
            if (table !== MIRRORED_TABLES[MIRRORED_TABLES.length - 1]) return { table, rows: [] };
            reachedLastTable();
            return lastTablePage;
        });
        const catchup = new HubDbPeerCatchup({
            peerManager: peerManager(),
            getVerifier: () => async () => true,
            fetchPage,
            logger: { warn: sinon.stub(), error: sinon.stub() }
        });
        const running = catchup.start();
        await lastTableStarted;

        const state = catchup.caughtUpState();
        expect(MIRRORED_TABLES.slice(0, -1).every(table => state[table] === true)).to.equal(true);
        expect(state[MIRRORED_TABLES[MIRRORED_TABLES.length - 1]]).to.equal(false);
        expect(catchup.isCaughtUp()).to.equal(false);

        const broadcaster = new HubDbBroadcaster({}, {});
        broadcaster.admissionWatermark = {
            heights: () => ({ cross_chain_matches: { BTC: 99 } })
        };
        broadcaster._admissionHoldFloor = { cross_chain_matches: { BTC: 50 } };
        broadcaster._admissionTimer = 1;
        const hub = { peerCatchup: catchup };
        broadcaster.attachAdmissionSource(hub);

        const waitingSocket = socket();
        await broadcaster.addSubscriber(waitingSocket);
        const waitingReady = JSON.parse(waitingSocket.send.firstCall.args[0]);
        expect(waitingReady.caught_up).to.equal(false);
        expect(waitingReady.heights).to.deep.equal({ cross_chain_matches: { BTC: 50 } });

        releaseLastTable({ table: MIRRORED_TABLES[MIRRORED_TABLES.length - 1], rows: [] });
        await running;
        expect(catchup.isCaughtUp()).to.equal(true);

        const readySocket = socket();
        await broadcaster.addSubscriber(readySocket);
        const ready = JSON.parse(readySocket.send.firstCall.args[0]);
        expect(ready.caught_up).to.equal(true);
        expect(ready.heights).to.deep.equal({ cross_chain_matches: { BTC: 99 } });

        catchup.stop();
        broadcaster.stop();
    });
});
