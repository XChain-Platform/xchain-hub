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
//
// The archive leg of findExistingFoldedBundle asks getarchiveanchor the content-key
// question the indexer serves, and adopts only a reply in that handler's real shape.

const path = require('path');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');

const ARCHIVE_QUERY = path.resolve(__dirname,
    '../../../../../../xchain-indexer/src/actions/anchor/anchor_action_query/archive_query.js');
const TXID = 'AB'.repeat(32);
const SECTION = { chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 2 };
const ARCHIVE = { cp: Object.assign({ snapshot_block: 9 }, SECTION), batchSeq: 7, crc: '0A1B2C3D', count: 5, chunks: ['c0', 'c1'] };

// The reply buildArchiveAnchorResponse returns for a v3 folded head matching `params`.
function indexerReply(params, extra) {
    return Object.assign({
        coin: 'DOGE', network: 'regtest', exists: true, status: 'valid', version: 3, txid: TXID.toLowerCase(),
        author: params.author, checkpoint_chain: params.chain, checkpoint_network: params.network,
        block_index: params.block_index, checkpoint_seq: params.checkpoint_seq, snapshot_block: 9,
        match_batch_seq: 7, match_count: params.match_count, batch_crc32: params.batch_crc32,
        total_chunks: 2, chunks_present: [0], chunks_complete: false, block_index_doge: 50,
        latest_block_index: 50, confirmations: 1
    }, extra);
}

function publisher(archiveReply, address) {
    let pub = new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: address === undefined ? 'Dpub1' : address } });
    pub.indexers = { DOGE: { url: 'http://doge-indexer' } };
    pub.asked = [];
    pub.indexerCall = async (coin, method, params) => {
        pub.asked.push({ method, params });
        if (method === 'getanchoraction') return { exists: true, status: 'valid', version: 3, txid: TXID,
            checkpoint_chain: params.chain, checkpoint_network: params.network,
            block_index: params.block_index, checkpoint_seq: params.checkpoint_seq };
        return archiveReply(params);
    };
    return pub;
}

async function outcome(pub) {
    try { return { found: await pub.findExistingFoldedBundle([SECTION], ARCHIVE) }; }
    catch (error) { return { error }; }
}

describe('folded archive existence check', function () {
    it('asks the content key the indexer serves and adopts its real reply shape', async function () {
        let pub = publisher(params => indexerReply(params));
        let { found } = await outcome(pub);
        expect(found).to.deep.equal({ exists: true, txid: TXID.toLowerCase(), version: 3 });
        let asked = pub.asked.find(a => a.method === 'getarchiveanchor').params;
        expect(asked).to.deep.equal({ chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 2,
                                      batch_crc32: '0a1b2c3d', match_count: 5, author: 'Dpub1' });
    });

    it('is routed by the indexer as a content lookup, never the author-only sequence read', function () {
        if (!skipOrFail(this, siblingCheckout(__dirname, ARCHIVE_QUERY), 'the indexer archive query contract')) return;
        const { validateArchiveAnchorParams } = require(ARCHIVE_QUERY);
        let pub = publisher(params => indexerReply(params));
        return outcome(pub).then(() => {
            let v = validateArchiveAnchorParams(pub.asked.find(a => a.method === 'getarchiveanchor').params);
            expect(v.ok).to.equal(true);
            expect(v.author_only).to.equal(undefined);
        });
    });

    it('never adopts an author-only sequence reply', async function () {
        let { found, error } = await outcome(publisher(() => ({ exists: true, match_batch_seq: 7 })));
        expect(found === null || found === undefined, 'not adopted').to.equal(true);
        expect(error, 'undetermined').to.be.an('error');
        let absent = await outcome(publisher(() => ({ exists: false, match_batch_seq: null })));
        expect(absent.found).to.equal(null);
    });

    it('treats any mismatching reply attribute as undetermined', async function () {
        let cases = [['checkpoint_chain', 'LTC'], ['checkpoint_network', 'mainnet'], ['block_index', 3],
            ['checkpoint_seq', 9], ['batch_crc32', 'ffffffff'], ['match_count', 6], ['total_chunks', 1],
            ['match_batch_seq', 8], ['author', 'Dother']];
        for (let [field, value] of cases) {
            let { error } = await outcome(publisher(params => indexerReply(params, { [field]: value })));
            expect(error, field).to.be.an('error');
        }
        let noTxid = await outcome(publisher(params => indexerReply(params, { txid: null })));
        expect(noTxid.found, 'a head with no txid cannot be adopted').to.equal(null);
    });

    it('refuses an unscoped lookup when this hub has no DOGE address', async function () {
        let pub = publisher(params => indexerReply(params), '');
        let { error } = await outcome(pub);
        expect(error).to.be.an('error');
        expect(pub.asked.some(a => a.method === 'getarchiveanchor')).to.equal(false);
    });
});
