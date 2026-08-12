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

// : the failover ladder had no wake-up. flush() ran on ANCHOR_INTERVAL_MS
// (24h by default) plus the size triggers, and failover rank was evaluated ONLY
// inside flush, so the constant derivation's promise that "ranks 1-3 still get a
// slot inside one publishing cycle" was reachable only by phase luck: a dead rank 0
// stranded v0/archive work until unrelated batch traffic or the next daily tick,
// while the archive-round timeout logged "retrying next flush" and waited a day.
//
// The wake re-runs flush on a short cadence in FAILOVER-ONLY mode. The mode is the
// load-bearing half: rank 0 is always unlocked, so an unscoped periodic flush would
// replace a healthy leader's publishing cadence with the wake's and re-anchor a
// fresh checkpoint (and archive whatever few rows are pending) every wake, all of
// it real DOGE. These tests pin both halves - the backup wakes, the leader does not.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');

const BLOCK  = 100;
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
const BATCH_SEQ = 7;

const ENV_KEYS = ['ANCHOR_RANK_WAKE_MS', 'ANCHOR_ELECTION_TOLERANCE_BLOCKS', 'ANCHOR_INTERVAL_MS',
    'ANCHOR_ROUND_TIMEOUT_MS'];

function buildPub() {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let hub = {
        db: {
            async doQuery(sql) {
                if (sql.indexOf('FROM cross_chain_matches WHERE batch_seq IS NULL') !== -1) return [MATCH_ROW];
                if (sql.indexOf('FROM state_checkpoints') !== -1) return [CP_ROW];
                return [];
            }
        },
        network: 'regtest',
        capabilitySnapshot: null,
        capabilityRegistry: null,
        getIdentity:    () => identity,
        getPeerManager: () => ({ broadcast() {}, on() {}, removeListener() {} }),
        p2pConfig: {},
        rewardTracker: {
            anchorReward: '10.00000000',
            resolveSourceByPubkey: async (pk) => 'src_' + String(pk).toLowerCase().substring(0, 12)
        },
        _resolveBtcLatestBlock: async () => BLOCK
    };
    return { pub: new StateAnchorPublisher(hub), me: identity.getPubkeyHex().toLowerCase() };
}

// An archive round with one pending match, a two-member ELECTION set (so a rank
// ladder exists) and a single-member SIGNING set (so a permitted round self-signs
// and reports 'published' without a peer quorum). `wantLeader` picks the peer that
// puts this hub at rank 0 or rank 1 in the real hash order, rather than stubbing
// hashOrder and pinning nothing.
function archiveRound(wantLeader) {
    let { pub, me } = buildPub();
    let key = pub._archiveElectionKey(pub._cpFromRow(CP_ROW), BATCH_SEQ);
    let peer = null;
    for (let i = 0; i < 256 && peer === null; i++) {
        let candidate = String(20 + (i % 80)).repeat(32).slice(0, 64);
        if (candidate === me) continue;
        let order = StateAnchorPublisher.hashOrder(key, [me, candidate]);
        if ((order[0] === me) === !!wantLeader) peer = candidate;
    }
    expect(peer, 'a peer producing the requested rank must exist').to.not.equal(null);
    let published = [];
    pub._getActiveOraclePublishPubkeys = async () => [me, peer];
    pub._resolveCapabilitySet          = async () => [{ pubkey: me, amount: '1', source: '' }];
    pub._getNextBatchSeq               = async () => BATCH_SEQ;
    pub._publishArchive                = async (round) => { published.push(round); };
    return { pub, me, peer, published };
}

describe('StateAnchorPublisher : failover wake', function () {

    let saved;
    before(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    after(function () {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    describe('the wake cadence sits inside the ladder ordering', function () {

        it('is far below one ladder step and far above a leader publish attempt', function () {
            const { pub } = buildPub();
            const BTC_BLOCK_MS = 10 * 60 * 1000;
            const toleranceMs  = pub.electionToleranceBlocks * BTC_BLOCK_MS;
            expect(pub.rankWakeMs).to.equal(900000);
            // Left bound: a wake never fires inside the leader's own round attempt.
            expect(pub.rankWakeMs).to.be.above(pub.roundTimeoutMs);
            // Right bound: the wake costs a small fraction of a ladder step in
            // latency, so a rank that unlocks is noticed inside the same step.
            expect(pub.rankWakeMs * 4).to.be.below(toleranceMs);
            // And it remains far below the interval it exists to cover for.
            expect(pub.rankWakeMs).to.be.below(pub.intervalMs);
        });

        it('is operator-tunable', function () {
            process.env.ANCHOR_RANK_WAKE_MS = '60000';
            try {
                expect(buildPub().pub.rankWakeMs).to.equal(60000);
            } finally {
                delete process.env.ANCHOR_RANK_WAKE_MS;
            }
        });
    });

    describe('failover-only mode leaves the leader alone', function () {

        it('a normal flush still lets the rank-0 leader publish its archive', async function () {
            let { pub, published } = archiveRound(true);
            expect(await pub._startArchiveRound(null, BLOCK)).to.equal('published');
            expect(published.length).to.equal(1);
        });

        it('a WAKE flush does not: the leader keeps its interval and size triggers', async function () {
            let { pub, published } = archiveRound(true);
            expect(await pub._startArchiveRound(null, BLOCK, true)).to.equal('none');
            expect(published.length, 'no extra DOGE archive on the wake cadence').to.equal(0);
        });
    });

    describe('failover-only mode is what wakes a backup', function () {

        it('a backup whose rank has NOT unlocked still stands down', async function () {
            let { pub, published } = archiveRound(false);
            // since = electionBlock - snapshot_block = 0 blocks, so rank 1 is locked.
            expect(await pub._startArchiveRound(null, BLOCK, true)).to.equal('none');
            expect(published.length).to.equal(0);
        });

        it('a backup whose rank HAS unlocked publishes the stranded batch', async function () {
            let { pub, published } = archiveRound(false);
            let unlocked = BLOCK + pub.electionToleranceBlocks;   // one ladder step past the anchor point
            expect(await pub._startArchiveRound(null, unlocked, true)).to.equal('published');
            expect(published.length, 'the dead leader no longer strands the batch for a cycle').to.equal(1);
        });

        it('and would have waited for the next interval tick without the wake', async function () {
            // The control: the same unlocked backup is only ever asked at all
            // because something re-ran flush. Rank is evaluated nowhere else.
            let { pub, me, peer } = archiveRound(false);
            let key   = pub._archiveElectionKey(pub._cpFromRow(CP_ROW), BATCH_SEQ);
            let order = StateAnchorPublisher.hashOrder(key, [me, peer]);
            expect(order.indexOf(me), 'this hub is the backup').to.equal(1);
            expect(pub._rankUnlocked(order, me, 0), 'locked at the anchor point').to.equal(false);
            expect(pub._rankUnlocked(order, me, pub.electionToleranceBlocks), 'unlocked one step later').to.equal(true);
        });
    });

    describe('_isRankZero', function () {

        it('is true only for the hub that leads the order', function () {
            let { pub, me } = buildPub();
            expect(pub._isRankZero([me, 'aa'.repeat(32)])).to.equal(true);
            expect(pub._isRankZero(['aa'.repeat(32), me])).to.equal(false);
            expect(pub._isRankZero([])).to.equal(false);
            expect(pub._isRankZero(null)).to.equal(false);
        });
    });

    describe('timer lifecycle', function () {

        it('start() arms the wake and stop() releases it', async function () {
            let { pub } = buildPub();
            pub.dogeAddress = 'Dpub1';
            pub.spendGuard.persistTo = () => {};   // no on-disk spend state from a unit test
            await pub.start();
            expect(pub._rankWakeTimer, 'wake armed').to.not.equal(null);
            await pub.stop();
            expect(pub._rankWakeTimer, 'wake released').to.equal(null);
        });
    });
});
