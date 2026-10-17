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
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

function checkpoint(){
    return { chain: 'BTC', network: 'regtest', block_index: 900, checkpoint_seq: 100 };
}

function recordingDb(){
    const seen = [];
    return {
        ...DB_METHODS,
        seen,
        async doQuery(sql, params){
            seen.push({ sql, params });
            return [];
        }
    };
}

function publisher(db){
    return new StateAnchorPublisher({ db, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
}

describe('StateAnchorPublisher: sent DOGE height', function () {
    it('reads getlatestblock after a send and stores its DOGE height with the marker', async function () {
        const db = recordingDb();
        const pub = publisher(db);
        const calls = [];
        pub.indexerCall = async (coin, method, params) => {
            calls.push({ coin, method, params });
            return { block_index: '54321' };
        };

        await pub.markAnchorSent(checkpoint(), 'doge-tx');

        expect(calls).to.deep.equal([{ coin: 'DOGE', method: 'getlatestblock', params: {} }]);
        expect(db.seen).to.have.length(1);
        expect(db.seen[0].sql).to.include('sent_doge_height = ?');
        expect(db.seen[0].params).to.deep.equal(['doge-tx', 54321, 'BTC', 'regtest', 100]);

        await db.findAnchorPublishedCheckpoints('BTC', 'regtest', 100);
        expect(db.seen[1].sql).to.include('sent_doge_height');
    });

    it('still confirms the marker with a NULL height when the DOGE tip is unavailable', async function () {
        const db = recordingDb();
        const pub = publisher(db);
        pub.indexerCall = async () => { throw new Error('indexer unavailable'); };

        await pub.markAnchorSent(checkpoint(), 'doge-tx');

        expect(db.seen).to.have.length(1);
        expect(db.seen[0].params).to.deep.equal(['doge-tx', null, 'BTC', 'regtest', 100]);
    });

    it('does not turn an empty getlatestblock result into height zero', async function () {
        const db = recordingDb();
        const pub = publisher(db);
        pub.indexerCall = async () => null;

        await pub.markAnchorSent(checkpoint(), 'doge-tx');

        expect(db.seen[0].params[1]).to.equal(null);
    });

    it('clears a prior send height when an expired intent is re-armed', async function () {
        const db = recordingDb();
        await db.setAnchorPublishedCheckpoint('BTC', 'regtest', 100);
        expect(db.seen[0].sql).to.include('sent_doge_height = NULL');
    });
});
