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

const sinon = require('sinon');
const { expect } = require('chai');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const caps = require('../../../../src/api/snapshot_read_caps.js');
const { buildOracleRpc } = require('../../../../src/api/rpc/oracle.js');
const { createApp } = require('../../../../src/api/server.js');

const { waitUntil } = require('../../../helpers/waitUntil');

function appContext(hubConfig, logger) {
    return {
        express, helmet, cors, rateLimit, hubConfig, logger,
        hub: {},
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true,
        WRITE_METHODS: new Set(),
        REORG_WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(),
        SENSITIVE_READ_AUTH: false,
        rpcController: { ping: () => 'pong' },
    };
}

// Page reads that stay open until released, so the peak of reads admitted together shows.
// Every call is issued before the first await, so the gate has decided all of them by the
// time `expected` reads are open.
async function admittedTogether(hubConfig, callers, expected) {
    let open = 0;
    let peak = 0;
    const gates = [];
    const hub = {
        async getPriceSnapshots() {
            open++;
            peak = Math.max(peak, open);
            await new Promise((resolve) => gates.push(resolve));
            open--;
            return [];
        },
    };
    const rpc = buildOracleRpc({ hub, hubConfig });
    const calls = Array.from({ length: callers }, () => rpc.getpricesnapshots({ limit: 10 }));
    await waitUntil(() => open >= expected, { label: expected + ' reads admitted' });
    while (gates.length) gates.shift()();
    await Promise.all(calls);
    return peak;
}

describe('snapshot read caps', function () {
    afterEach(function () { sinon.restore(); });

    it('reads an override only when it is a positive whole number in digits', function () {
        expect(caps.parseCap('2')).to.equal(2);
        expect(caps.parseCap(5)).to.equal(5);
        for (const bad of ['3abc', '2.5', '0', '-1', '', ' 3', '1e1', 0, 2.5, NaN, null, undefined, {}]) {
            expect(caps.parseCap(bad), String(bad)).to.equal(null);
        }
    });

    it('falls back to the shipped default for a refused override', function () {
        expect(caps.resolveRpcSnapshotCap({ HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '2abc' })).to.equal(3);
        expect(caps.resolveRestSnapshotCap({ HUB_SNAPSHOT_MAX_INFLIGHT: '6x' })).to.equal(4);
        expect(caps.resolveRpcSnapshotCap({ HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '2' })).to.equal(2);
        expect(caps.resolveRestSnapshotCap({ HUB_SNAPSHOT_MAX_INFLIGHT: '6' })).to.equal(6);
        expect(caps.resolveRpcSnapshotCap(undefined)).to.equal(3);
    });

    it('admits the shipped default of three page reads when the override is not a clean number', async function () {
        expect(await admittedTogether({ HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '2abc' }, 8, 3)).to.equal(3);
        expect(await admittedTogether({ HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '2' }, 8, 2)).to.equal(2);
    });

    it('stays silent for the defaults and for a sum that leaves three connections free', function () {
        expect(caps.snapshotCapWarnings({})).to.deep.equal([]);
        expect(caps.snapshotCapWarnings({ HUB_SNAPSHOT_MAX_INFLIGHT: '4', HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '3' }))
            .to.deep.equal([]);
        expect(caps.snapshotCapWarnings({ HUB_SNAPSHOT_MAX_INFLIGHT: '5', HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '2' }))
            .to.deep.equal([]);
    });

    it('warns when the two caps leave fewer than three of the ten pooled connections free', function () {
        const warnings = caps.snapshotCapWarnings({ HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '10' });
        expect(warnings).to.have.length(1);
        expect(warnings[0]).to.include('4 REST and 10 RPC').and.to.include('below 7');
        expect(caps.snapshotCapWarnings({ HUB_SNAPSHOT_MAX_INFLIGHT: '5', HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '3' }))
            .to.have.length(1);
    });

    it('names a refused override and still checks the budget with the default it falls back to', function () {
        const warnings = caps.snapshotCapWarnings({ HUB_SNAPSHOT_MAX_INFLIGHT: '3abc', HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '4' });
        expect(warnings).to.have.length(2);
        expect(warnings[0]).to.include('HUB_SNAPSHOT_MAX_INFLIGHT="3abc"');
        expect(warnings[1]).to.include('4 REST and 4 RPC');
    });

    it('logs each warning once at app build and nothing for the defaults', function () {
        const logger = { info() {}, warn: sinon.stub(), error() {}, debug() {} };
        createApp(appContext({}, logger));
        expect(logger.warn.callCount).to.equal(0);

        createApp(appContext({ HUB_RPC_SNAPSHOT_MAX_INFLIGHT: '10' }, logger));
        expect(logger.warn.callCount).to.equal(1);
        expect(logger.warn.firstCall.args[0]).to.include('10 RPC');
    });
});
