'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// A restarted follower must not report caught up while its signer peers are still being
// classified: readiness frames, the landed map and the admission sampler all read isCaughtUp().

const { expect } = require('chai');
const sinon = require('sinon');
const { EventEmitter } = require('events');
const HubDbPeerCatchup = require('../../../../../src/peers/hub_db/peer_catchup.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');

const GRACE_MS = 5000;

function make(extra) {
    const logger = { warn: sinon.stub(), error: sinon.stub() };
    const pm = new EventEmitter();
    pm.peers = new Map();
    pm.validatorPubkeys = new Map();
    pm.effectiveSignerSet = new Set(['aa']);
    const catchup = new HubDbPeerCatchup(Object.assign({
        db: {}, peerManager: pm, tables: ['state_checkpoints', 'oracle_prices'], logger,
        getVerifier: () => async () => true, hasRow: async () => false,
        storeRow: async () => ({ affectedRows: 1 }), pageSize: 10, warnIntervalMs: 60000,
        bootGraceMs: GRACE_MS, retryIntervalMs: 3600000,
        fetchPage: async (peer, table) => ({ table, schema_version: HUB_SCHEMA_VERSION, rows: [] })
    }, extra));
    return { catchup, pm, logger };
}

// A signer peer that dialed in and proved its key, but whose feed address is not known yet.
function connectUnclassifiedInbound(pm) {
    pm.peers.set('inbound-1', { state: 'open', inbound: true, validatorAddr: 'hub-peer-b', signing_pubkey: 'AA' });
}

function connectFetchable(pm) {
    pm.peers.set('ws://peer-c.example:10002', { state: 'open', validatorAddr: 'v-c', signing_pubkey: 'AA' });
}

let clock;
function fakeDate() {
    beforeEach(function () { clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] }); });
    afterEach(function () { clock.restore(); sinon.restore(); });
}

describe('hub DB peer catch-up readiness before signer peers are classified at boot', function () {
    fakeDate();

    it('is not caught up inside the boot grace before any peer is classified', async function () {
        const { catchup } = make();
        await catchup.start();
        expect(catchup.isCaughtUp()).to.equal(false);
        expect(catchup.getStats().caught_up).to.equal(false);
        catchup.stop();
    });

    it('stays not caught up when the only connected signer peer has no feed URL yet', async function () {
        const { catchup, pm } = make();
        await catchup.start();
        connectUnclassifiedInbound(pm);
        await catchup.run();
        expect(catchup.lastUsablePeerCount).to.equal(0);
        expect(catchup.isCaughtUp()).to.equal(false);
        expect(catchup.getStats().caught_up).to.equal(false);
        expect(catchup.getStats().ungated).to.equal(false);
        catchup.stop();
    });

    it('stays not caught up after the grace while a fetchable peer serves none of the missing rows', async function () {
        const { catchup, pm } = make({ fetchPage: async () => { throw new Error('feed down'); } });
        await catchup.start();
        connectFetchable(pm);
        await catchup.run();
        expect(catchup.isCaughtUp()).to.equal(false);
        clock.tick(GRACE_MS + 1);
        expect(catchup.isCaughtUp()).to.equal(false);
        catchup.stop();
    });

});

describe('hub DB peer catch-up readiness once boot classification ends', function () {
    fakeDate();

    it('keeps the zero-peer escape once the grace passes with no peer ever connected', async function () {
        const { catchup } = make();
        await catchup.start();
        clock.tick(GRACE_MS + 1);
        await catchup.run();
        expect(catchup.isCaughtUp()).to.equal(true);
        catchup.stop();
    });

    it('keeps the zero-peer escape after the grace for a peer that never announced a feed URL', async function () {
        const { catchup, pm } = make();
        await catchup.start();
        connectUnclassifiedInbound(pm);
        await catchup.run();
        clock.tick(GRACE_MS + 1);
        expect(catchup.isCaughtUp()).to.equal(true);
        catchup.stop();
    });

    it('is caught up once a classified peer has walked every table', async function () {
        const { catchup, pm } = make();
        await catchup.start();
        connectUnclassifiedInbound(pm);
        await catchup.run();
        expect(catchup.isCaughtUp()).to.equal(false);
        connectFetchable(pm);
        await catchup.run();
        expect(catchup.lastUsablePeerCount).to.equal(1);
        expect(catchup.bootGraceUntil).to.equal(0);
        expect(catchup.isCaughtUp()).to.equal(true);
        catchup.stop();
    });
});
