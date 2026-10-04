'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const HubDbBroadcaster = require('../../../../src/peers/hub_db_broadcaster.js');
const ChainTips = require('../../../../src/hub/chain_tips.js');

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

function build(readings, aggregator) {
    const broadcaster = new HubDbBroadcaster({});
    broadcaster.isCaughtUp = () => true;
    const hub = {
        priceAggregator: aggregator,
        resolveAdmissionTips: async () => ({}),
        resolveLandingReadings: async () => (typeof readings === 'function' ? readings() : readings)
    };
    broadcaster._admissionHub = hub;
    broadcaster.landingWatermark.trackIngest(aggregator);
    return { broadcaster, hub };
}

function frame(broadcaster) {
    const sent = [];
    broadcaster.subscribers.add({ readyState: 1, bufferedAmount: 0, send: (m) => sent.push(JSON.parse(m)) });
    broadcaster.broadcastWatermark();
    return sent.find((m) => m.type === 'watermark');
}

describe('landing watermark', function () {
    afterEach(function () { this.broadcaster && this.broadcaster.stop(); });

    it('carries landed.DOGE only after the stamp for that block was emitted', async function () {
        const gate = deferred();
        const events = [];
        const aggregator = {
            receiveValidatedBatch: async () => {
                await gate.promise;
                events.push('stamp-emitted');
                return { accepted: true };
            }
        };
        const { broadcaster } = build({ DOGE: { block: 100, protocol_time: 1791144200 } }, aggregator);
        this.broadcaster = broadcaster;

        const ingest = aggregator.receiveValidatedBatch('DOGE', {});
        await broadcaster.sampleAdmission();
        expect(frame(broadcaster).landed).to.deep.equal({});

        gate.resolve();
        await ingest;
        await broadcaster.sampleAdmission();
        expect(events).to.deep.equal(['stamp-emitted']);
        expect(frame(broadcaster).landed).to.deep.equal({ DOGE: { block: 100, protocol_time: 1791144200 } });
    });

    it('rejects a reading when an ingest began during the read', async function () {
        const aggregator = { receiveValidatedBatch: async () => ({ accepted: true }) };
        const { broadcaster, hub } = build(null, aggregator);
        this.broadcaster = broadcaster;
        hub.resolveLandingReadings = async () => {
            await aggregator.receiveValidatedBatch('DOGE', {});
            return { DOGE: { block: 5, protocol_time: 1791144000 } };
        };
        await broadcaster.sampleAdmission();
        expect(frame(broadcaster).landed).to.deep.equal({});
    });

    it('publishes no advance for a regressing or null reading', async function () {
        let next = { DOGE: { block: 100, protocol_time: 1791144200 } };
        const aggregator = { receiveValidatedBatch: async () => ({}) };
        const { broadcaster } = build(() => next, aggregator);
        this.broadcaster = broadcaster;
        const published = { DOGE: { block: 100, protocol_time: 1791144200 } };

        await broadcaster.sampleAdmission();
        expect(broadcaster.landedMap()).to.deep.equal(published);
        for (const bad of [
            { DOGE: { block: 99, protocol_time: 1791144100 } },
            { DOGE: { block: 100, protocol_time: 1791144200 } },
            { DOGE: { block: 101, protocol_time: 1791144100 } },
            { DOGE: null },
            { DOGE: { block: 'x', protocol_time: 5 } }
        ]) {
            next = bad;
            await broadcaster.sampleAdmission();
            expect(broadcaster.landedMap()).to.deep.equal(published);
        }
        next = { DOGE: { block: 101, protocol_time: 1791144260 } };
        await broadcaster.sampleAdmission();
        expect(broadcaster.landedMap().DOGE.block).to.equal(101);
    });

    it('has no entry for a chain that never reported one', async function () {
        const { broadcaster } = build({ DOGE: null }, { receiveValidatedBatch: async () => ({}) });
        this.broadcaster = broadcaster;
        await broadcaster.sampleAdmission();
        expect(broadcaster.landedMap()).to.deep.equal({});
    });

    it('holds the map back until the hub is caught up and rides the ready frame', async function () {
        const { broadcaster } = build({ DOGE: { block: 7, protocol_time: 1791144000 } }, { receiveValidatedBatch: async () => ({}) });
        this.broadcaster = broadcaster;
        await broadcaster.sampleAdmission();
        broadcaster.isCaughtUp = () => false;
        expect(broadcaster.landedMap()).to.deep.equal({});
        broadcaster.isCaughtUp = () => true;
        const sent = [];
        await broadcaster.addSubscriber({ readyState: 1, bufferedAmount: 0, on() {}, send: (m) => sent.push(JSON.parse(m)) }, null).catch(() => {});
        const ready = sent.find((m) => m.type === 'ready');
        expect(ready.landed).to.deep.equal({ DOGE: { block: 7, protocol_time: 1791144000 } });
    });

    it('relay mode republishes upstream verbatim and mints nothing', async function () {
        const broadcaster = new HubDbBroadcaster({ HUB_ADMISSION_RELAY: '1' });
        this.broadcaster = broadcaster;
        broadcaster.isCaughtUp = () => true;
        const lw = broadcaster.landingWatermark;
        expect(lw.observe('DOGE', { block: 1, protocol_time: 5 }, { inFlight: 0, started: 0 }, { inFlight: 0, started: 0 })).to.equal(false);
        lw.republishFrom({ DOGE: { block: 50, protocol_time: 1791144000 }, 'not a chain': { block: 1, protocol_time: 2 }, LTC: { block: -1, protocol_time: 2 } });
        expect(broadcaster.landedMap()).to.deep.equal({ DOGE: { block: 50, protocol_time: 1791144000 } });
        lw.republishFrom({ DOGE: { block: 40, protocol_time: 1791143000 } });
        expect(broadcaster.landedMap().DOGE.block).to.equal(50);
    });

    it('reads hub_push_delivered from the indexer status and nulls a missing one', async function () {
        class Tips extends ChainTips {
            async resolveIndexerUrl(c) { return c === 'LTC' ? null : 'http://indexer'; }
        }
        Tips.modules = { axios: { post: async () => ({ data: { result: { hub_push_delivered: { block: 9, protocol_time: 1791144000 } } } }) } };
        const out = await new Tips().resolveLandingReadings(['DOGE', 'LTC']);
        expect(out).to.deep.equal({ DOGE: { block: 9, protocol_time: 1791144000 }, LTC: null });

        Tips.modules = { axios: { post: async () => ({ data: { result: { decoder_block: 9 } } }) } };
        expect(await new Tips().resolveLandingReadings(['DOGE'])).to.deep.equal({ DOGE: null });

        Tips.modules = { axios: { post: async () => { throw new Error('down'); } } };
        expect(await new Tips().resolveLandingReadings(['DOGE'])).to.deep.equal({ DOGE: null });
    });
});
