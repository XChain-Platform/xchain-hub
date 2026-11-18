'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const AttestationSpotChecker = require('../../../../src/attestation/spot_checker');

const CORPUS = [{ providerId: 'http_get', prompt: 'q', expectedPattern: 'a' }];

function makeChecker(blocks, blockMs) {
    const injector = sinon.stub().resolves({ requestId: 'fresh' });
    const registry = blocks == null ? { getModule: sinon.stub() } : {
        getModule: sinon.stub(),
        maxDeadlineWindowBlocks: () => ({ blocks })
    };
    const hub = { spotCheckInjector: injector, p2pConfig: {
        SPOT_CHECK_ENABLED: '1', SPOT_CHECK_CORPUS: JSON.stringify(CORPUS),
        ATTESTATION_BLOCK_MS: String(blockMs)
    } };
    return { checker: new AttestationSpotChecker(hub, registry), injector };
}

function backdate(checker, id, ageMs, now = Date.now()) {
    checker.register(id, 'http_get', 'a');
    checker._queue.get(id).registeredAt = now - ageMs;
}

describe('AttestationSpotChecker queue age-out', function () {
    afterEach(function () { sinon.restore(); });

    it('expires stale entries before applying queue backpressure', async function () {
        sinon.useFakeTimers({ now: 100000 });
        const { checker, injector } = makeChecker(2, 10);
        for (let i = 0; i < 921; i++) backdate(checker, 'stale' + i, 81);
        expect(await checker.schedulerTick()).to.equal(1);
        expect(injector.calledOnce).to.equal(true);
        expect(checker.queueSize()).to.equal(1);
        expect(checker.queueExpired).to.equal(921);
    });

    it('keeps fresh entries and scans stale rows after them', function () {
        const { checker } = makeChecker(2, 10);
        const now = 100000;
        backdate(checker, 'fresh-first', 79, now);
        backdate(checker, 'stale-after', 81, now);
        expect(checker.expireStaleQueueEntries(now)).to.equal(1);
        expect(checker.isSpotCheck('fresh-first')).to.equal(true);
        expect(checker.isSpotCheck('stale-after')).to.equal(false);
    });

    it('keeps the allowance an entry was registered under when the window later shrinks', function () {
        let blocks = 10;
        const registry = { getModule: sinon.stub(), maxDeadlineWindowBlocks: () => ({ blocks }) };
        const hub = { p2pConfig: { ATTESTATION_BLOCK_MS: '10' } };
        const checker = new AttestationSpotChecker(hub, registry);
        const now = 100000;
        backdate(checker, 'old-window', 100, now);
        blocks = 1;
        expect(checker.expireStaleQueueEntries(now), 'age 100 is inside the 400ms allowance').to.equal(0);
        expect(checker.isSpotCheck('old-window')).to.equal(true);
        backdate(checker, 'new-window', 100, now);
        expect(checker.expireStaleQueueEntries(now), 'age 100 exceeds the 40ms allowance').to.equal(1);
        expect(checker.isSpotCheck('new-window')).to.equal(false);
    });

    it('uses the 100-block fallback when the registry has no window method', function () {
        const { checker } = makeChecker(null, 10);
        const now = 100000;
        backdate(checker, 'fresh', 3999, now);
        backdate(checker, 'stale', 4001, now);
        expect(checker.expireStaleQueueEntries(now)).to.equal(1);
        expect(checker.isSpotCheck('fresh')).to.equal(true);
        expect(checker.isSpotCheck('stale')).to.equal(false);
    });
});
