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
// StateAnchorPublisher: the start() and flush() guards (ANCHOR_ENABLED, the
// re-entry guard, no pipeline, the low-balance warning), the batchSize flush
// trigger, and network-scoped checkpoint selection.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const { waitUntil }         = require('../helpers/waitUntil');
const { CP_ROW, buildMesh, startAll, registerMeshHooks } = require('../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerFlushGuardCases();
    registerSizeTriggerCase();
    registerNetworkScopedSelection();
});

// start() and flush() guards.
function registerFlushGuardCases() {
    it('ANCHOR_ENABLED=false: start() is a no-op (no message handler wired)', async function () {
        let bus = buildMesh(1, { cfg: { ANCHOR_ENABLED: 'false' } });
        let nd = bus.nodes[0];
        await nd.pub.start();
        expect(nd.pub._messageHandler, 'message handler stays null when disabled').to.be.null;
        expect(nd.handler, 'peerManager.on(message) not wired when disabled').to.be.null;
    });

    it('flush() guards re-entry: a second flush while one is in flight is skipped', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub._flushing = true;                                   // an in-flight flush holds the latch
        let res = await nd.pub.flush();
        expect(res.skipped).to.equal('already_flushing');
        expect(nd.published.length, 'nothing published by the re-entrant call').to.equal(0);
    });

    it('flush() skips with no_pipeline when no broadcast pipeline is configured', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub.setBroadcastHook(null);                             // drop the only signer path
        let res = await nd.pub.flush();
        expect(res.skipped).to.equal('no_pipeline');
        expect(nd.published.length).to.equal(0);
    });

    it('low DOGE balance emits a LOW-balance warning during flush', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub.setBalanceHook(async () => 0.5);                    // below the default 10 DOGE threshold
        let warned = [];
        let orig = console.warn;
        console.warn = (...a) => warned.push(a.join(' '));
        try { await nd.pub.flush(); } finally { console.warn = orig; }
        expect(warned.some(w => /balance LOW/i.test(w)), 'a LOW-balance warning fired').to.be.true;
    });
}

// Reaching batchSize match:finalized events fires a flush.
function registerSizeTriggerCase() {
    it('size-trigger: reaching batchSize match:finalized events fires a flush', async function () {
        let EventEmitter = require('events');
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let dex = new EventEmitter();
        nd.pub.hub.crossChainDex = dex;                           // wired into the match:finalized listener at start()
        nd.pub.batchSize = 2;
        nd.pub._pendingMatches = 0;

        let flushes = 0;
        let origFlush = nd.pub.flush.bind(nd.pub);
        nd.pub.flush = async () => { flushes++; return origFlush(); };
        await nd.pub.start();

        dex.emit('match:finalized');                             // 1 < batchSize → no flush
        await waitUntil(() => nd.pub._pendingMatches === 1, { label: 'the first match:finalized event to be counted' });
        expect(flushes, 'one event below batchSize does not flush').to.equal(0);

        dex.emit('match:finalized');                             // 2 >= batchSize → flush
        await waitUntil(() => flushes > 0, { label: 'reaching batchSize to trigger a flush' });
        expect(flushes, 'reaching batchSize triggers a flush').to.be.greaterThan(0);
    });
}

// Findings 1206 / 1207: with a configured hub network, the v0 pending-anchor
// selector and the archive wrapper-checkpoint selector are both scoped to
// this.network, so a leftover row from a prior-network deployment can never be
// re-anchored (1206) nor become the archive wrapper (1207).
function registerNetworkScopedSelection() {
    describe('network-scoped checkpoint selection (findings 1206 / 1207)', function () {
        // Isolate the network SCOPING from the stake-weighted quorum machinery:
        // configuring a regtest network would otherwise flip weighted quorum on and
        // pull in getWeightSnapshot wiring the mesh hub does not provide. Pin the
        // regtest activation dormant so the flow uses the legacy count path.
        const swqMod = require('../../src/stake_weighted_quorum.js');
        let savedSwqRegtest;
        beforeEach(function () {
            savedSwqRegtest = swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest;
            swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = 999999999;
        });
        afterEach(function () {
            swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = savedSwqRegtest;
        });

        it('does NOT select an unanchored checkpoint on a DIFFERENT network for anchoring (1206)', async function () {
            let bus = buildMesh(1);
            let nd = bus.nodes[0];
            nd.pub.network = 'regtest';                          // hub configured for regtest
            // A leftover unanchored checkpoint from a dead 'mainnet' deployment.
            nd.db.checkpoints.push(Object.assign({}, CP_ROW, {
                id: 99, network: 'mainnet', block_index: 777, anchor_txid: null
            }));
            await startAll(bus);

            let res = await nd.pub.flush();

            expect(res.anchored.length, 'only the regtest checkpoint is anchored').to.equal(1);
            expect(res.anchored[0]).to.include({ chain: 'BTC', network: 'regtest', block_index: 494 });
            expect(res.anchored.some(a => a.network === 'mainnet'),
                'the foreign-network row is never selected').to.equal(false);
        });

        it('selects only the matching-network wrapper checkpoint for the archive round (1207)', async function () {
            let bus = buildMesh(1);
            let nd = bus.nodes[0];
            nd.pub.network = 'regtest';
            // A foreign-network BTC checkpoint with a HIGHER id: the unscoped
            // "ORDER BY (chain='BTC') DESC, id DESC" would prefer it as the wrapper.
            nd.db.checkpoints.push(Object.assign({}, CP_ROW, {
                id: 99, network: 'mainnet', block_index: 777, anchor_txid: null
            }));
            // Capture the network the archive is built for (arg 0 of buildArchive).
            let capturedNetwork = null;
            let origBuild = nd.pub.buildArchive.bind(nd.pub);
            nd.pub.buildArchive = async (network, ...rest) => {
                capturedNetwork = network;
                return origBuild(network, ...rest);
            };
            await startAll(bus);

            let res = await nd.pub.flush();

            expect(res.archive, 'archive round published').to.equal('published');
            expect(capturedNetwork, 'wrapper checkpoint is network-scoped to regtest').to.equal('regtest');
        });
    });
}
