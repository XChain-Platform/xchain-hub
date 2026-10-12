'use strict';

const assert = require('assert');
const proxyquire = require('proxyquire');
const { HUB_SCHEMA_VERSION } = require('../../../src/hub_schema_version.js');
const { mountSnapshotRoutes } = require('../../../src/api/rest/hub_db_snapshot.js');

const SNAPSHOT_ROUTES = [
    '/hub-db/snapshot/anchor_reward_attestations',
    '/hub-db/snapshot/attestation_responses',
    '/hub-db/snapshot/bridge_transfers',
    '/hub-db/snapshot/capability_snapshots',
    '/hub-db/snapshot/cross_chain_calls',
    '/hub-db/snapshot/cross_chain_matches',
    '/hub-db/snapshot/list_snapshots',
    '/hub-db/snapshot/oracle_prices',
    '/hub-db/snapshot/policy_snapshots',
    '/hub-db/snapshot/price_snapshots',
    '/hub-db/snapshot/remote_token_snapshots',
    '/hub-db/snapshot/state_checkpoints',
];

function fakeResponse() {
    return {
        body: null,
        type() { return this; },
        send(value) { this.body = value; return this; },
        status() { return this; },
        json(value) { this.body = JSON.stringify(value); return this; },
    };
}

function mountSnapshots() {
    const routes = {};
    const app = {
        use() {},
        get(route, handler) { routes[route] = handler; },
    };
    const db = new Proxy({}, {
        get() { return async () => []; },
    });

    mountSnapshotRoutes(app, {
        hub: { db },
        logger: { error() {} },
        bigIntReplacer: (key, value) => value,
        HUB_NETWORK: 'regtest',
        HUB_API_KEY: '',
        HUB_FEED_API_KEY: '',
    });
    return routes;
}

describe('hub mirror schema-version lockstep', function () {
    it('stamps every REST snapshot route with the current schema version', async function () {
        const routes = mountSnapshots();
        assert.deepStrictEqual(Object.keys(routes).sort(), SNAPSHOT_ROUTES);

        for (const route of SNAPSHOT_ROUTES) {
            const res = fakeResponse();
            await routes[route]({ query: {} }, res);
            assert.strictEqual(JSON.parse(res.body).schema_version, HUB_SCHEMA_VERSION, route);
        }
    });

    it('stamps every row-mutation WebSocket frame with the current schema version', function () {
        const HubDbBroadcaster = proxyquire('../../../src/peers/hub_db_broadcaster.js', {
            ws: { OPEN: 1 },
        });
        const messages = [];
        const ws = {
            readyState: 1,
            bufferedAmount: 0,
            send(message) { messages.push(JSON.parse(message)); },
            close() {},
        };
        const broadcaster = new HubDbBroadcaster({});
        broadcaster.subscribers.add(ws);

        try {
            broadcaster.broadcastRow({ table: 'price_snapshots', row: { id: 1 } });
            broadcaster.broadcastMatchAnchorStamp('match-1', 'anchor-1');
            broadcaster.broadcastDeletion({
                table: 'cross_chain_matches',
                source_chain: 'BTC',
                from_action_index: 1,
            });
        } finally {
            broadcaster.stop();
        }

        assert.deepStrictEqual(messages.map(frame => frame.type), [
            'row:inserted',
            'row:anchor-stamped',
            'row:deleted',
        ]);
        for (const frame of messages)
            assert.strictEqual(frame.schema_version, HUB_SCHEMA_VERSION, frame.type);
    });
});
