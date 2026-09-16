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

// durable at-most-once for the checkpoint-anchor spend. The existence
// check reads MINED indexer state, so a crash between an accepted-but-unmined broadcast
// and the `anchor_txid` stamp once left nothing recording that DOGE had paid, and
// the next flush rebuilt a fresh PSBT from different UTXOs (a second fee, two anchors
// that can both confirm). These pin the anchor_published_checkpoints marker: the hold,
// the mined-anchor fall-through, the TTL bound, and the withdraw/keep split between a
// definitive pre-send failure and an ambiguous send.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

// A db double that routes by SQL shape and records every statement it saw.
function mkDb(opts){
    opts = opts || {};
    const seen = [];
    return { ...DB_METHODS,
        seen: seen,
        async doQuery(sql, params){
            seen.push({ sql: sql, params: params });
            if(sql.indexOf('FROM state_checkpoints sc JOIN') !== -1) return opts.pending || [];
            if(sql.indexOf('FROM anchor_published_checkpoints') !== -1) return opts.marker ? [opts.marker] : [];
            return [];
        }
    };
}

function mkRow(){
    return {
        chain: 'BTC', network: 'regtest', block_index: 900, block_hash: 'bh', ledger_hash: 'lh',
        actions_hash: 'ah', contract_hash: 'ch', checkpoint_seq: 100, snapshot_block: 800,
        // Root-bearing: an ANCHOR v0 section carries the light-client roots by
        // construction, and the selector skips a row that has none (D8).
        state_root: 'aa'.repeat(32), state_root_version: 1,
        block_merkle_root: 'bb'.repeat(32), block_merkle_version: 1,
        validator_signatures: '[]', anchor_txid: null
    };
}

// A publisher wired so publishPendingCheckpoints reaches the broadcast decision with
// the election, flag-day and identity machinery out of the way.
function mkPub(db){
    const pub = new StateAnchorPublisher({ db: db, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    pub.chunkRetryDelayMs     = 1;
    pub.ambiguousPollDelayMs  = 1;
    pub.ambiguousPollAttempts = 1;
    pub.network               = null;                 // no network filter on the pending select
    pub.identity              = null;                 // skips the publisher-attestation round
    pub.peerManager           = null;                 // skips the XANC_BUNDLE_DONE announce
    pub.getActiveOraclePublishPubkeys = async () => ['aa'];
    pub.mayPublish           = () => true;
    return pub;
}

function sqlHits(db, needle){ return db.seen.filter(q => q.sql.indexOf(needle) !== -1); }

describe('StateAnchorPublisher: durable at-most-once anchor intent', function () {

    describe('anchorIntentHolds', function () {
        it('does not hold with no marker', function () {
            expect(mkPub(mkDb()).anchorIntentHolds(null)).to.equal(false);
        });

        it('holds a fresh intent', function () {
            const pub = mkPub(mkDb());
            expect(pub.anchorIntentHolds({ intent_at: new Date() })).to.equal(true);
        });

        it('releases an intent older than the TTL, so a never-relayed send cannot suppress the anchor forever', function () {
            const pub = mkPub(mkDb());
            pub.anchorIntentTtlMs = 1000;
            expect(pub.anchorIntentHolds({ intent_at: new Date(Date.now() - 5000) })).to.equal(false);
        });

        it('holds an unreadable stamp (fail closed: the TTL is a liveness bound, not a licence to spend)', function () {
            expect(mkPub(mkDb()).anchorIntentHolds({ intent_at: 'not-a-date' })).to.equal(true);
        });
    });

    describe('marker statements', function () {
        it('arms intent with a window-refreshing upsert', async function () {
            const db  = mkDb();
            const pub = mkPub(db);
            await pub.recordAnchorIntent(mkRow());
            const q = sqlHits(db, 'INSERT INTO anchor_published_checkpoints')[0];
            expect(q.sql).to.contain('ON DUPLICATE KEY UPDATE intent_at = CURRENT_TIMESTAMP');
            expect(q.sql).to.contain('sent_at = NULL');
            expect(q.params).to.deep.equal(['BTC', 'regtest', 100]);
        });

        it('withdraws only an unconfirmed intent, never a confirmed marker', async function () {
            const db  = mkDb();
            const pub = mkPub(db);
            await pub.withdrawAnchorIntent(mkRow());
            expect(sqlHits(db, 'DELETE FROM anchor_published_checkpoints')[0].sql).to.contain('AND sent_at IS NULL');
        });

        it('never throws out of markAnchorSent: the fee is already spent and the intent still holds', async function () {
            const pub = mkPub({ ...DB_METHODS, async doQuery(){ throw new Error('db down'); } });
            await pub.markAnchorSent(mkRow(), 'tx-1');   // resolves rather than rejecting
        });

        it('propagates a read failure so the caller fails closed', async function () {
            const pub = mkPub({ ...DB_METHODS, async doQuery(){ throw new Error('db down'); } });
            let threw = false;
            try { await pub.getAnchorIntent(mkRow()); } catch(e){ threw = true; }
            expect(threw).to.equal(true);
        });
    });

});
