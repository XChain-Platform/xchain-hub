'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    createSnapshotFetcher,
    pageSnapshotTable
} = require('../../../../src/peers/hub_db/catchup_pager.js');

const TABLE = 'price_snapshots';

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return body; }
    };
}

describe('hub DB catch-up snapshot pager', function () {
    it('fetches three pages from zero and hands every row over in order', async function () {
        const requests = [];
        const pages = [
            [{ id: 1 }, { id: 3 }],
            [{ id: 8 }, { id: 13 }],
            [{ id: 21 }]
        ];
        const fetchImpl = async (url, options) => {
            requests.push({ url, options });
            return response({ table: TABLE, rows: pages.shift(), count: 2 });
        };
        const fetchPage = createSnapshotFetcher({ apiUrl: 'https://peer.test/', fetchImpl });
        const handedOff = [];

        const result = await pageSnapshotTable({
            table: TABLE,
            fetchPage,
            onRow: async row => handedOff.push(row.id),
            limit: 2
        });

        expect(result).to.deep.equal({ complete: true, rows: 5, lastId: 21 });
        expect(handedOff).to.deep.equal([1, 3, 8, 13, 21]);
        expect(requests.map(call => new URL(call.url).searchParams.get('since_id')))
            .to.deep.equal(['0', '3', '13']);
        expect(requests.every(call => !new URL(call.url).searchParams.has('latest'))).to.equal(true);
        expect(requests.every(call => call.options.method === 'GET')).to.equal(true);
    });

    it('completes an empty first page without handing off a row', async function () {
        let calls = 0;
        const result = await pageSnapshotTable({
            table: TABLE,
            fetchPage: async () => { calls++; return { table: TABLE, rows: [] }; },
            onRow: async () => { throw new Error('must not run'); }
        });

        expect(result).to.deep.equal({ complete: true, rows: 0, lastId: 0 });
        expect(calls).to.equal(1);
    });

    it('ends incomplete when fetching throws', async function () {
        const failure = new Error('offline');
        const result = await pageSnapshotTable({
            table: TABLE,
            fetchPage: async () => { throw failure; },
            onRow: async () => {}
        });

        expect(result).to.include({ complete: false, rows: 0, lastId: 0 });
        expect(result.error).to.equal(failure);
    });

    it('ends incomplete for a response naming the wrong table', async function () {
        const result = await pageSnapshotTable({
            table: TABLE,
            fetchPage: async () => ({ table: 'oracle_prices', rows: [] }),
            onRow: async () => {}
        });

        expect(result).to.include({ complete: false, rows: 0, lastId: 0 });
        expect(result.error.message).to.equal('Invalid snapshot response for table ' + TABLE);
    });

    it('ends incomplete before handing off a row whose cursor does not advance', async function () {
        const handedOff = [];
        const result = await pageSnapshotTable({
            table: TABLE,
            fetchPage: async () => ({ table: TABLE, rows: [{ id: '9' }, { id: '10' }, { id: '10' }] }),
            onRow: async row => handedOff.push(row.id),
            limit: 3
        });

        expect(result).to.include({ complete: false, rows: 2, lastId: '10' });
        expect(result.error.message).to.equal('Snapshot row id did not advance the cursor');
        expect(handedOff).to.deep.equal(['9', '10']);
    });

    it('ends incomplete and preserves progress when onRow throws', async function () {
        const failure = new Error('write failed');
        const handedOff = [];
        const result = await pageSnapshotTable({
            table: TABLE,
            fetchPage: async () => ({ table: TABLE, rows: [{ id: 1 }, { id: 2 }] }),
            onRow: async row => {
                if (row.id === 2) throw failure;
                handedOff.push(row.id);
            },
            limit: 10
        });

        expect(result).to.include({ complete: false, rows: 1, lastId: 1 });
        expect(result.error).to.equal(failure);
        expect(handedOff).to.deep.equal([1]);
    });

    it('refuses an unknown table and invalid limit before fetching', function () {
        let fetches = 0;
        const options = {
            table: 'unknown_table',
            fetchPage: async () => { fetches++; },
            onRow: async () => {}
        };

        expect(() => pageSnapshotTable(options)).to.throw('Unknown mirrored table: unknown_table');
        expect(() => pageSnapshotTable(Object.assign({}, options, { table: TABLE, limit: 0 })))
            .to.throw(RangeError, 'Snapshot page limit must be an integer from 1 to 10000');
        expect(fetches).to.equal(0);
    });

    it('sends a configured key only in x-api-key and omits it from errors', async function () {
        const key = 'secret-feed-key';
        let request;
        const fetchPage = createSnapshotFetcher({
            apiUrl: 'https://peer.test',
            feedKey: key,
            fetchImpl: async (url, options) => {
                request = { url, options };
                return response(null, 503);
            }
        });

        let error;
        try {
            await fetchPage({ table: TABLE, sinceId: 0, limit: 1000 });
        } catch (err) {
            error = err;
        }

        expect(request.url).to.equal('https://peer.test/hub-db/snapshot/price_snapshots?since_id=0&limit=1000');
        expect(request.url).not.to.include(key);
        expect(request.options.headers).to.deep.equal({ 'x-api-key': key });
        expect(error.message).to.include('503').and.not.to.include(key);
    });

    it('does not send x-api-key when the key is unset', async function () {
        let headers;
        const fetchPage = createSnapshotFetcher({
            apiUrl: 'https://peer.test',
            fetchImpl: async (url, options) => {
                headers = options.headers;
                return response({ table: TABLE, rows: [] });
            }
        });

        await fetchPage({ table: TABLE, sinceId: 0, limit: 1000 });
        expect(headers).not.to.have.property('x-api-key');
    });
});
