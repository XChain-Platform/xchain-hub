'use strict';

const assert = require('assert');
const { mountSnapshotRoutes } = require('../../../src/api/rest/hub_db_snapshot.js');

function fakeResponse() {
    return {
        body: null,
        type() { return this; },
        send(value) { this.body = value; return this; },
        status() { return this; },
        json(value) { this.body = JSON.stringify(value); return this; },
    };
}

describe('list_snapshots schema-version fence', function () {
    it('stamps schema_version 8 on the list_snapshots snapshot route', async function () {
        const routes = {};
        const app = {
            use() {},
            get(route, handler) { routes[route] = handler; },
        };
        const hub = {
            db: {
                findListSnapshots: async () => [],
                getChainTip: async () => null,
            },
        };
        mountSnapshotRoutes(app, {
            hub,
            logger: { error() {} },
            bigIntReplacer: (key, value) => value,
            HUB_NETWORK: 'regtest',
            HUB_API_KEY: '',
        });

        const res = fakeResponse();
        await routes['/hub-db/snapshot/list_snapshots']({ query: {} }, res);

        const snapshot = JSON.parse(res.body);
        assert.strictEqual(snapshot.table, 'list_snapshots');
        assert.strictEqual(snapshot.schema_version, 8);
    });
});
