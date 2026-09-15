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
// ReorgHandler: probeOwnNode(), the actual indexer probe behind self-node
// verification: the served-hash and network checks, the reorg-history gate on
// oldHash, the unrecorded-hash escape hatch, and verifyReorgAgainstOwnNode's
// error mapping and probe dedup.

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../src/anchor/reorg_handler');
const { createMockHub }     = require('../helpers/mockHub');

// A valid observed-hash pair for the R2-C2 wire format (distinct 64-hex).
const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);

// The handler under test and its mock hub, rebuilt by the hooks inside the
// ReorgHandler describe before every case.
let hub, pm, rh;

describe('ReorgHandler', function () {

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        rh  = new ReorgHandler(hub);
    });

    afterEach(function () {
        for (let [, pending] of rh.pendingReorgs) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        sinon.restore();
    });

    registerProbeOwnNode();
});

// -----------------------------------------------------------------
// probeOwnNode(): the actual indexer probe
// -----------------------------------------------------------------

// Default reorg history: OLD_HASH was orphaned at height 500 (the honest
// case). Individual tests override `hist` to exercise the oldHash gate.
function stubIndexer(tip, at, hist) {
    if (hist === undefined)
        hist = { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: OLD_HASH }] }], count: 1, matched: true };
    return sinon.stub(rh, '_indexerCall').callsFake(async (coin, method, params) => {
        if (method === 'getreorghistory') return hist;
        if (params && params.block_index != null) return at;
        return tip;
    });
}

function registerProbeOwnNode() {
    describe('probeOwnNode()', function () {

        beforeEach(function () {
            rh.indexers.BTC = { url: 'http://btc-indexer.test', key: '' };
            rh.network = 'regtest';
        });

        registerProbeServedHashCases();
        registerProbeReorgHistoryCases();
        registerProbeEscapeHatchCases();
        registerProbeFailureCases();
    });
}

// The endpoint, served-hash, tip-bound, depth and network checks.
function registerProbeServedHashCases() {
    it('abstains (false) without an indexer endpoint', async function () {
        rh.indexers.BTC = { url: '', key: '' };
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('confirms when the node serves newHash at reorgHeight on the right network', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' });
        let r = await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
        expect(r).to.be.ok;
        expect(r.blockTimeMs, 'no block_time served → null anchor (legacy bound)').to.equal(null);
    });

    it('captures the served block_time (seconds) as the ms rollback anchor', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest', block_time: 1700000000 });
        let r = await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
        expect(r).to.be.ok;
        expect(r.blockTimeMs).to.equal(1700000000000);
    });

    it('abstains while the node still serves the pre-reorg hash (lagging sync)', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: OLD_HASH, network: 'regtest' });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('rejects a reorgHeight above the own tip', async function () {
        let ic = stubIndexer({ block_index: 400, block_hash: 'f'.repeat(64), network: 'regtest' }, null);
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        expect(ic.callCount, 'no second call past the tip bound').to.equal(1);
    });

    it('rejects a reorgHeight deeper than REORG_MAX_DEPTH below the tip', async function () {
        rh.maxReorgDepth = 100;
        let ic = stubIndexer({ block_index: 1000, block_hash: 'f'.repeat(64), network: 'regtest' }, null);
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        expect(ic.callCount).to.equal(1);
    });

    it('rejects a cross-network (or network-agnostic) answer', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'mainnet' });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;

        sinon.restore();
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('reuses the tip response when reorgHeight IS the tip (single getblockhashes RPC)', async function () {
        let ic = stubIndexer({ block_index: 500, block_hash: NEW_HASH, network: 'regtest' }, null);
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.ok;
        expect(ic.getCalls().filter(c => c.args[1] === 'getblockhashes').length).to.equal(1);
    });
}

// The reorg-history gate on oldHash, including the unrecorded (null) hash case.
function registerProbeReorgHistoryCases() {
    // REORG-OLDHASH-UNVERIFIED-1: the "before" half of the reorg.
    it('abstains when reorg history has no event orphaning oldHash at reorgHeight (fabricated oldHash)', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [], count: 0, matched: false });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('abstains when a reorg at that height orphaned a DIFFERENT hash', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: 'c'.repeat(64) }] }], count: 1 });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('abstains when the orphaned-hash match is at a DIFFERENT height in the same event', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [{ id: 1, blocks: [{ block_index: 501, block_hash: OLD_HASH }] }], count: 1 });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    // this case once accepted (fail open). It now abstains. An unrecorded
    // hash means this node cannot check the claim, and accepting it reduced the
    // verification to "some reorg happened at this height", which is enough
    // to re-open the divergent-digest mode. Measured reachable on mainnet
    // (DOGE 6280198 + 6279100, LTC 3137602), so this is a live path, not a retired one.
    it('ABSTAINS when the REORG event at that height has an unrecorded (null) hash', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: null }] }], count: 1 });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('still confirms when ANOTHER event records the real hash for the same height', async function () {
        // The null entry must not short-circuit the scan: a later event carrying the
        // actual orphaned hash is a genuine confirmation and has to survive the fix.
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [{ id: 2, blocks: [{ block_index: 500, block_hash: null }] },
                               { id: 1, blocks: [{ block_index: 500, block_hash: OLD_HASH }] }], count: 2 });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.ok;
    });

    it('a null hash does not launder a WRONG oldHash into a confirmation', async function () {
        // The attack the fail-open enabled: claim any oldHash at a height whose real
        // orphaned hash was never recorded.
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: null }] }], count: 1 });
        expect(await rh.probeOwnNode('BTC', 500, 'a'.repeat(64), NEW_HASH)).to.be.false;
    });
}

// The REORG_ALLOW_UNRECORDED_OLDHASH escape hatch and case-insensitive matching.
function registerProbeEscapeHatchCases() {
    it('REORG_ALLOW_UNRECORDED_OLDHASH=1 restores the old fail-open, and warns', async function () {
        let warn = sinon.stub(console, 'warn');
        process.env.REORG_ALLOW_UNRECORDED_OLDHASH = '1';
        try {
            stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                        { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                        { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: null }] }], count: 1 });
            expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.ok;
            expect(warn.getCalls().some(c => /UNVERIFIED oldHash/.test(String(c.args[0]))),
                'the escape hatch is loud about what it is doing').to.equal(true);
        } finally {
            delete process.env.REORG_ALLOW_UNRECORDED_OLDHASH;
            warn.restore();
        }
    });

    it('the escape hatch is OFF by default (no env set means abstain)', async function () {
        expect(process.env.REORG_ALLOW_UNRECORDED_OLDHASH, 'no ambient opt-in').to.be.undefined;
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: null }] }], count: 1 });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('matches an uppercase recorded orphaned hash case-insensitively', async function () {
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { events: [{ id: 1, blocks: [{ block_index: 500, block_hash: OLD_HASH.toUpperCase() }] }], count: 1 });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.ok;
    });
}

// Probe failures map to abstain, and concurrent probes for one observation dedupe.
function registerProbeFailureCases() {
    it('abstains (never throws) when getreorghistory errors or is unsupported', async function () {
        // App-level error shape ({error}) from an indexer without a ready decoder DB.
        stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                    { block_index: 500, block_hash: NEW_HASH, network: 'regtest' },
                    { error: 'decoder database not ready' });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;

        // RPC rejection (e.g. an indexer predating getreorghistory).
        sinon.restore();
        sinon.stub(rh, '_indexerCall').callsFake(async (coin, method) => {
            if (method === 'getreorghistory') throw new Error('indexer RPC error: method not found');
            return { block_index: 500, block_hash: NEW_HASH, network: 'regtest' };
        });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('skips the reorg-history probe entirely when the served hash already mismatches', async function () {
        let ic = stubIndexer({ block_index: 600, block_hash: 'f'.repeat(64), network: 'regtest' },
                             { block_index: 500, block_hash: OLD_HASH, network: 'regtest' });
        expect(await rh.probeOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
        expect(ic.getCalls().some(c => c.args[1] === 'getreorghistory')).to.be.false;
    });

    it('verifyReorgAgainstOwnNode maps an RPC error to abstain (false), never a throw', async function () {
        sinon.stub(rh, '_indexerCall').rejects(new Error('ECONNREFUSED'));
        expect(await rh.verifyReorgAgainstOwnNode('BTC', 500, OLD_HASH, NEW_HASH)).to.be.false;
    });

    it('verifyReorgAgainstOwnNode dedupes concurrent probes for the same observation', async function () {
        let resolveProbe;
        sinon.stub(rh, 'probeOwnNode').callsFake(() => new Promise(res => { resolveProbe = res; }));
        let p1 = rh.verifyReorgAgainstOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
        let p2 = rh.verifyReorgAgainstOwnNode('BTC', 500, OLD_HASH, NEW_HASH);
        resolveProbe(true);
        expect(await p1).to.be.true;
        expect(await p2).to.be.true;
        expect(rh.probeOwnNode.callCount).to.equal(1);
    });
}
