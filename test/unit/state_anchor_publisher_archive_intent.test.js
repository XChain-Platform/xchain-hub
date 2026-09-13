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

// Durable at-most-once for the ARCHIVE spend, the twin of the checkpoint marker
// pinned in StateAnchorPublisher.anchor-intent.test.js.
//
// _publishArchive broadcasts a v1 head plus N v2 chunks and only afterwards stamps the
// source rows (_backfillBatch). It passes NO existsCheck, because the archive path has
// no mined-state query surface at all (getanchoraction serves CHECKPOINT_VERSIONS
// only), so everything that knew a send had gone out lived in memory. A crash between
// an accepted send and the back-fill therefore left every row still matching the
// pending selectors with nothing recording that DOGE had paid, and the next flush
// rebuilt the whole batch under a FRESH seq and re-paid for the head and every chunk.
//
// These pin the anchor_published_archives marker: the per-network hold (the rebuild
// draws a new seq, so a per-batch_seq marker could never match the round it must stop),
// the arm-before-send ordering, the settle-on-completion release, and the withdraw/keep
// split between a definitive pre-send failure and an ambiguous send.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');

const BLOCK = 100;
const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 500, block_hash: 'c0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: BLOCK, snapshot_block: BLOCK, state_root: null, block_merkle_root: null
};
const MATCH_ROW = {
    id: 1, match_id: 'm'.repeat(64), snapshot_block: BLOCK, network: 'regtest',
    a_chain: 'BTC', a_action_index: 1, a_kind: 'swap', a_tick: 'AAA', a_amount: '1',
    a_filled_before: '0', a_ownership: 0, a_payout_addr: 'addrA',
    b_chain: 'DOGE', b_action_index: 2, b_kind: 'swap', b_tick: 'BBB', b_amount: '2',
    b_filled_before: '0', b_ownership: 0, b_payout_addr: 'addrB',
    effective_time: 10, finalizing_view: 0, validator_signatures: '[]', status: 'settled'
};

// A db double that records every statement and keeps a real in-memory
// anchor_published_archives table, so the hold/settle semantics are exercised through
// the SQL the publisher actually issues rather than through a stubbed return value.
// Any other SELECT is answered from `rows` by SQL fragment (the archive-suite idiom).
function mkDb(opts){
    opts = opts || {};
    const seen     = [];
    const archives = opts.archives || [];
    const rows     = opts.rows || {};
    return {
        seen: seen,
        archives: archives,
        async doQuery(sql, params){
            params = params || [];
            seen.push({ sql: sql, params: params });
            if(opts.failArchiveReads && sql.indexOf('FROM anchor_published_archives') !== -1)
                throw new Error('db down');
            if(sql.indexOf('SELECT network, batch_seq') === 0 && sql.indexOf('anchor_published_archives') !== -1){
                return archives.filter(r => r.network === params[0] && r.settled_at == null)
                               .sort((a, b) => new Date(b.intent_at) - new Date(a.intent_at))
                               .slice(0, 1);
            }
            if(sql.indexOf('INSERT INTO anchor_published_archives') !== -1){
                let row = archives.find(r => r.network === params[0] && r.batch_seq === params[1]);
                if(!row){ row = { network: params[0], batch_seq: params[1] }; archives.push(row); }
                row.intent_at = new Date(); row.sent_at = null; row.txid = null; row.settled_at = null;
                return [];
            }
            if(sql.indexOf('UPDATE anchor_published_archives SET txid') !== -1){
                for(let r of archives)
                    if(r.network === params[1] && r.batch_seq === params[2]){ r.txid = params[0]; r.sent_at = new Date(); }
                return [];
            }
            if(sql.indexOf('UPDATE anchor_published_archives SET settled_at') !== -1){
                for(let r of archives)
                    if(r.network === params[0] && r.batch_seq === params[1] && r.sent_at != null) r.settled_at = new Date();
                return [];
            }
            if(sql.indexOf('DELETE FROM anchor_published_archives') !== -1){
                for(let i = archives.length - 1; i >= 0; i--){
                    let r = archives[i];
                    if(r.network === params[0] && r.batch_seq === params[1] && r.sent_at == null) archives.splice(i, 1);
                }
                return [];
            }
            for(let frag of Object.keys(rows)) if(sql.indexOf(frag) !== -1) return rows[frag];
            return [];
        }
    };
}

// A publisher wired so the archive path reaches its broadcast decision with the
// election, attestation and reward machinery out of the way.
function mkPub(db){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: db, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        rewardTracker: { anchorReward: '10.00000000', resolveSourceByPubkey: async (pk) => 'src_' + pk.substring(0, 8) },
        _resolveBtcLatestBlock: async () => BLOCK
    });
    pub.chunkRetryDelayMs     = 1;
    pub.ambiguousPollDelayMs  = 1;
    pub.ambiguousPollAttempts = 1;
    pub.peerManager           = null;                     // skips the XANC_FINALIZED announce
    pub._getActiveOraclePublishPubkeys = async () => [identity.getPubkeyHex().toLowerCase()];
    pub._recordReward         = () => {};
    pub._runArchiveAttestationRound = async () => ({ met: false, sigs: [] });   // legacy v1, no quorum needed
    return { pub: pub, identity: identity };
}

// A round shaped exactly like the one _startArchiveRound hands to _publishArchive,
// single-member signing set (so the on-chain-validity gate short-circuits true).
function mkRound(pub, identity, broadcastFn, batchSeq){
    const cp        = pub._cpFromRow(CP_ROW);
    const canonical = pub._archiveCanonical(cp, batchSeq, 1, 'deadbeef', 1);
    return {
        cp: cp, batchSeq: batchSeq, crc: 'deadbeef', count: 1, canonical: canonical,
        b64: 'x', chunks: ['x'],
        signer: { broadcastFn: broadcastFn },
        quorum: 1, weighted: false,
        matchIds: [{ match_id: MATCH_ROW.match_id, status: 'finalized' }],
        callIds: [], rewardIds: [],
        validators: [{ pubkey: identity.getPubkeyHex().toLowerCase(), source: 'src', weight: '1' }],
        signatures: new Map([[identity.getPubkeyHex().toLowerCase(), identity.sign(canonical)]]),
        done: true, timer: null
    };
}

const ARCHIVE_ROWS = {
    'FROM cross_chain_matches WHERE batch_seq IS NULL': [MATCH_ROW],
    'FROM state_checkpoints':                           [CP_ROW],
    'COALESCE(GREATEST(':                               [{ next_seq: 7 }]
};

function sqlHits(db, needle){ return db.seen.filter(q => q.sql.indexOf(needle) !== -1); }
const live    = (extra) => Object.assign({ network: 'regtest', batch_seq: 3, txid: null, intent_at: new Date(), sent_at: null, settled_at: null }, extra || {});

describe('StateAnchorPublisher: durable at-most-once archive intent', function () {

    describe('marker statements', function () {
        it('arms intent with a window-refreshing upsert that clears the prior outcome', async function () {
            const db = mkDb();
            await mkPub(db).pub._recordArchiveIntent('regtest', 7);
            const q = sqlHits(db, 'INSERT INTO anchor_published_archives')[0];
            expect(q.sql).to.contain('ON DUPLICATE KEY UPDATE intent_at = CURRENT_TIMESTAMP');
            expect(q.sql).to.contain('sent_at = NULL');
            expect(q.sql).to.contain('settled_at = NULL');
            expect(q.params).to.deep.equal(['regtest', 7]);
        });

        it('reads only UNSETTLED intents for the network, newest first', async function () {
            const db = mkDb({ archives: [
                live({ batch_seq: 1, intent_at: new Date(Date.now() - 9000), settled_at: new Date() }),   // finished
                live({ batch_seq: 2, intent_at: new Date(Date.now() - 5000) }),                           // in flight
                live({ batch_seq: 9, network: 'mainnet' })                                                // other network
            ] });
            const got = await mkPub(db).pub._getLiveArchiveIntent('regtest');
            expect(got.batch_seq).to.equal(2);
            expect(sqlHits(db, 'FROM anchor_published_archives')[0].sql).to.contain('settled_at IS NULL');
        });

        it('settles only a marker whose broadcast actually returned', async function () {
            const db = mkDb();
            await mkPub(db).pub._settleArchiveIntent('regtest', 7);
            expect(sqlHits(db, 'UPDATE anchor_published_archives SET settled_at')[0].sql).to.contain('AND sent_at IS NOT NULL');
        });

        it('withdraws only an unconfirmed intent, never a confirmed marker', async function () {
            const db = mkDb();
            await mkPub(db).pub._withdrawArchiveIntent('regtest', 7);
            expect(sqlHits(db, 'DELETE FROM anchor_published_archives')[0].sql).to.contain('AND sent_at IS NULL');
        });

        it('never throws out of the post-send writes: the fee is already spent and the intent still holds', async function () {
            const { pub } = mkPub({ async doQuery(){ throw new Error('db down'); } });
            await pub._markArchiveSent('regtest', 7, 'tx-1');
            await pub._settleArchiveIntent('regtest', 7);
            await pub._withdrawArchiveIntent('regtest', 7);
        });

        it('propagates a read failure so the caller fails closed', async function () {
            const { pub } = mkPub(mkDb({ failArchiveReads: true }));
            let threw = false;
            try { await pub._getLiveArchiveIntent('regtest'); } catch(e){ threw = true; }
            expect(threw).to.equal(true);
        });
    });

    describe('_startArchiveRound', function () {
        // flush() hands over whatever hub._resolveBtcLatestBlock() returned, and that is
        // null on a stale pushed tip, an over-lag indexer, or a failed RPC. A non-finite
        // block makes _getActiveOraclePublishPubkeys take its block-UNPINNED branch (the
        // per-hub gossip registry, scoped by its own contract to the coarse sender
        // pre-filter), so the round would elect over a set that differs hub to hub on a
        // path that spends real DOGE. Defer instead, and do it before the resolver is
        // consulted at all.
        for (const bad of [null, undefined, NaN]) {
            it('defers the round on an unresolved BTC tip (' + String(bad) + ') without electing', async function () {
                const db = mkDb({ rows: ARCHIVE_ROWS });
                const { pub, identity } = mkPub(db);
                let elections = 0;
                pub._getActiveOraclePublishPubkeys = async () => {
                    elections++;
                    return [identity.getPubkeyHex().toLowerCase()];
                };
                let broadcasts = 0;
                const out = await pub._startArchiveRound(
                    { broadcastFn: async () => { broadcasts++; return { txid: 'fresh' }; } }, bad);
                expect(out, 'an unresolved tip must defer, like the empty-set case').to.equal('none');
                expect(elections, 'the unpinned election set was never resolved').to.equal(0);
                expect(broadcasts, 'no DOGE spent on an unpinned election').to.equal(0);
                expect(sqlHits(db, 'COALESCE(GREATEST(')).to.have.length(0);   // no seq drawn
            });
        }

        it('still elects and draws a seq on a finite tip (the guard is not a blanket stop)', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS });
            const { pub, identity } = mkPub(db);
            let elections = 0;
            pub._getActiveOraclePublishPubkeys = async () => {
                elections++;
                return [identity.getPubkeyHex().toLowerCase()];
            };
            await pub._startArchiveRound({ broadcastFn: async () => ({ txid: 'fresh' }) }, BLOCK);
            expect(elections, 'a finite tip still resolves the election set').to.be.greaterThan(0);
            expect(sqlHits(db, 'COALESCE(GREATEST(')).to.have.length(1);
        });

        it('holds the round while an unsettled intent survives, before a batch seq is even drawn', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS, archives: [live({ txid: 'earlier-v1' })] });
            const { pub } = mkPub(db);
            let broadcasts = 0;
            const out = await pub._startArchiveRound({ broadcastFn: async () => { broadcasts++; return { txid: 'fresh' }; } }, BLOCK);
            expect(out).to.equal('intent_held');
            expect(broadcasts).to.equal(0);
            expect(sqlHits(db, 'COALESCE(GREATEST(')).to.have.length(0);   // no seq drawn, no co-sign round opened
        });

        it('proceeds past the hold once the intent ages past the TTL', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS, archives: [live({ intent_at: new Date(Date.now() - 60000) })] });
            const { pub } = mkPub(db);
            pub.anchorIntentTtlMs = 1000;
            const out = await pub._startArchiveRound({ broadcastFn: async () => ({ txid: 'fresh' }) }, BLOCK);
            expect(out).to.not.equal('intent_held');
            expect(sqlHits(db, 'COALESCE(GREATEST(')).to.have.length(1);
        });

        it('proceeds when the only marker for the network is settled', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS, archives: [live({ sent_at: new Date(), settled_at: new Date() })] });
            const { pub } = mkPub(db);
            const out = await pub._startArchiveRound({ broadcastFn: async () => ({ txid: 'fresh' }) }, BLOCK);
            expect(out).to.not.equal('intent_held');
            expect(sqlHits(db, 'COALESCE(GREATEST(')).to.have.length(1);
        });

        it('ignores an unsettled intent belonging to another network', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS, archives: [live({ network: 'mainnet' })] });
            const { pub } = mkPub(db);
            const out = await pub._startArchiveRound({ broadcastFn: async () => ({ txid: 'fresh' }) }, BLOCK);
            expect(out).to.not.equal('intent_held');
        });
    });

    describe('_publishArchive', function () {
        it('arms intent BEFORE the v1 send, confirms it after, and settles once the back-fill lands', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS });
            const { pub, identity } = mkPub(db);
            let armedBeforeSend = false;
            const round = mkRound(pub, identity, async () => {
                armedBeforeSend = armedBeforeSend || sqlHits(db, 'INSERT INTO anchor_published_archives').length === 1;
                return { txid: 'v1-tx' };
            }, 7);
            await pub._publishArchive(round);
            expect(armedBeforeSend, 'intent armed before money could move').to.equal(true);
            expect(sqlHits(db, 'UPDATE anchor_published_archives SET txid')).to.have.length(1);
            expect(db.archives[0].settled_at, 'window closed once bookkeeping landed').to.not.equal(null);
        });

        it('leaves the intent UNSETTLED when the v1 broadcast returned no txid (not proof nothing was sent)', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS });
            const { pub, identity } = mkPub(db);
            await pub._publishArchive(mkRound(pub, identity, async () => ({ txid: null }), 7));
            expect(sqlHits(db, 'UPDATE anchor_published_archives SET settled_at')).to.have.length(0);
            expect(db.archives[0].settled_at == null).to.equal(true);
        });

        it('withdraws the intent when the send definitively never went out', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS });
            const { pub, identity } = mkPub(db);
            let threw = false;
            try {
                await pub._publishArchive(mkRound(pub, identity, async () => { throw new Error('no UTXOs available for Dpub1'); }, 7));
            } catch(e){ threw = true; }
            expect(threw).to.equal(true);
            expect(sqlHits(db, 'DELETE FROM anchor_published_archives')).to.have.length(1);
            expect(db.archives).to.have.length(0);
        });

        it('KEEPS the intent after an ambiguous send, which is the case the marker exists for', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS });
            const { pub, identity } = mkPub(db);
            try {
                await pub._publishArchive(mkRound(pub, identity, async () => {
                    const e = new Error('socket hang up'); e.anchorAmbiguousSend = true; throw e;
                }, 7));
            } catch(e){ /* deferred to a later flush */ }
            expect(sqlHits(db, 'DELETE FROM anchor_published_archives')).to.have.length(0);
            expect(db.archives).to.have.length(1);
            expect(db.archives[0].settled_at == null).to.equal(true);
        });

        it('refuses to publish (and back-fills nothing) when an earlier round\'s intent survives', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS, archives: [live({ batch_seq: 3, sent_at: new Date(), txid: 'earlier-v1' })] });
            const { pub, identity } = mkPub(db);
            let broadcasts = 0;
            const out = await pub._publishArchive(mkRound(pub, identity, async () => { broadcasts++; return { txid: 'fresh' }; }, 7));
            expect(out).to.equal('intent_held');
            expect(broadcasts).to.equal(0);
            expect(sqlHits(db, 'UPDATE cross_chain_matches SET batch_seq')).to.have.length(0);
        });
    });

    // The accepted-but-unacked window end to end: the process dies
    // before _backfillBatch, and the next flush must NOT rebuild and re-pay.
    describe('crash after an accepted archive send', function () {
        it('does not rebuild and re-broadcast the batch on the next flush', async function () {
            const db = mkDb({ rows: ARCHIVE_ROWS });
            const { pub, identity } = mkPub(db);
            let broadcasts = 0;
            try {
                await pub._publishArchive(mkRound(pub, identity, async () => {
                    broadcasts++;
                    const e = new Error('socket hang up mid-send'); e.anchorAmbiguousSend = true; throw e;
                }, 7));
            } catch(e){ /* the round dies here, exactly as a crash would */ }
            expect(broadcasts).to.equal(1);

            // Restart: fresh publisher, same durable DB, same still-pending rows.
            const restarted = mkPub(db).pub;
            const out = await restarted._startArchiveRound({ broadcastFn: async () => { broadcasts++; return { txid: 'second-fee' }; } }, BLOCK);
            expect(out).to.equal('intent_held');
            expect(broadcasts, 'no second archive was paid for').to.equal(1);
        });
    });
});
