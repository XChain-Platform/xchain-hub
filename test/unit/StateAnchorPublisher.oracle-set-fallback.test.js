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

// The block-PINNED _getActiveOraclePublishPubkeys path must mirror
// _resolveCapabilitySet: primary source is the deterministic capability
// snapshot; on a miss, the local capability_snapshots table stands in ONLY on
// regtest (seeded stacks with no live snapshot resolution). Before the
// fallback existed, such a venue resolved an empty election set for every
// pinned election and the publisher anchored nothing, with no error anywhere.
// The residual empty-set abstain is still correct (fail closed), but it has
// to be loud, never silent.

const sinon      = require('sinon');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

const KEY_A = 'aa'.repeat(33);
const KEY_B = 'bb'.repeat(33);

function buildPub(opts) {
    opts = opts || {};
    let queried = { count: 0, params: null };
    let hub = {
        db: { async doQuery(sql, params) {
            queried.count++;
            queried.params = params;
            if (opts.dbThrows) throw new Error('db gone');
            return opts.rows || [];
        } },
        network: opts.network,
        capabilitySnapshot: opts.capabilitySnapshot,
        getIdentity: () => null,
        getPeerManager: () => null,
        p2pConfig: {}
    };
    return { pub: new StateAnchorPublisher(hub), queried };
}

// A snapshot resolver serving both the count and the weighted query shape.
function liveSnapshot() {
    return {
        async getSnapshot() { return { validators: [{ pubkey: KEY_B.toUpperCase() }, { pubkey: KEY_A }] }; },
        async getWeightSnapshot() { return { validators: [
            { pubkey: KEY_B.toUpperCase(), source: 's1', weight: '1' },
            { pubkey: KEY_B, source: 's2', weight: '2' },
            { pubkey: KEY_A, source: 's3', weight: '3' }
        ] }; }
    };
}

function deadSnapshot(kind) {
    if (kind === 'throws') {
        return { async getSnapshot() { throw new Error('indexer down'); },
                 async getWeightSnapshot() { throw new Error('indexer down'); } };
    }
    return { async getSnapshot() { return null; }, async getWeightSnapshot() { return null; } };
}

describe('StateAnchorPublisher._getActiveOraclePublishPubkeys local-table fallback', () => {

    let warn;
    beforeEach(() => { warn = sinon.stub(console, 'warn'); });
    afterEach(() => { sinon.restore(); });

    it('snapshot path up: resolves from the snapshot and never touches the local table', async () => {
        let { pub, queried } = buildPub({ network: 'regtest', capabilitySnapshot: liveSnapshot() });
        let set = await pub._getActiveOraclePublishPubkeys(100);
        expect(set, 'lowercased, deduped, sorted').to.deep.equal([KEY_A, KEY_B]);
        expect(queried.count).to.equal(0);
        expect(warn.called).to.equal(false);
    });

    it('snapshot down on regtest: falls back to the local capability_snapshots rows', async () => {
        let { pub, queried } = buildPub({
            network: 'regtest',
            capabilitySnapshot: deadSnapshot('null'),
            // Weighted persistence writes one row per (source, pubkey); the
            // election set must still see each key exactly once.
            rows: [{ signing_pubkey: KEY_B.toUpperCase() }, { signing_pubkey: KEY_B }, { signing_pubkey: KEY_A }]
        });
        let set = await pub._getActiveOraclePublishPubkeys(100);
        expect(set).to.deep.equal([KEY_A, KEY_B]);
        expect(queried.count).to.equal(1);
        expect(queried.params).to.deep.equal([100, 'oracle_publish']);
        expect(warn.called, 'a served fallback is not an outage').to.equal(false);
    });

    it('snapshot THROWING on regtest also reaches the fallback', async () => {
        let { pub, queried } = buildPub({
            network: 'regtest',
            capabilitySnapshot: deadSnapshot('throws'),
            rows: [{ signing_pubkey: KEY_A }]
        });
        let set = await pub._getActiveOraclePublishPubkeys(100);
        expect(set).to.deep.equal([KEY_A]);
        expect(queried.count).to.equal(1);
    });

    it('both down on regtest: abstains with an empty set, LOUDLY', async () => {
        let { pub, queried } = buildPub({
            network: 'regtest',
            capabilitySnapshot: deadSnapshot('throws'),
            rows: []
        });
        let set = await pub._getActiveOraclePublishPubkeys(100);
        expect(set).to.deep.equal([]);
        expect(queried.count).to.equal(1);
        expect(warn.calledOnce).to.equal(true);
        expect(warn.firstCall.args[0]).to.match(/oracle_publish membership unresolved at block 100/);
        expect(warn.firstCall.args[0], 'carries the underlying cause').to.match(/indexer down/);
    });

    it('a local-table failure on regtest is both-down too: loud empty abstain', async () => {
        let { pub } = buildPub({
            network: 'regtest',
            capabilitySnapshot: deadSnapshot('null'),
            dbThrows: true
        });
        expect(await pub._getActiveOraclePublishPubkeys(100)).to.deep.equal([]);
        expect(warn.calledOnce).to.equal(true);
        expect(warn.firstCall.args[0]).to.match(/db gone/);
    });

    it('off regtest the local table is NOT a source: no query, loud empty abstain', async () => {
        for (let network of ['mainnet', 'testnet']) {
            warn.resetHistory();
            let { pub, queried } = buildPub({
                network: network,
                capabilitySnapshot: deadSnapshot('null'),
                rows: [{ signing_pubkey: KEY_A }]
            });
            expect(await pub._getActiveOraclePublishPubkeys(100)).to.deep.equal([]);
            expect(queried.count, network + ' must never read the per-hub table').to.equal(0);
            expect(warn.calledOnce, network + ' abstain must be loud').to.equal(true);
            expect(warn.firstCall.args[0]).to.match(/regtest-only/);
        }
    });

    it('a legitimately EMPTY snapshot is a real answer: no fallback, no warning', async () => {
        let { pub, queried } = buildPub({
            network: 'regtest',
            capabilitySnapshot: { async getSnapshot() { return { validators: [] }; },
                                  async getWeightSnapshot() { return { validators: [] }; } },
            rows: [{ signing_pubkey: KEY_A }]
        });
        expect(await pub._getActiveOraclePublishPubkeys(100)).to.deep.equal([]);
        expect(queried.count).to.equal(0);
        expect(warn.called).to.equal(false);
    });

    it('the UNPINNED (blockIndex null) membership pre-filter is untouched', async () => {
        let { pub, queried } = buildPub({ network: 'regtest', capabilitySnapshot: deadSnapshot('null') });
        pub.hub.capabilityRegistry = { async getActiveValidators() { return [KEY_A.toUpperCase()]; } };
        expect(await pub._getActiveOraclePublishPubkeys(null)).to.deep.equal([KEY_A]);
        expect(queried.count).to.equal(0);
        expect(warn.called).to.equal(false);
    });
});
