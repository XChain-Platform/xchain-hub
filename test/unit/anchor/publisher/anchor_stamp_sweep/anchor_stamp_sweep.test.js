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
