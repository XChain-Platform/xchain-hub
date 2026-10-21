'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// getpricesnapshots reply shapes as they stand today. No unit test drove this
// handler (only e2e, integration, performance and openrpc param-list suites name
// it), so the bare-array reply, the with_watermark envelope, the defaults handed
// to the hub read and the two error strings are pinned here.

const sinon      = require('sinon');
const { expect } = require('chai');
const { buildOracleRpc } = require('../../../src/api/rpc/oracle.js');

const ROWS = [
    { pair: 'DOGE/USD', price: '0.1234', round: 7 },
    { pair: 'LTC/USD',  price: '71.5',   round: 7 },
];

describe('getpricesnapshots reply shape', function () {
    let clock;
    let hub;
    let rpc;

    beforeEach(function () {
        hub = {
            getPriceSnapshots:         sinon.stub().resolves(ROWS),
            oracleMaxAgeSecondsInForce: sinon.stub().resolves(900),
        };
        rpc = buildOracleRpc({ hub });
    });

    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
    });

    it('without with_watermark the reply is JSON-byte-identical to the stub array', async function () {
        let out = await rpc.getpricesnapshots({});
        expect(JSON.stringify(out)).to.equal(JSON.stringify(ROWS));
        expect(Array.isArray(out)).to.equal(true);
        expect(hub.oracleMaxAgeSecondsInForce.called).to.equal(false);
    });

    it('with_watermark truthy returns watermark, oracleMaxPriceAgeSeconds, snapshots in that order', async function () {
        clock = sinon.useFakeTimers({ now: 1700000123456, toFake: ['Date'] });
        let out = await rpc.getpricesnapshots({ with_watermark: true });
        expect(Object.keys(out)).to.deep.equal(['watermark', 'oracleMaxPriceAgeSeconds', 'snapshots']);
        expect(out.watermark).to.equal(Math.floor(1700000123456 / 1000));
        expect(out.oracleMaxPriceAgeSeconds).to.equal(900);
        expect(out.snapshots).to.equal(ROWS);
        expect(hub.oracleMaxAgeSecondsInForce.calledOnce).to.equal(true);
    });

    it('an omitted limit and status reach the hub read as 50 and undefined', async function () {
        await rpc.getpricesnapshots({});
        expect(hub.getPriceSnapshots.calledOnce).to.equal(true);
        let args = hub.getPriceSnapshots.firstCall.args;
        expect(args).to.have.length(2);
        expect(args[0]).to.equal(50);
        expect(args[1]).to.equal(undefined);
    });

    it('a status other than finalized or all returns the exact error string without a read', async function () {
        let out = await rpc.getpricesnapshots({ status: 'disputed' });
        expect(out).to.deep.equal({ error: "status must be 'finalized' or 'all'" });
        expect(hub.getPriceSnapshots.called).to.equal(false);
    });

    it('a throwing hub read returns the exact error envelope', async function () {
        hub.getPriceSnapshots.rejects(new Error('db down'));
        let out = await rpc.getpricesnapshots({});
        expect(out).to.deep.equal({ error: 'error fetching price snapshots' });
    });
});
