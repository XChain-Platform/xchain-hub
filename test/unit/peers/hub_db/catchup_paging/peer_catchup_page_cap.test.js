'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');
const HubDbPeerCatchup = require('../../../../../src/peers/hub_db/peer_catchup.js');
const { makeCatchup } = require('../helpers/peer_catchup_harness.js');

const SERVER_PAGE_CAP = 10000;

function rowsFrom(firstId, count) {
    return Array.from({ length: count }, (_, i) => ({ id: firstId + i, round_number: firstId + i }));
}

describe('catch-up page size against the snapshot route cap', function () {
    afterEach(function () { sinon.restore(); });

    it('never asks for more rows than the snapshot route serves', function () {
        expect(new HubDbPeerCatchup({ pageSize: SERVER_PAGE_CAP * 5 }).pageSize).to.equal(SERVER_PAGE_CAP);
        expect(new HubDbPeerCatchup({ pageSize: 25 }).pageSize).to.equal(25);
        expect(new HubDbPeerCatchup({}).pageSize).to.equal(SERVER_PAGE_CAP);
    });

    it('keeps walking after a page the route filled to its cap', async function () {
        const pages = [rowsFrom(1, SERVER_PAGE_CAP), []];
        const fetchPage = sinon.stub().callsFake(async (peer, table) => (
            { table, schema_version: HUB_SCHEMA_VERSION, rows: pages.shift() || [] }));
        const catchup = makeCatchup({
            fetchPage, pageSize: SERVER_PAGE_CAP * 5, hasRow: async () => true, indexerReadIntervalMs: 0 });
        await catchup.run();
        expect(fetchPage.callCount).to.equal(2);
        expect(fetchPage.firstCall.args[3]).to.equal(SERVER_PAGE_CAP);
        expect(fetchPage.secondCall.args[2]).to.equal(SERVER_PAGE_CAP);
    });
});
