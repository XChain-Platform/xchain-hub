'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');
const HubDbPeerCatchup = require('../../../../../src/peers/hub_db/peer_catchup.js');
const { PEER, makeCatchup } = require('../helpers/peer_catchup_harness.js');

const SERVER_PAGE_CAP = 10000;

function rowsFrom(firstId, count) {
    return Array.from({ length: count }, (_, i) => ({ id: firstId + i }));
}

function tooLarge(contentLength) {
    const error = new Error('too large');
    error.code = HubDbPeerCatchup.RESPONSE_TOO_LARGE;
    if (contentLength) error.contentLength = contentLength;
    return error;
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

    it('shrinks an oversized page and retries the same cursor without backing off', async function () {
        const rows = rowsFrom(1, 6000);
        const limits = [];
        const fetchPage = sinon.stub().callsFake(async (peer, table, cursor, limit) => {
            limits.push(limit);
            if (limit > 2500) throw tooLarge();
            return { table, schema_version: HUB_SCHEMA_VERSION,
                rows: rows.filter(row => row.id > cursor).slice(0, limit) };
        });
        const catchup = makeCatchup({ fetchPage, pageSize: SERVER_PAGE_CAP, hasRow: async () => true });
        const noteFailure = sinon.spy(catchup.feedBackoff, 'noteFailure');
        await catchup.run();
        expect(limits).to.deep.equal([10000, 5000, 2500, 2500, 2500]);
        expect(catchup.state.isTableCaughtUp('price_snapshots')).to.equal(true);
        expect(noteFailure.called).to.equal(false);
        limits.length = 0;
        await catchup.run();
        expect(limits[0]).to.equal(2500);
    });

    it('uses content length to reduce the retry limit and backs off only at limit one', async function () {
        const limits = [];
        const fetchPage = sinon.stub().callsFake(async (peer, table, cursor, limit) => {
            limits.push(limit);
            throw tooLarge(limit === 10000 ? 4 * HubDbPeerCatchup.MAX_RESPONSE_BYTES : null);
        });
        const catchup = makeCatchup({ fetchPage, pageSize: SERVER_PAGE_CAP, hasRow: async () => true });
        await catchup.run();
        expect(limits.slice(0, 2)).to.deep.equal([10000, 2250]);
        expect(limits[limits.length - 1]).to.equal(1);
        expect(catchup.feedBackoff.isBackedOff(PEER)).to.equal(true);
        expect(catchup.state.isTableCaughtUp('price_snapshots')).to.equal(false);
    });
});
