'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('node:assert/strict');
const { mountSnapshotRoutes } = require('../hub_db_snapshot');

const STORED_CHAIN_ID = 'a'.repeat(64);
const SNAPSHOT_TABLES = [
    'cross_chain_matches',
    'capability_snapshots',
    'remote_token_snapshots',
    'cross_chain_calls',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots'
];

function response() {
    return {
        statusCode: 200,
        type() { return this; },
        send(body) { this.body = body; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = JSON.stringify(body); return this; }
    };
}

function noTipHub() {
    const rows = async () => [];
    return {
        network: 'regtest',
        db: {
            getChainTip: async () => null,
            getChainId: async () => STORED_CHAIN_ID,
            findCrossChainMatchesById: rows,
            findCapabilitySnapshotsById: rows,
            findRemoteTokenSnapshots: rows,
            findCrossChainCallsById: rows,
            findBridgeTransfers: rows,
            findPolicySnapshots: rows,
            findListSnapshots: rows
        }
    };
}

describe('hub DB snapshot stored BTC chain identity', function () {
    const routes = {};
    const app = {
        use() {},
        get(path, ...handlers) { routes[path] = handlers[handlers.length - 1]; }
    };

    mountSnapshotRoutes(app, {
        hub: noTipHub(),
        HUB_NETWORK: 'regtest',
        logger: { error() {} },
        bigIntReplacer: null
    });

    for (const table of SNAPSHOT_TABLES) {
        it(table + ' advertises the stored id without a pushed tip', async function () {
            const res = response();
            await routes['/hub-db/snapshot/' + table]({ query: {} }, res);
            assert.equal(res.statusCode, 200);
            assert.equal(JSON.parse(res.body).btc_chain_id, STORED_CHAIN_ID);
        });
    }
});
