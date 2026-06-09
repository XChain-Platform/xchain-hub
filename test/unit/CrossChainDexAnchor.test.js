'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon              = require('sinon');
const { expect }         = require('chai');
const crypto             = require('crypto');
const EventEmitter       = require('events');
const CrossChainDexAnchor = require('../../src/CrossChainDexAnchor');
const MerkleTree         = require('../../src/MerkleTree');

// Build a hub with a stubbed DB, identity, a crossChainDex (EventEmitter with a
// deterministic _canonicalMatch), and a BTC tip resolver.
function makeAnchorHub(overrides) {
    overrides = overrides || {};
    let dex = new EventEmitter();
    dex._canonicalMatch = (r) => 'C|' + r.match_id;     // deterministic leaf preimage
    let hub = {
        db: overrides.db || { doQuery: sinon.stub().resolves([]) },
        p2pConfig: overrides.p2pConfig || {},
        getIdentity: () => ({ getPubkeyHex: () => (overrides.pubkey || 'aa'.repeat(32)) }),
        crossChainDex: dex,
        capabilitySnapshot: overrides.capabilitySnapshot !== undefined ? overrides.capabilitySnapshot : null,
        capabilityRegistry: overrides.capabilityRegistry || null,
        _resolveBtcLatestBlock: overrides._resolveBtcLatestBlock || (async () => 1000)
    };
    return hub;
}

function matchRow(id) { return { match_id: id, status: 'finalized', batch_root: null }; }
function expectedRoot(ids) {
    let leaves = ids.slice().sort().map(id => crypto.createHash('sha256').update('C|' + id).digest('hex'));
    return MerkleTree.root(leaves);
}

describe('CrossChainDexAnchor', function () {

    afterEach(function () { sinon.restore(); });

    describe('constructor', function () {
        it('uses default batch size and interval', function () {
            let a = new CrossChainDexAnchor(makeAnchorHub());
            expect(a.batchSize).to.equal(64);
            expect(a.intervalMs).to.equal(1800000);
        });
        it('reads XDEX_ANCHOR_BATCH_SIZE from config', function () {
            let a = new CrossChainDexAnchor(makeAnchorHub({ p2pConfig: { XDEX_ANCHOR_BATCH_SIZE: '5' } }));
            expect(a.batchSize).to.equal(5);
        });
    });

    describe('hooks', function () {
        it('stores the broadcast hook', function () {
            let a = new CrossChainDexAnchor(makeAnchorHub());
            let fn = () => {};
            a.setBroadcastHook(fn);
            expect(a.broadcastFn).to.equal(fn);
        });
    });

    describe('onMatchFinalized()', function () {
        it('flushes once the pending count reaches batchSize', async function () {
            let a = new CrossChainDexAnchor(makeAnchorHub({ p2pConfig: { XDEX_ANCHOR_BATCH_SIZE: '2' } }));
            let flush = sinon.stub(a, 'flush').resolves();
            await a.onMatchFinalized({ matchId: 'm1' });
            expect(flush.called).to.be.false;
            await a.onMatchFinalized({ matchId: 'm2' });
            expect(flush.calledOnce).to.be.true;
        });
    });

    describe('flush()', function () {
        it('no unanchored matches → no broadcast, no update', async function () {
            let hub = makeAnchorHub();
            hub.db.doQuery = sinon.stub().resolves([]);          // SELECT returns nothing
            let a = new CrossChainDexAnchor(hub);
            let bc = sinon.stub().resolves({ txid: 'x' });
            a.setBroadcastHook(bc);
            await a.flush();
            expect(bc.called).to.be.false;
            expect(hub.db.doQuery.calledWithMatch(/UPDATE cross_chain_matches/)).to.be.false;
        });

        it('anchors the batch: builds the Merkle root, broadcasts the payload, back-fills batch_root/anchor_txid', async function () {
            let ids = ['ccc', 'aaa', 'bbb'];                      // unsorted; flush SELECT is ORDER BY match_id
            let rows = ids.slice().sort().map(matchRow);          // DB returns sorted
            let hub = makeAnchorHub();
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.withArgs(sinon.match(/SELECT \* FROM cross_chain_matches/)).resolves(rows);
            hub.db.doQuery.withArgs(sinon.match(/UPDATE cross_chain_matches/)).resolves([]);
            let a = new CrossChainDexAnchor(hub);
            let bc = sinon.stub().resolves({ txid: 'doge-tx-1' });
            a.setBroadcastHook(bc);

            await a.flush();

            let root = expectedRoot(ids);
            expect(bc.calledOnce).to.be.true;
            expect(bc.firstCall.args[0]).to.equal('XDEXANCHOR|0|' + root + '|3');

            let upd = hub.db.doQuery.getCalls().find(c => /UPDATE cross_chain_matches SET batch_root = \?, anchor_txid = \?/.test(c.args[0]));
            expect(upd, 'UPDATE issued').to.exist;
            expect(upd.args[1][0]).to.equal(root);               // batch_root
            expect(upd.args[1][1]).to.equal('doge-tx-1');        // anchor_txid
            expect(upd.args[1].slice(2).sort()).to.deep.equal(ids.slice().sort());  // match_id IN (...)
        });

        it('no DOGE pipeline configured → no-op (no broadcast, no update)', async function () {
            let hub = makeAnchorHub();
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.withArgs(sinon.match(/SELECT \* FROM cross_chain_matches/)).resolves([matchRow('aaa')]);
            let a = new CrossChainDexAnchor(hub);                 // no broadcastFn, no encoder, no walletSign
            await a.flush();
            expect(hub.db.doQuery.getCalls().some(c => /UPDATE/.test(c.args[0]))).to.be.false;
        });

        it('not the elected anchorer (oracle_publish set excludes this node) → does not broadcast', async function () {
            let hub = makeAnchorHub({
                capabilitySnapshot: { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: 'ff'.repeat(32) }] }) }
            });
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.withArgs(sinon.match(/SELECT \* FROM cross_chain_matches/)).resolves([matchRow('aaa')]);
            let a = new CrossChainDexAnchor(hub);
            let bc = sinon.stub().resolves({ txid: 'x' });
            a.setBroadcastHook(bc);
            await a.flush();
            expect(bc.called).to.be.false;
        });

        it('elected anchorer (oracle_publish set includes this node) → anchors', async function () {
            let hub = makeAnchorHub({
                pubkey: 'aa'.repeat(32),
                capabilitySnapshot: { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: 'aa'.repeat(32) }] }) }
            });
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.withArgs(sinon.match(/SELECT \* FROM cross_chain_matches/)).resolves([matchRow('aaa')]);
            hub.db.doQuery.withArgs(sinon.match(/UPDATE cross_chain_matches/)).resolves([]);
            let a = new CrossChainDexAnchor(hub);
            let bc = sinon.stub().resolves({ txid: 'doge-tx-2' });
            a.setBroadcastHook(bc);
            await a.flush();
            expect(bc.calledOnce).to.be.true;
        });
    });
});
