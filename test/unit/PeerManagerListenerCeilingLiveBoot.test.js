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

// PeerManagerListenerCeiling.test.js proved the ceiling matches the declared
// roster, but every subscriber in that file is a synthetic `pm.on('message', ...)`
// stand-in named after a module, not the module itself, so the live 11-listener
// boot warning is never observed first-hand there and the roster is only
// derived from source registrations. This file closes that gap: it drives the REAL
// boot sequence api.js runs (hub.start / startP2P / startConsensus / startOracle
// / startAttestation / startCrossChain / startReorgHandler / startGovernance)
// against a real PeerManager, with only the database swapped for an in-memory
// stub, so every one of the 16 MESSAGE_SUBSCRIBERS attaches its OWN real
// 'message' handler rather than a stand-in. If a real module ever registered
// twice, or the roster undercounted what boot actually needs, this is what
// would catch it: PeerManagerListenerCeiling.test.js could stay green while
// this went red.

const path        = require('path');
const proxyquire  = require('proxyquire');
const { expect }  = require('chai');

const PeerManager = require('../../src/PeerManager.js');

describe('PeerManager: message listener ceiling, observed on a real hub boot', function () {
    this.timeout(30000);

    let XChainHub, mockDb, hub;

    before(function () {
        // Same swap-only-the-db pattern XChainHub.test.js uses: every other
        // module in the require tree, PeerManager included, is the real one.
        XChainHub = proxyquire('../../src/XChainHub', {
            './db': function () { return mockDb; }
        });
    });

    beforeEach(function () {
        // Every DB call any of the six start*() phases makes below, all answering
        // with "nothing configured yet" so each phase reaches its real
        // peerManager.on('message', ...) registration instead of throwing first.
        mockDb = {
            doQuery:               async () => [],
            setParam:               async () => {},
            setParams:               async () => 0,
            getConfig:               async () => ({}),
            getAllConfigs:           async () => ({}),
            createDatabase:          async () => true,
            verifyTables:            async () => true,
            runMigrations:           async () => true,
            close:                   async () => {},
            getValidators:           async () => [],
            getConfigRowsByModule:   async () => [],
            getChainPairValidators:  async () => ({}),
            getGovernanceHistory:    async () => [],
            getProviderGovernanceHistory: async () => [],
            getChainPairValidatorHistory: async () => [],
        };
    });

    afterEach(async function () {
        if (hub && hub.peerManager) {
            try { await hub.peerManager.close(); } catch (e) { /* best-effort teardown */ }
        }
        hub = null;
    });

    // Collect process warnings raised while `fn` runs, including the ones Node
    // defers past the synchronous EventEmitter.on() call that triggers them.
    async function warningsDuring(fn) {
        const seen = [];
        const onWarning = (w) => seen.push(w);
        process.on('warning', onWarning);
        try {
            await fn();
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
        } finally {
            process.removeListener('warning', onWarning);
        }
        return seen;
    }

    it('boots every real MESSAGE_SUBSCRIBERS module with no MaxListenersExceededWarning', async function () {
        hub = new XChainHub('host', 3306, 'db', 'user', 'pass', {
            P2P_PORT:            0,  // ephemeral; this test never dials out or accepts peers
            P2P_HOST:            '127.0.0.1',
            P2P_VALIDATOR_ADDR:  'ws://127.0.0.1:0',
            HUB_NETWORK:         'regtest',
            REQUIRE_SIGNATURES:  false,
            SEED_NODES:          [],
            ORACLE_EPOCH_START:      1704067200000, // 2024-01-01 UTC, same fixed value the e2e cluster fixture uses
            ORACLE_ROUND_INTERVAL:   999999999,      // no auto-round timer during this test
            ORACLE_SUBMISSION_WINDOW: 2000,
        });

        const warnings = await warningsDuring(async () => {
            await hub.start();
            await hub.startP2P();
            await hub.startConsensus();
            await hub.startOracle();
            await hub.startAttestation();
            await hub.startCrossChain();
            await hub.startReorgHandler();
            await hub.startGovernance();
        });

        const exceeded = warnings.filter((w) => w.name === 'MaxListenersExceededWarning');
        expect(exceeded.map((w) => w.message)).to.deep.equal([],
            'a real boot must not print MaxListenersExceededWarning');

        // The point of running the real boot rather than the synthetic roster test:
        // confirm the roster is not just declared correctly but ACTUALLY exercised,
        // one real handler per real subscriber, same invariant as the synthetic test.
        expect(hub.peerManager.listenerCount('message')).to.equal(PeerManager.MESSAGE_SUBSCRIBERS.length);
    });
});
