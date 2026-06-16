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

const { expect }    = require('chai');
const testDb        = require('../helpers/testDb');
const priceMocks    = require('./helpers/priceMocks');
const { createCluster } = require('./helpers/cluster');
const { callRpc }       = require('./helpers/rpcClient');

describe('E2E: Config Pipeline', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E config tests');
            return;
        }
        priceMocks.setup();
    });

    after(async function () {
        this.timeout(10000);
        priceMocks.teardown();
        await testDb.teardown();
    });

    beforeEach(async function () {
        this.timeout(15000);
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        priceMocks.reset();
    });

    afterEach(async function () {
        this.timeout(10000);
        if (cluster) {
            await cluster.stop();
            cluster = null;
        }
    });

    // E2E-CONFIG-003: Single-node config update
    describe('E2E-CONFIG-003: Single-node config update', function () {

        it('writes and retrieves config via JSON-RPC', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Write config — bypass consensus by writing directly to the hub's DB
            let db = cluster.getDb();
            let hub = cluster.getHub(0);
            await hub.applyConfig({
                BTC: {
                    mainnet: {
                        decoder: { host: 'btc-decoder.local', port: '8332' },
                        indexer: { host: 'btc-indexer.local', port: '3306' }
                    }
                }
            });

            // Read config via JSON-RPC
            let readRes = await callRpc(port, 'getallconfigs');
            expect(readRes.result.seq).to.be.a('number');
            expect(readRes.result.configs.BTC).to.exist;
            expect(readRes.result.configs.BTC.mainnet.decoder.host).to.equal('btc-decoder.local');
            expect(readRes.result.configs.BTC.mainnet.decoder.port).to.equal('8332');
            expect(readRes.result.configs.BTC.mainnet.indexer.host).to.equal('btc-indexer.local');

            // Also verify updateconfig API returns success
            let writeRes = await callRpc(port, 'updateconfig', {
                config: { BTC: { mainnet: { decoder: { host: 'updated.local' } } } }
            });
            expect(writeRes.result.status).to.equal('success');

            // Verify the update took effect
            let readRes2 = await callRpc(port, 'getallconfigs');
            expect(readRes2.result.configs.BTC.mainnet.decoder.host).to.equal('updated.local');
        });

        it('handles multi-coin config in a single update', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            await callRpc(port, 'updateconfig', {
                config: {
                    BTC:  { mainnet: { decoder: { host: 'btc-host', port: '8332' } } },
                    LTC:  { mainnet: { decoder: { host: 'ltc-host', port: '9332' } } },
                    DOGE: { mainnet: { decoder: { host: 'doge-host', port: '22555' } } }
                }
            });

            let readRes = await callRpc(port, 'getallconfigs');
            expect(readRes.result.configs.BTC.mainnet.decoder.host).to.equal('btc-host');
            expect(readRes.result.configs.LTC.mainnet.decoder.host).to.equal('ltc-host');
            expect(readRes.result.configs.DOGE.mainnet.decoder.host).to.equal('doge-host');
        });

        it('overwrites existing config on re-update', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // First write
            await callRpc(port, 'updateconfig', {
                config: { BTC: { mainnet: { decoder: { host: 'old-host' } } } }
            });

            // Overwrite
            await callRpc(port, 'updateconfig', {
                config: { BTC: { mainnet: { decoder: { host: 'new-host' } } } }
            });

            let readRes = await callRpc(port, 'getallconfigs');
            expect(readRes.result.configs.BTC.mainnet.decoder.host).to.equal('new-host');
        });
    });
});
