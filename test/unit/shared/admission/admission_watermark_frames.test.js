'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const HubDbBroadcaster = proxyquire('../../../../src/peers/hub_db_broadcaster.js', { ws: { OPEN: 1 } });
const { AdmissionHeightWatermark } = HubDbBroadcaster;
const { admitMarginBlocks } = require('../../../../src/consensus/gates/mirror_admission_gate.js');

const WINDOWS = {
    XDEX_ROUND_MAX_LIFETIME_MS:           400000,
    ATTESTATION_ROUND_TIMEOUT_MS:         100000,
    ANCHOR_ROUND_TIMEOUT_MS:              100000,
    ORACLE_ROUND_INTERVAL:                200000,
    ADMISSION_ORACLE_INGEST_WINDOW_MS:    200000,
};

function withCleanEnv(fn) {
    const keys = ['XDEX_ROUND_TIMEOUT_MS', 'XDEX_ROUND_MAX_LIFETIME_MS', 'ATTESTATION_ROUND_TIMEOUT_MS',
                  'ANCHOR_ROUND_TIMEOUT_MS', 'ORACLE_ROUND_INTERVAL', 'ADMISSION_ORACLE_INGEST_WINDOW_MS',
                  'HUB_ADMISSION_RELAY'];
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    try { return fn(); }
    finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function makeWatermark(extra) {
    return withCleanEnv(() => new AdmissionHeightWatermark(Object.assign({}, WINDOWS, extra || {})));
}

const T0 = 1_700_000_000_000;

const NOW = T0 + 400000;

function settledWatermark() {
    let w = makeWatermark();
    w.observeTip('BTC', 900000, T0);
    return w;   // cross_chain_matches.BTC == 899999 at T0 + 400000
}

function registerLateFinalizationShapeTests() {
it('reads the unsigned oracle rail from its scalar column and its source_chain', function () {
        let w = settledWatermark();
        let margin = admitMarginBlocks('oracle_prices');
        let row = { source_chain: 'BTC', admit_block: 899999 + margin };
        expect(w.isLateFinalization('oracle_prices', row, NOW)).to.not.equal(null);
        expect(w.isLateFinalization('oracle_prices', { source_chain: 'BTC', admit_block: 900500 }, NOW)).to.equal(null);
        // No source_chain names no chain to be late against.
        expect(w.isLateFinalization('oracle_prices', { admit_block: 1 }, NOW)).to.equal(null);
    });

    it('cannot refuse on a chain it makes no claim for', function () {
        let w = settledWatermark();   // BTC only
        expect(w.isLateFinalization('cross_chain_matches', { admit_block_ltc: 1 }, NOW)).to.equal(null);
    });

    it('refuses a row whose two admission shapes disagree', function () {
        let w = settledWatermark();
        let bad = w.isLateFinalization('cross_chain_matches',
            { admit_block_btc: 900004, admit_blocks: { BTC: 900009 } }, NOW);
        expect(bad).to.not.equal(null);
        expect(bad.reason).to.contain('disagrees');
    });

    it('ignores a table that carries no admission height', function () {
        let w = settledWatermark();
        expect(w.isLateFinalization('capability_snapshots', { admit_block_btc: 1 }, NOW)).to.equal(null);
    });
}

function registerLateFinalizationBoundaryTests() {
it('never touches a LEGACY row, which carries no admission height at all', function () {
        let w = settledWatermark();
        expect(w.isLateFinalization('cross_chain_matches', { effective_time: 1 }, NOW)).to.equal(null);
    });

    it('passes a row stamped at the CURRENT tip', function () {
        let w = settledWatermark();
        let admit = 900000 + admitMarginBlocks('cross_chain_matches');
        expect(w.isLateFinalization('cross_chain_matches', { admit_block_btc: admit }, NOW)).to.equal(null);
    });

    it('refuses a row whose round opened at or below the claimed height', function () {
        let w = settledWatermark();
        let margin = admitMarginBlocks('cross_chain_matches');
        // Opening tip exactly 899999, the claimed height: the watermark already said that
        // round terminated, so this finalization is late.
        let late = w.isLateFinalization('cross_chain_matches', { admit_block_btc: 899999 + margin }, NOW);
        expect(late).to.not.equal(null);
        expect(late.chain).to.equal('BTC');
        expect(late.watermark).to.equal(899999);
        // One block later opened ABOVE the claim and is not late: the boundary, not a region.
        expect(w.isLateFinalization('cross_chain_matches', { admit_block_btc: 900000 + margin }, NOW)).to.equal(null);
    });

    it('uses EACH rail s own margin, so the boundary moves with the rail', function () {
        let w = settledWatermark();
        // attestation_responses takes 1 block, not 4. A row at 899999 + 1 is late there and a
        // row at 899999 + 4 is not, which is the opposite of the match rail.
        expect(w.isLateFinalization('attestation_responses', { admit_block_btc: 900000 }, NOW)).to.not.equal(null);
        expect(w.isLateFinalization('attestation_responses', { admit_block_btc: 900004 }, NOW)).to.equal(null);
    });
}

describe('admission height watermark: the late-finalization refusal', function () {


    registerLateFinalizationBoundaryTests();

    registerLateFinalizationShapeTests();
});

function broadcasterWithSocket() {
    let b  = new HubDbBroadcaster({}, { doQuery: async () => [] });
    let ws = { readyState: 1, bufferedAmount: 0, _hubBuffered: 0,
               send: sinon.stub(), close: sinon.stub(), on: sinon.stub() };
    return { b, ws };
}

function registerAdmissionSourceTest() {
it('attachAdmissionSource samples the hub tips, the anchor queue and the floor', async function () {
        let { b, ws } = broadcasterWithSocket();
        await b.addSubscriber(ws);
        b.admissionWatermark = makeWatermark();
        let saved = null;
        b.db = {
            doQuery: async () => [],
            getAdmissionWatermarkFloor: async () => ({
                cross_chain_calls:          { LTC: 2000 },
                // Deliberately ABOVE the anchor queue floor below, so the assertion proves the
                // sampler wired the cap and that a cap beats a floor.
                anchor_reward_attestations: { BTC: 900000 },
            }),
            saveAdmissionWatermarkFloor: async (net, h) => { saved = { net, h }; return 1; },
        };
        let hub = {
            network: 'regtest',
            resolveAdmissionTips: async (chains) => {
                let out = {};
                for (let c of chains) out[c] = (c === 'BTC') ? 900000 : null;   // only BTC has a fresh tip
                return out;
            },
            stateAnchorPublisher: {
                deferredRewardAttestFloor: () => 899500,
            },
        };
        b.attachAdmissionSource(hub);
        await b.sampleAdmission();

        // The floor came back from storage and is published immediately, before any
        // observation of this process has aged.
        let h = b.admissionHeights(Date.now());
        expect(h.cross_chain_calls.LTC).to.equal(2000);
        // The anchor cap took the queue floor minus one.
        expect(h.anchor_reward_attestations).to.deep.equal({ BTC: 899499 });
        // A chain with no fresh tip is absent, never guessed at zero.
        expect(h.cross_chain_matches || {}).to.not.have.property('DOGE');
        expect(saved.net).to.equal('regtest');
        b.stop();
    });
}

function registerWatermarkBroadcastTests() {
it('broadcastRow REFUSES a late finalization and still serves a fresh row', async function () {
        let { b, ws } = broadcasterWithSocket();
        await b.addSubscriber(ws);
        b.admissionWatermark = makeWatermark();
        b.admissionWatermark.observeTip('BTC', 900000, Date.now() - 500000);
        let err = sinon.stub(console, 'error');
        ws.send.resetHistory();

        let margin = admitMarginBlocks('cross_chain_matches');
        b.broadcastRow({ table: 'cross_chain_matches', row: { id: 1, admit_block_btc: 899999 + margin } });
        expect(ws.send.called, 'a late finalization reached the mirror').to.equal(false);
        expect(err.called).to.equal(true);
        expect(err.firstCall.args[0]).to.contain('REFUSING to broadcast');

        b.broadcastRow({ table: 'cross_chain_matches', row: { id: 2, admit_block_btc: 900000 + margin } });
        expect(ws.send.calledOnce).to.equal(true);
        expect(JSON.parse(ws.send.firstCall.args[0]).row.id).to.equal(2);
        b.stop();
    });

    it('broadcastRow is unchanged for a legacy row and an unrelated table', async function () {
        let { b, ws } = broadcasterWithSocket();
        await b.addSubscriber(ws);
        b.admissionWatermark = makeWatermark();
        b.admissionWatermark.observeTip('BTC', 900000, Date.now() - 500000);
        ws.send.resetHistory();
        b.broadcastRow({ table: 'cross_chain_matches', row: { id: 3, effective_time: 7 } });
        b.broadcastRow({ table: 'capability_snapshots', row: { id: 4 } });
        expect(ws.send.callCount).to.equal(2);
        b.stop();
    });

    registerAdmissionSourceTest();
}

function registerWatermarkFrameTests() {
it('the heartbeat carries ts AND heights, and ts is still the wall clock in seconds', async function () {
        let { b, ws } = broadcasterWithSocket();
        await b.addSubscriber(ws);
        b.admissionWatermark = makeWatermark();
        b.admissionWatermark.observeTip('BTC', 900000, Date.now() - 500000);
        ws.send.resetHistory();
        b.broadcastWatermark();
        let frame = JSON.parse(ws.send.firstCall.args[0]);
        expect(frame.type).to.equal('watermark');
        expect(frame.ts).to.be.closeTo(Math.floor(Date.now() / 1000), 2);
        expect(frame.heights.cross_chain_matches).to.deep.equal({ BTC: 899999 });
        b.stop();
    });

    it('the ready frame carries heights, so a reconnect needs no heartbeat first', async function () {
        let { b, ws } = broadcasterWithSocket();
        b.admissionWatermark = makeWatermark();
        b.admissionWatermark.observeTip('BTC', 900000, Date.now() - 500000);
        await b.addSubscriber(ws);
        let ready = JSON.parse(ws.send.firstCall.args[0]);
        expect(ready.type).to.equal('ready');
        expect(ready.watermark).to.be.a('number');          // the stream watermark, untouched
        expect(ready.heights.cross_chain_matches).to.deep.equal({ BTC: 899999 });
        b.stop();
    });

    it('a broadcaster with no attached source publishes an EMPTY heights object on both frames', async function () {
        let { b, ws } = broadcasterWithSocket();
        await b.addSubscriber(ws);
        let ready = JSON.parse(ws.send.firstCall.args[0]);
        expect(ready.heights).to.deep.equal({});
        ws.send.resetHistory();
        b.broadcastWatermark();
        expect(JSON.parse(ws.send.firstCall.args[0]).heights).to.deep.equal({});
        b.stop();
    });
}

describe('admission height watermark: the frames that carry it', function () {


    afterEach(function () { sinon.restore(); });

    registerWatermarkFrameTests();

    registerWatermarkBroadcastTests();
});
