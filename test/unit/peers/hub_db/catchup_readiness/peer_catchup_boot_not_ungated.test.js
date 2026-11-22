'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const { EventEmitter } = require('events');
const HubDbPeerCatchup = require('../../../../../src/peers/hub_db/peer_catchup.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');

function make(extra) {
    const logger = { warn: sinon.stub(), error: sinon.stub() };
    const pm = new EventEmitter();
    pm.peers = new Map();
    pm.validatorPubkeys = new Map();
    pm.effectiveSignerSet = new Set(['aa']);
    const catchup = new HubDbPeerCatchup(Object.assign({
        db: {}, peerManager: pm, tables: ['state_checkpoints'], logger,
        getVerifier: () => async () => true, hasRow: async () => false,
        storeRow: async () => ({ affectedRows: 1 }), pageSize: 10, warnIntervalMs: 60000
    }, extra));
    return { catchup, pm, logger };
}

function connect(pm) {
    pm.peers.set('ws://p.example:1', { state: 'open', validatorAddr: 'v1', signing_pubkey: 'AA' });
}

const ungatedWarns = logger => logger.warn.getCalls().filter(c => /no usable signer-set peer/.test(c.args[0]));

describe('hub DB peer catch-up does not claim caught up at boot before any peer connected', function () {
    afterEach(function () { sinon.restore(); });

    it('is not caught up after a started run that saw no peer yet, and logs no ungated warning', async function () {
        const { catchup, logger } = make();
        await catchup.start();
        expect(catchup.isCaughtUp()).to.equal(false);
        expect(ungatedWarns(logger)).to.have.length(0);
        catchup.stop();
    });

    it('keeps the documented escape once the boot grace has passed with no peer', async function () {
        const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] });
        const { catchup, logger } = make({ bootGraceMs: 5000 });
        await catchup.start();
        expect(catchup.isCaughtUp()).to.equal(false);
        clock.tick(5001);
        await catchup.run();
        expect(catchup.isCaughtUp()).to.equal(true);
        expect(ungatedWarns(logger)).to.have.length(1);
        catchup.stop();
        clock.restore();
    });

    it('keeps the escape immediately when grace is disabled or the instance never started', async function () {
        const a = make({ bootGraceMs: 0 });
        await a.catchup.start();
        expect(a.catchup.isCaughtUp()).to.equal(true);
        a.catchup.stop();
        const b = make();
        await b.catchup.run();
        expect(b.catchup.isCaughtUp()).to.equal(true);
    });

    it('holds not-caught-up while a connected peer walk is pending, and ends the grace on connect', async function () {
        const { catchup, pm } = make();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        catchup.fetchPage = async (peer, table) => {
            await gate;
            return { table, schema_version: HUB_SCHEMA_VERSION, rows: [] };
        };
        await catchup.start();
        connect(pm);
        const walk = catchup.schedule();
        expect(catchup.isCaughtUp()).to.equal(false);
        release();
        await walk;
        expect(catchup.bootGraceUntil).to.equal(0);
        expect(catchup.isCaughtUp()).to.equal(true);
        catchup.stop();
    });
});
