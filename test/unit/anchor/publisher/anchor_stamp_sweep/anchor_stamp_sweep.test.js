'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const stateCheckpointQueries = require('../../../../../src/db/state_checkpoints');
const { waitUntil } = require('../../../../helpers/waitUntil');

const OWN_TXID = 'ab'.repeat(32);
const PEER_TXID = 'cd'.repeat(32);

function buildPublisher(options){
    options = options || {};
    const rows = options.rows || [{
        chain: 'BTC', network: 'regtest', block_index: 900,
        checkpoint_seq: 100, txid: OWN_TXID, sent_doge_height: 100
    }];
    const checkpoint = {
        chain: 'BTC', network: 'regtest', block_index: 900,
        checkpoint_seq: 100, anchor_txid: OWN_TXID
    };
    const calls = { bounds: [], statuses: [], clears: [], queries: [] };
    const db = {
        async findOwnAnchorCheckpointStamps(bound){
            calls.bounds.push(bound);
            if(options.replaceStampAfterRead) checkpoint.anchor_txid = options.replaceStampAfterRead;
            return rows;
        },
        async updateStateCheckpointClearStamp(txid, chain, network, blockIndex, checkpointSeq){
            calls.clears.push({ txid, chain, network, blockIndex, checkpointSeq });
            return stateCheckpointQueries.updateStateCheckpointClearStamp.call(
                db, txid, chain, network, blockIndex, checkpointSeq);
        },
        async doQuery(sql, params){
            calls.queries.push({ sql, params });
            const matchesCheckpoint = checkpoint.chain === params[0] &&
                checkpoint.network === params[1] && checkpoint.block_index === params[2] &&
                checkpoint.checkpoint_seq === params[3];
            const matchesStamp = !sql.includes('AND anchor_txid = ?') ||
                checkpoint.anchor_txid === params[4];
            if(matchesCheckpoint && matchesStamp) checkpoint.anchor_txid = null;
            return { affectedRows: matchesCheckpoint && matchesStamp ? 1 : 0 };
        }
    };
    const pub = new StateAnchorPublisher({ db, p2pConfig: {} });
    pub.anchorStampReorgDepth = 10;
    pub.encoder = {
        async getTxStatus(txid){
            calls.statuses.push(txid);
            if(options.statusError) throw options.statusError;
            return { status: options.status || 'unknown' };
        }
    };
    pub.indexerCall = async (coin, method, params) => {
        expect({ coin, method, params }).to.deep.equal({ coin: 'DOGE', method: 'getlatestblock', params: {} });
        return { block_index: options.tip === undefined ? 110 : options.tip };
    };
    return { pub, calls, checkpoint };
}

describe('StateAnchorPublisher anchor stamp sweep', function () {
    it('tip short of REORG_MAX_DEPTH keeps the stamp without a transaction lookup', async function () {
        const { pub, calls } = buildPublisher({ tip: 9 });

        expect(await pub.sweepAnchorStamps()).to.equal(0);
        expect(calls.bounds).to.deep.equal([]);
        expect(calls.statuses).to.deep.equal([]);
        expect(calls.clears).to.deep.equal([]);
    });

    it('mempool transaction keeps the own stamp after the burial horizon', async function () {
        const { pub, calls } = buildPublisher({ status: 'mempool' });

        expect(await pub.sweepAnchorStamps()).to.equal(0);
        expect(calls.bounds).to.deep.equal([100]);
        expect(calls.statuses).to.deep.equal([OWN_TXID]);
        expect(calls.clears).to.deep.equal([]);
    });

    it('chain transaction keeps the own stamp after the burial horizon', async function () {
        const { pub, calls } = buildPublisher({ status: 'chain' });

        expect(await pub.sweepAnchorStamps()).to.equal(0);
        expect(calls.clears).to.deep.equal([]);
    });

    it('lookup fails closed and keeps the own stamp', async function () {
        const { pub, calls } = buildPublisher({ statusError: new Error('encoder unavailable') });

        expect(await pub.sweepAnchorStamps()).to.equal(0);
        expect(calls.clears).to.deep.equal([]);
    });

    it('peer stamp replacing the own txid is not cleared', async function () {
        const { pub, calls, checkpoint } = buildPublisher({ replaceStampAfterRead: PEER_TXID });

        expect(await pub.sweepAnchorStamps()).to.equal(0);
        expect(calls.clears).to.have.length(1);
        expect(calls.clears[0].txid).to.equal(OWN_TXID);
        expect(calls.queries).to.have.length(1);
        expect(calls.queries[0].params).to.deep.equal([
            'BTC', 'regtest', 900, 100, OWN_TXID
        ]);
        expect(checkpoint.anchor_txid).to.equal(PEER_TXID);
    });

    it('clears an own stamp when the transaction is unknown at the exact burial boundary', async function () {
        const { pub, calls } = buildPublisher();

        expect(await pub.sweepAnchorStamps()).to.equal(1);
        expect(calls.clears).to.deep.equal([{
            txid: OWN_TXID, chain: 'BTC', network: 'regtest', blockIndex: 900, checkpointSeq: 100
        }]);
    });
});

// One stamp row per txid, numbered so their order is easy to read back.
function stampRows(count, sectionsPerTxid){
    const rows = [];
    for(let i = 0; i < count; i++){
        const txid = String(i).padStart(2, '0').repeat(32);
        for(let s = 0; s < (sectionsPerTxid || 1); s++){
            rows.push({ chain: 'BTC', network: 'regtest', block_index: 900 + s,
                        checkpoint_seq: 100 + i * 10 + s, txid, sent_doge_height: 100 });
        }
    }
    return rows;
}

describe('StateAnchorPublisher anchor stamp sweep bounds', function () {
    this.timeout(5000);

    it('a hung encoder cannot hold the sweep past its time budget', async function () {
        const { pub, calls } = buildPublisher({ rows: stampRows(40), status: 'mempool' });
        pub.encoder.getTxStatus = async (txid) => { calls.statuses.push(txid); return new Promise(() => {}); };
        pub.anchorStampSweepBudgetMs = 50;

        const started = Date.now();
        expect(await pub.sweepAnchorStamps()).to.equal(0);
        expect(Date.now() - started, 'sweep returned within its budget').to.be.below(1000);
        expect(calls.statuses).to.have.length(1);
        expect(calls.clears).to.deep.equal([]);
    });

    it('a slow encoder stops the sweep at its budget instead of walking every row', async function () {
        const { pub, calls } = buildPublisher({ rows: stampRows(40), status: 'mempool' });
        pub.encoder.getTxStatus = async (txid) => {
            calls.statuses.push(txid);
            const readyAt = Date.now() + 20;
            await waitUntil(() => Date.now() >= readyAt, {
                intervalMs: 2,
                timeoutMs: 100,
                label: 'slow encoder response'
            });
            return { status: 'mempool' };
        };
        pub.anchorStampSweepBudgetMs = 100;
        pub.anchorStampSweepMaxLookups = 1000;

        const started = Date.now();
        await pub.sweepAnchorStamps();
        expect(Date.now() - started).to.be.below(1000);
        expect(calls.statuses.length).to.be.below(40);
    });

    it('caps the lookups per sweep and later sweeps cover the remaining transactions', async function () {
        const rows = stampRows(5);
        const { pub, calls } = buildPublisher({ rows, status: 'mempool' });
        pub.anchorStampSweepMaxLookups = 2;
        const txids = rows.map(r => r.txid);

        await pub.sweepAnchorStamps();
        expect(calls.statuses).to.deep.equal([txids[0], txids[1]]);
        await pub.sweepAnchorStamps();
        expect(calls.statuses.slice(2)).to.deep.equal([txids[2], txids[3]]);
        await pub.sweepAnchorStamps();
        expect(calls.statuses.slice(4)).to.deep.equal([txids[4], txids[0]]);
    });

    it('looks a bundle txid up once and clears every section it stamps', async function () {
        const { pub, calls } = buildPublisher({ rows: stampRows(1, 3) });

        await pub.sweepAnchorStamps();
        expect(calls.statuses).to.have.length(1);
        expect(calls.clears.map(c => c.checkpointSeq)).to.deep.equal([100, 101, 102]);
    });
});

describe('StateAnchorPublisher flush latch under a slow anchor stamp sweep', function () {
    this.timeout(5000);

    it('a hung encoder does not hold the flush latch, and a skipped tick is counted', async function () {
        const { pub, calls } = buildPublisher({ rows: stampRows(40) });
        pub.encoder.getTxStatus = async (txid) => { calls.statuses.push(txid); return new Promise(() => {}); };
        pub.anchorStampSweepBudgetMs = 50;
        pub.network = 'regtest';
        pub.drainDeferredAnnouncements = async () => {};
        pub.flushRefusal = async () => ({ anchored: [], archive: 'none', skipped: 'test_stop' });

        const first = pub.flush();
        const second = await pub.flush();
        expect(second.skipped).to.equal('already_flushing');
        expect(pub.getAnchorStats().flushesSkippedInFlight).to.equal(1);

        const started = Date.now();
        expect((await first).skipped).to.equal('test_stop');
        expect(Date.now() - started).to.be.below(1000);
        expect(pub._flushing).to.equal(false);
        expect((await pub.flush()).skipped).to.equal('test_stop');
    });
});
