'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const HubDbAdmissionSampling = require('../../../../../src/peers/hub_db/admission_sampling.js');

function sampler() {
    const value = new HubDbAdmissionSampling();
    value.dropAllForResync = sinon.stub();
    return value;
}

function source(run) {
    return {
        storeRow: sinon.stub().resolves({ affectedRows: 1 }),
        storeRound: sinon.stub().resolves({ affectedRows: 2 }),
        run
    };
}

describe('hub DB catch-up store subscriber resync', function () {
    afterEach(function () { sinon.restore(); });

    it('drops subscribers once after successful row and round stores', async function () {
        const tracking = sampler();
        const catchup = source(async function () {
            await this.storeRow('oracle_prices', {});
            await this.storeRound('price_snapshots', [{}, {}]);
        });
        Object.defineProperty(tracking, '_admissionTimer', { value: {} });
        expect(tracking.attachAdmissionSource({ peerCatchup: catchup })).to.equal(true);
        await catchup.run();
        expect(tracking.dropAllForResync.calledOnceWithExactly('peer catch-up stored 3 row(s)')).to.equal(true);
    });

    it('does not drop subscribers when a run stores nothing', async function () {
        const tracking = sampler();
        const catchup = source(async () => 'done');
        tracking.trackCatchupStores(catchup);
        expect(await catchup.run()).to.equal('done');
        expect(tracking.dropAllForResync.called).to.equal(false);
    });

    it('drops after a partial run and preserves the original failure', async function () {
        const tracking = sampler();
        const failure = new Error('walk failed');
        const catchup = source(async function () {
            await this.storeRow('oracle_prices', {});
            throw failure;
        });
        tracking.trackCatchupStores(catchup);
        let caught;
        try { await catchup.run(); } catch (error) { caught = error; }
        expect(caught).to.equal(failure);
        expect(tracking.dropAllForResync.calledOnce).to.equal(true);
    });

    it('does not count a rejected store or wrap one source twice', async function () {
        const tracking = sampler();
        const failure = new Error('store failed');
        const catchup = source(async function () {
            try { await this.storeRow('oracle_prices', {}); } catch (error) { expect(error).to.equal(failure); }
        });
        catchup.storeRow.rejects(failure);
        expect(tracking.trackCatchupStores(catchup)).to.equal(true);
        expect(tracking.trackCatchupStores(catchup)).to.equal(true);
        await catchup.run();
        expect(tracking.dropAllForResync.called).to.equal(false);
    });
});
