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
// and the `anchor_txid` stamp used to leave nothing recording that DOGE had paid, and
// the next flush rebuilt a fresh PSBT from different UTXOs (a second fee, two anchors
// that can both confirm). These pin the anchor_published_checkpoints marker: the hold,
// the mined-anchor fall-through, the TTL bound, and the withdraw/keep split between a
// definitive pre-send failure and an ambiguous send.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

// A db double that routes by SQL shape and records every statement it saw.
function mkDb(opts){
    opts = opts || {};
    const seen = [];
    return {
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

// A publisher wired so _publishPendingCheckpoints reaches the broadcast decision with
// the election, flag-day and identity machinery out of the way.
function mkPub(db){
    const pub = new StateAnchorPublisher({ db: db, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
    pub.chunkRetryDelayMs     = 1;
    pub.ambiguousPollDelayMs  = 1;
    pub.ambiguousPollAttempts = 1;
    pub.network               = null;                 // no network filter on the pending select
    pub.identity              = null;                 // skips the publisher-attestation round
    pub.peerManager           = null;                 // skips the XANC_BUNDLE_DONE announce
    pub._getActiveOraclePublishPubkeys = async () => ['aa'];
    pub._mayPublish           = () => true;
    return pub;
}

function sqlHits(db, needle){ return db.seen.filter(q => q.sql.indexOf(needle) !== -1); }

describe('StateAnchorPublisher: durable at-most-once anchor intent', function () {

    describe('_anchorIntentHolds', function () {
        it('does not hold with no marker', function () {
            expect(mkPub(mkDb())._anchorIntentHolds(null)).to.equal(false);
        });

        it('holds a fresh intent', function () {
            const pub = mkPub(mkDb());
            expect(pub._anchorIntentHolds({ intent_at: new Date() })).to.equal(true);
        });

        it('releases an intent older than the TTL, so a never-relayed send cannot suppress the anchor forever', function () {
            const pub = mkPub(mkDb());
            pub.anchorIntentTtlMs = 1000;
            expect(pub._anchorIntentHolds({ intent_at: new Date(Date.now() - 5000) })).to.equal(false);
        });

        it('holds an unreadable stamp (fail closed: the TTL is a liveness bound, not a licence to spend)', function () {
            expect(mkPub(mkDb())._anchorIntentHolds({ intent_at: 'not-a-date' })).to.equal(true);
        });
    });

    describe('marker statements', function () {
        it('arms intent with a window-refreshing upsert', async function () {
            const db  = mkDb();
            const pub = mkPub(db);
            await pub._recordAnchorIntent(mkRow());
            const q = sqlHits(db, 'INSERT INTO anchor_published_checkpoints')[0];
            expect(q.sql).to.contain('ON DUPLICATE KEY UPDATE intent_at = CURRENT_TIMESTAMP');
            expect(q.sql).to.contain('sent_at = NULL');
            expect(q.params).to.deep.equal(['BTC', 'regtest', 100]);
        });

        it('withdraws only an unconfirmed intent, never a confirmed marker', async function () {
            const db  = mkDb();
            const pub = mkPub(db);
            await pub._withdrawAnchorIntent(mkRow());
            expect(sqlHits(db, 'DELETE FROM anchor_published_checkpoints')[0].sql).to.contain('AND sent_at IS NULL');
        });

        it('never throws out of _markAnchorSent: the fee is already spent and the intent still holds', async function () {
            const pub = mkPub({ async doQuery(){ throw new Error('db down'); } });
            await pub._markAnchorSent(mkRow(), 'tx-1');   // resolves rather than rejecting
        });

        it('propagates a read failure so the caller fails closed', async function () {
            const pub = mkPub({ async doQuery(){ throw new Error('db down'); } });
            let threw = false;
            try { await pub._getAnchorIntent(mkRow()); } catch(e){ threw = true; }
            expect(threw).to.equal(true);
        });
    });

    describe('_publishPendingCheckpoints', function () {
        it('holds the checkpoint when an unconfirmed intent survives and the anchor is not yet mined', async function () {
            const db  = mkDb({ pending: [mkRow()], marker: { intent_at: new Date(), txid: 'earlier-tx', sent_at: null } });
            const pub = mkPub(db);
            pub._findExistingCheckpointAnchor = async () => null;      // mined view: definitively absent
            let broadcasts = 0;
            const out = await pub._publishPendingCheckpoints({ broadcastFn: async () => { broadcasts++; return { txid: 'fresh' }; } }, 1000);
            expect(broadcasts).to.equal(0);
            expect(out).to.deep.equal([]);
            expect(sqlHits(db, 'UPDATE state_checkpoints SET anchor_txid')).to.have.length(0);
        });

        it('falls through to the adopt path once the held anchor mines', async function () {
            const db  = mkDb({ pending: [mkRow()], marker: { intent_at: new Date(), txid: null, sent_at: null } });
            const pub = mkPub(db);
            pub._findExistingCheckpointAnchor = async () => ({ exists: true, txid: 'mined-tx' });
            let broadcasts = 0;
            const out = await pub._publishPendingCheckpoints({ broadcastFn: async () => { broadcasts++; return { txid: 'fresh' }; } }, 1000);
            expect(broadcasts).to.equal(0);                            // adopted, never re-broadcast
            expect(out).to.have.length(1);
            expect(out[0].txid).to.equal('mined-tx');
        });

        it('re-broadcasts once the intent ages past the TTL', async function () {
            const db  = mkDb({ pending: [mkRow()], marker: { intent_at: new Date(Date.now() - 60000), txid: null, sent_at: null } });
            const pub = mkPub(db);
            pub.anchorIntentTtlMs = 1000;
            pub._findExistingCheckpointAnchor = async () => null;
            let broadcasts = 0;
            const out = await pub._publishPendingCheckpoints({ broadcastFn: async () => { broadcasts++; return { txid: 'fresh' }; } }, 1000);
            expect(broadcasts).to.equal(1);
            expect(out[0].txid).to.equal('fresh');
        });

        it('arms intent BEFORE the broadcast and confirms it after', async function () {
            const db  = mkDb({ pending: [mkRow()] });
            const pub = mkPub(db);
            pub._findExistingCheckpointAnchor = async () => null;
            let armedBeforeSend = false;
            await pub._publishPendingCheckpoints({ broadcastFn: async () => {
                armedBeforeSend = sqlHits(db, 'INSERT INTO anchor_published_checkpoints').length === 1;
                return { txid: 'fresh' };
            } }, 1000);
            expect(armedBeforeSend).to.equal(true);
            expect(sqlHits(db, 'UPDATE anchor_published_checkpoints SET txid')).to.have.length(1);
        });

        it('withdraws the intent when the send definitively never went out', async function () {
            const db  = mkDb({ pending: [mkRow()] });
            const pub = mkPub(db);
            pub._findExistingCheckpointAnchor = async () => null;
            await pub._publishPendingCheckpoints({ broadcastFn: async () => { throw new Error('no UTXOs available for Dpub1'); } }, 1000);
            expect(sqlHits(db, 'DELETE FROM anchor_published_checkpoints')).to.have.length(1);
        });

        it('KEEPS the intent after an ambiguous send, which is the case the marker exists for', async function () {
            const db  = mkDb({ pending: [mkRow()] });
            const pub = mkPub(db);
            pub._findExistingCheckpointAnchor = async () => null;
            await pub._publishPendingCheckpoints({ broadcastFn: async () => {
                const e = new Error('socket hang up'); e.anchorAmbiguousSend = true; throw e;
            } }, 1000);
            expect(sqlHits(db, 'DELETE FROM anchor_published_checkpoints')).to.have.length(0);
        });

        // ORDERING: the marker is read before the publisher-attestation round, not after.
        //
        // Every case above runs with pub.identity = null, which is exactly the leg where
        // the round is skipped, so none of them can see where the marker read sits
        // relative to it. With an identity set and no gate, a held row solicits a full 2f+1
        // XANCPUB quorum from the federation, occupy the single _attestRound slot for up
        // to roundTimeoutMs, and make every peer re-derive the election, for a publish
        // this loop then declines. The archive twin (_publishArchive) already checks its
        // intent first and documents that ordering as deliberate.
        function mkAttestingPub(db){
            const pub = mkPub(db);
            pub.identity = { getPubkeyHex: () => 'AA' };   // arms the isAnchorRewardActive branch
            pub.rounds   = 0;
            // A MET round. These cases are about WHERE the marker is read relative to the
            // round, not about what a degraded round does, and a degraded one now defers
            // the bundle before the publish path they exist to exercise is reached.
            pub._runPublisherAttestationRound = async () => {
                pub.rounds++;
                return { met: true, sigs: [{ pubkey: 'aa'.repeat(32), sig: 'bb'.repeat(64) }], publisher: 'aa' };
            };
            return pub;
        }

        it('does not open a publisher-attestation round for a held, unmined checkpoint', async function () {
            const db  = mkDb({ pending: [mkRow()], marker: { intent_at: new Date(), txid: 'earlier-tx', sent_at: null } });
            const pub = mkAttestingPub(db);
            pub._findExistingCheckpointAnchor = async () => null;
            let broadcasts = 0;
            const out = await pub._publishPendingCheckpoints({ broadcastFn: async () => { broadcasts++; return { txid: 'fresh' }; } }, 1000);
            expect(pub.rounds, 'a held row must cost one DB read, not a federation quorum').to.equal(0);
            expect(broadcasts).to.equal(0);
            expect(out).to.deep.equal([]);
        });

        it('still runs the attestation round when the held anchor has mined (no over-skip)', async function () {
            // The mined fall-through is the half a careless reorder breaks: the row is
            // held AND mined, so the loop must continue into the normal publish/adopt path
            // rather than `continue`-ing past it.
            const db  = mkDb({ pending: [mkRow()], marker: { intent_at: new Date(), txid: null, sent_at: null } });
            const pub = mkAttestingPub(db);
            pub._findExistingCheckpointAnchor = async () => ({ exists: true, txid: 'mined-tx' });
            const out = await pub._publishPendingCheckpoints({ broadcastFn: async () => ({ txid: 'fresh' }) }, 1000);
            expect(pub.rounds, 'a held-but-mined row still takes the normal publish path').to.equal(1);
            expect(out).to.have.length(1);
            expect(out[0].txid).to.equal('mined-tx');
        });

        it('runs the attestation round for an unheld checkpoint', async function () {
            // The negative control for the two cases above: with no marker the round must
            // still open, or "rounds === 0" would prove nothing about the ordering.
            const db  = mkDb({ pending: [mkRow()] });
            const pub = mkAttestingPub(db);
            pub._findExistingCheckpointAnchor = async () => null;
            await pub._publishPendingCheckpoints({ broadcastFn: async () => ({ txid: 'fresh' }) }, 1000);
            expect(pub.rounds).to.equal(1);
        });
    });

    // ── marker-table retention (#4869) ────────────────────────────────────────
    // Both marker tables appended one row per DOGE-spending broadcast and removed
    // one only on a definitive pre-send failure, so a confirmed marker persisted for
    // the life of the deployment while the oracle_published_rounds sibling was swept.
    // Two invariants: only CONFIRMED rows are ever deleted (a surviving sent_at NULL
    // row is the AMBIGUOUS-send record, the only durable trace that DOGE may already
    // have paid), and the cutoff can never reach inside the anchorIntentTtlMs hold
    // window, which is the exact quantity every read path already measures.
    describe('marker-table retention (#4869)', function () {

        // A db double that records statements and reports a fixed delete count. The
        // assertions are about the STATEMENT the sweep issues, since the invariants
        // are its predicates, not about a re-implementation of MariaDB.
        function mkRetentionDb(affected, failOnDelete){
            const seen = [];
            return {
                seen: seen,
                async doQuery(sql, params){
                    seen.push({ sql: sql, params: params });
                    if(/^\s*DELETE/i.test(sql)){
                        if(failOnDelete) throw new Error('ER_LOCK_WAIT_TIMEOUT');
                        return { affectedRows: affected === undefined ? 0 : affected };
                    }
                    return [];
                }
            };
        }

        const dels = (db) => db.seen.filter(q => /^\s*DELETE/i.test(q.sql));

        afterEach(function(){ delete process.env.ANCHOR_MARKER_RETENTION_MS; });

        it('defaults to a ~90-day window and honours p2pConfig, the env var, and 0 as "off"', function () {
            expect(mkPub(mkDb()).anchorMarkerRetentionMs).to.equal(7776000000);

            const cfg = new StateAnchorPublisher({ db: mkDb(), p2pConfig: { ANCHOR_MARKER_RETENTION_MS: '900000' } });
            expect(cfg.anchorMarkerRetentionMs).to.equal(900000);

            process.env.ANCHOR_MARKER_RETENTION_MS = '111000';
            const env = new StateAnchorPublisher({ db: mkDb(), p2pConfig: { ANCHOR_MARKER_RETENTION_MS: '900000' } });
            expect(env.anchorMarkerRetentionMs, 'the env var wins over p2pConfig').to.equal(111000);
            delete process.env.ANCHOR_MARKER_RETENTION_MS;

            const off = new StateAnchorPublisher({ db: mkDb(), p2pConfig: { ANCHOR_MARKER_RETENTION_MS: '0' } });
            expect(off.anchorMarkerRetentionMs).to.equal(0);

            for(const bad of ['abc', '-5', '']){
                const p = new StateAnchorPublisher({ db: mkDb(), p2pConfig: { ANCHOR_MARKER_RETENTION_MS: bad } });
                expect(p.anchorMarkerRetentionMs, 'input ' + JSON.stringify(bad)).to.equal(7776000000);
            }
        });

        it('sweeps BOTH tables with the sent_at IS NOT NULL filter on the intent_at column', async function () {
            const db  = mkRetentionDb(3);
            const pub = mkPub(db);
            pub.anchorMarkerRetentionMs = 7776000000;
            pub.anchorIntentTtlMs       = 21600000;

            expect(await pub._pruneAnchorMarkers()).to.equal(6);

            const d = dels(db);
            expect(d.length, 'both marker tables must be swept').to.equal(2);
            expect(d[0].sql).to.match(/FROM anchor_published_checkpoints/);
            expect(d[1].sql).to.match(/FROM anchor_published_archives/);
            for(const q of d){
                expect(q.sql, 'the ambiguous-send record must never be deleted')
                    .to.match(/sent_at IS NOT NULL/);
                expect(q.sql, 'intent_at is the column _anchorIntentHolds measures')
                    .to.match(/intent_at < DATE_SUB\(NOW\(\), INTERVAL \? SECOND\)/);
                expect(q.params[0]).to.equal(7776000);
            }
            expect(pub.anchorMarkersPruned).to.equal(6);
        });

        it('clamps the cutoff below the anchorIntentTtlMs hold window, which is the re-presentability floor', async function () {
            // A one-minute window would delete a marker that _anchorIntentHolds still
            // answers true for, and the next flush would rebuild a second PSBT for a
            // checkpoint DOGE may already have paid for. The TTL floors it instead.
            const db  = mkRetentionDb(0);
            const pub = mkPub(db);
            pub.anchorMarkerRetentionMs = 60000;
            pub.anchorIntentTtlMs       = 21600000;   // 6 h

            await pub._pruneAnchorMarkers();

            const floorSec = (21600000 * 8) / 1000;
            expect(dels(db)[0].params[0]).to.equal(floorSec);
            expect(floorSec * 1000, 'the cutoff sits strictly outside the hold window')
                .to.be.greaterThan(pub.anchorIntentTtlMs);

            // Widening the TTL widens the floor with it.
            const db2  = mkRetentionDb(0);
            const pub2 = mkPub(db2);
            pub2.anchorMarkerRetentionMs = 60000;
            pub2.anchorIntentTtlMs       = 43200000;   // 12 h
            await pub2._pruneAnchorMarkers();
            expect(dels(db2)[0].params[0]).to.equal((43200000 * 8) / 1000);
        });

        it('issues no DELETE when retention is off or no DB is wired', async function () {
            const dbOff = mkRetentionDb(1);
            const off   = mkPub(dbOff);
            off.anchorMarkerRetentionMs = 0;
            expect(await off._pruneAnchorMarkers()).to.equal(0);
            expect(dels(dbOff).length).to.equal(0);

            const noDb = mkPub(mkRetentionDb(1));
            noDb.db = null;
            expect(await noDb._pruneAnchorMarkers()).to.equal(0);
        });

        it('runs the sweep at the end of a flush that reached the publishing stage', async function () {
            const db  = mkRetentionDb(1);
            const pub = mkPub(db);
            pub._drainDeferredBundleDone   = async () => {};
            pub._drainDeferredFinalized    = async () => {};
            pub._drainDeferredRewardAttest = async () => {};
            pub._publishPendingCheckpoints = async () => [];
            pub._startArchiveRound         = async () => 'none';
            pub.broadcastFn                = async () => ({ txid: 'x' });

            await pub.flush();
            await pub._retentionSweep;

            expect(dels(db).length).to.equal(2);
            expect(pub.anchorMarkersPruned).to.equal(2);
        });

        it('never lets a retention failure fail a flush that already spent DOGE', async function () {
            const db  = mkRetentionDb(0, true);   // every DELETE throws
            const pub = mkPub(db);
            pub._drainDeferredBundleDone   = async () => {};
            pub._drainDeferredFinalized    = async () => {};
            pub._drainDeferredRewardAttest = async () => {};
            pub._publishPendingCheckpoints = async () => [{ chain: 'BTC', txid: 'paid' }];
            pub._startArchiveRound         = async () => 'none';
            pub.broadcastFn                = async () => ({ txid: 'x' });

            const res = await pub.flush();
            await pub._retentionSweep;            // the rejection is swallowed inside

            expect(res.error, 'a housekeeping failure must never be reported as a flush error').to.equal(undefined);
            expect(res.anchored).to.have.length(1);
            expect(pub.anchorMarkersPruned).to.equal(0);
        });

        it('surfaces the window and the lifetime prune count through getAnchorStats()', function () {
            const pub = mkPub(mkDb());
            pub.anchorMarkerRetentionMs = 250000;
            pub.anchorMarkersPruned     = 9;
            const stats = pub.getAnchorStats();
            expect(stats.anchorMarkerRetentionMs).to.equal(250000);
            expect(stats.anchorMarkersPruned).to.equal(9);
        });
    });
});
