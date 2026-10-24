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

// Pins the repeat-publish guard: a leader whose last complete archive left its rows
// pending (the stamps did not take) does not pay DOGE to publish the same row set
// again, while a new row, a changed row or a partial publish still re-archives.

const { expect }      = require('chai');
const roundMethods    = require('../../../../../../src/anchor/publisher/archive/round.js');
const publishMethods  = require('../../../../../../src/anchor/publisher/archive/publish.js');

function emptyRows(){
    return { matches: [], calls: [], rewards: [], bridges: [], policies: [], lists: [],
             checkpoints: [], prices: [], tombstones: [], cappedOrTrimmed: false };
}

// One leader over a single-member set, so a flush publishes without a peer round. The
// back-fill records what it would stamp but stamps nothing, which is the rail fault:
// every gather after a complete publish returns the same pending rows.
function leader(pending, opts){
    const o = opts || {};
    const sent = [];
    let nextSeq = 151;
    const pub = Object.assign({}, roundMethods, publishMethods, {
        identity: { getPubkeyHex: () => 'aa', sign: () => 'sig' },
        network: 'regtest',
        getActiveOraclePublishPubkeys: async () => ['aa'],
        getArchivePublishPubkeys: async () => ['aa'],   // regtest elects on archive_publish
        gatherArchiveRows: async () => {
            const rows = emptyRows();
            for(const key of Object.keys(pending)) rows[key] = pending[key].map(r => Object.assign({}, r));
            return rows;
        },
        latestArchiveWrapperRows: async () => [{ network: 'regtest' }],
        cpFromRow: () => ({ chain: 'BTC', network: 'regtest', block_index: 6486,
                            checkpoint_seq: 6492, snapshot_block: 6492 }),
        getLiveArchiveIntent: async () => null,
        archiveRoundIntentHeld: () => false,
        anchorIntentHolds: () => false,
        getNextBatchSeq: async () => nextSeq,
        leaderBatchSeqAboveOwn: async seq => seq,
        resolveArchiveRewardSources: async () => [],
        archiveEmptyAfterResolution: () => false,
        buildSizedArchive: async () => ({ json: '{}', count: 0 }),
        archiveRankLocked: () => false,
        archiveWire: () => ({ crc: '00000000', b64: '', chunks: ['c0'] }),
        archiveCanonical: () => 'canonical',
        archiveSigningSet: async () => [{ pubkey: 'aa', amount: '1', source: '' }],
        collectArchiveAttestation: async () => ({ attested: false, sigs: [] }),
        archiveHeadPayload: () => 'head',
        sendArchiveHead: async (_network, round) => {
            sent.push(round.batchSeq);
            nextSeq = round.batchSeq + 1;
            return { txid: 'tx' + round.batchSeq };
        },
        markArchiveSent: async () => {},
        notePendingConfirmation: () => {},
        noteOwnArchiveSeq: () => {},
        broadcastArchiveChunks: async () => (o.lostChunks || 0),
        archiveOnChainValid: () => true,
        backfillBatch: async () => {},
        settleArchiveIntent: async () => {},
        announceArchiveFinalized: () => {},
        recordArchivePublish: () => {}
    });
    return { pub, sent, flush: () => pub.startArchiveRound({ broadcastFn: async () => ({}) }, 6496, false) };
}

describe('archive leader does not republish an unchanged row set', function(){

    it('publishes once across two flushes that gather the same rows', async function(){
        const pending = { checkpoints: [{ chain: 'BTC', network: 'regtest', checkpoint_seq: 6492 }] };
        const { sent, flush } = leader(pending);
        expect(await flush()).to.equal('published');
        expect(await flush()).to.equal('none');
        expect(sent).to.deep.equal([151]);
    });

    it('publishes again when a new row joins the pending set', async function(){
        const pending = { checkpoints: [{ chain: 'BTC', network: 'regtest', checkpoint_seq: 6492 }] };
        const { sent, flush } = leader(pending);
        expect(await flush()).to.equal('published');
        pending.checkpoints.push({ chain: 'BTC', network: 'regtest', checkpoint_seq: 6498 });
        expect(await flush()).to.equal('published');
        expect(sent).to.deep.equal([151, 152]);
    });

    it('publishes again when a pending price row changes in place', async function(){
        const price = { round_number: 124757, coin_pair: 'BTC/USD', status: 'finalized',
                        batch_block_time: 0, consensus_proof: 'proof-a' };
        const pending = { prices: [price] };
        const { sent, flush } = leader(pending);
        expect(await flush()).to.equal('published');
        price.batch_block_time = 1761000000;
        expect(await flush()).to.equal('published');
        expect(sent).to.deep.equal([151, 152]);
    });

    it('re-archives the same rows after a partial publish', async function(){
        const pending = { checkpoints: [{ chain: 'BTC', network: 'regtest', checkpoint_seq: 6492 }] };
        const { sent, flush } = leader(pending, { lostChunks: 1 });
        expect(await flush()).to.equal('published');
        expect(await flush()).to.equal('published');
        expect(sent).to.deep.equal([151, 152]);
    });
});
