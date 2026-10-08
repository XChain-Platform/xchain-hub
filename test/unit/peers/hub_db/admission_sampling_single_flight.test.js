'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon      = require('sinon');
const { expect } = require('chai');
const HubDbBroadcaster = require('../../../../src/peers/hub_db_broadcaster.js');

// A hub whose admission-tip read stays pending until the test releases it.
function slowHub() {
    const hub = { network: 'regtest', calls: 0, release: null };
    hub.resolveAdmissionTips = () => {
        hub.calls++;
        return new Promise((resolve) => { hub.release = () => resolve({}); });
    };
    return hub;
}

describe('HubDbBroadcaster admission sampler single flight', function () {
    let clock, b;
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['setInterval', 'clearInterval', 'Date'] });
        b = new HubDbBroadcaster({ ADMISSION_WATERMARK_SAMPLE_MS: '1000' });
    });
    afterEach(() => { b.stop(); clock.restore(); });

    it('skips timer ticks while a sampling pass is still in flight', async function () {
        const hub = slowHub();
        b.attachAdmissionSource(hub);
        expect(hub.calls).to.equal(1);
        clock.tick(3500);
        expect(hub.calls).to.equal(1);
        const inFlight = b._admissionSampling;
        hub.release();
        await inFlight;
        expect(b._admissionSampling).to.equal(null);
        clock.tick(1000);
        expect(hub.calls).to.equal(2);
    });
});
