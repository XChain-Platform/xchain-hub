'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const HubDbBroadcaster = proxyquire(
    '../../../../src/peers/hub_db_broadcaster.js',
    { ws: { OPEN: 1 } }
);

function socket() {
    return {
        readyState: 1,
        bufferedAmount: 0,
        send: sinon.stub(),
        close: sinon.stub(),
        on: sinon.stub(),
    };
}

function broadcasterConfig() {
    return {
        XDEX_ROUND_MAX_LIFETIME_MS: 1,
        ATTESTATION_ROUND_TIMEOUT_MS: 1,
        ANCHOR_ROUND_TIMEOUT_MS: 1,
        ORACLE_ROUND_INTERVAL: 1,
        ADMISSION_ORACLE_INGEST_WINDOW_MS: 1,
    };
}

let clock;

function restoreTestState() {
    if (clock) clock.restore();
    clock = null;
    sinon.restore();
}

async function advertiseLegacyHubAsCaughtUp() {
    let broadcaster = new HubDbBroadcaster({});
    let ws = socket();
    await broadcaster.addSubscriber(ws);

    expect(JSON.parse(ws.send.firstCall.args[0]).caught_up).to.equal(true);
    broadcaster.stop();
}

async function advertiseRestartedHubAsNotCaughtUp() {
    let broadcaster = new HubDbBroadcaster({});
    broadcaster._admissionTimer = 1;
    broadcaster.attachAdmissionSource({ peerCatchup: { isCaughtUp: () => false } });
    let ws = socket();
    await broadcaster.addSubscriber(ws);

    expect(JSON.parse(ws.send.firstCall.args[0]).caught_up).to.equal(false);
    broadcaster.stop();
}

async function holdWatermarkUntilCatchUp() {
    clock = sinon.useFakeTimers({ now: 10000, toFake: ['Date'] });
    let saved = [];
    let caughtUp = false;
    let db = {
        getAdmissionWatermarkFloor: sinon.stub().resolves({
            cross_chain_matches: { BTC: 50 },
        }),
        saveAdmissionWatermarkFloor: sinon.stub().callsFake(async (network, heights) => {
            saved.push({ network, heights });
            return 1;
        }),
    };
    let hub = {
        network: 'regtest',
        peerCatchup: { isCaughtUp: () => caughtUp },
        resolveAdmissionTips: sinon.stub().resolves({ BTC: 100 }),
    };
    let broadcaster = new HubDbBroadcaster(broadcasterConfig(), db);
    broadcaster._admissionTimer = 1;
    broadcaster.attachAdmissionSource(hub);

    await broadcaster.sampleAdmission();
    clock.tick(2);
    await broadcaster.sampleAdmission();
    expect(broadcaster.admissionHeights().cross_chain_matches.BTC).to.equal(50);
    expect(saved[1].heights.cross_chain_matches.BTC).to.equal(50);
    let ws = socket();
    await broadcaster.addSubscriber(ws);
    let ready = JSON.parse(ws.send.firstCall.args[0]);
    expect(ready.caught_up).to.equal(false);
    expect(ready.heights.cross_chain_matches.BTC).to.equal(50);
    ws.send.resetHistory();
    broadcaster.broadcastWatermark();
    expect(JSON.parse(ws.send.firstCall.args[0]).heights.cross_chain_matches.BTC).to.equal(50);

    caughtUp = true;
    expect(broadcaster.admissionHeights().cross_chain_matches.BTC).to.equal(99);
    ws.send.resetHistory();
    broadcaster.broadcastWatermark();
    expect(JSON.parse(ws.send.firstCall.args[0]).heights.cross_chain_matches.BTC).to.equal(99);
    await broadcaster.sampleAdmission();
    expect(saved[2].heights.cross_chain_matches.BTC).to.equal(99);
    broadcaster.stop();
}

describe('HubDbBroadcaster catch-up readiness', function () {
    afterEach(restoreTestState);
    it('advertises legacy hubs without a catch-up provider as caught up', advertiseLegacyHubAsCaughtUp);
    it('advertises a restarted hub as not caught up', advertiseRestartedHubAsNotCaughtUp);
    it('holds heights at the durable floor until catch-up, then advances them', holdWatermarkUntilCatchUp);
});
