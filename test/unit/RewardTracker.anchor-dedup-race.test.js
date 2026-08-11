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

// Review board #4182: recordAnchorReward's cross-pubkey dedup was a non-atomic
// read-modify-write. StateAnchorPublisher._recordReward is fire-and-forget, so a
// hub's own publish and a peer's V0_DONE/FINALIZED mirror can be in flight for one
// (round_number, reward_type) with DIFFERENT pubkeys at once. Both observed the
// empty SELECT and both inserted; the table's UNIQUE KEY carries validator_pubkey,
// so nothing collapsed them, and every later replay short-circuited on "already
// ours" before reaching the deterministic collapse. Two COLLECT-spendable rows for
// one logical anchor, permanently.
//
// The control below reproduces exactly that against the UNLOCKED body, so a green
// fixed-path assertion cannot be green merely because the harness never raced.

const { expect }    = require('chai');
const RewardTracker = require('../../src/RewardTracker');

const PK_LOW  = 'aa'.repeat(32);
const PK_HIGH = 'bb'.repeat(32);
const ROUND   = 42;
const TYPE    = 'anchor_BTC';
const BLOCK   = 100;

// In-memory validator_rewards honouring UNIQUE (validator_pubkey, round_number,
// reward_type). The SELECT yields to the event loop before answering, which is what
// makes the interleave deterministic rather than timing-dependent.
function makeTracker() {
    let rows = [];
    let db = {
        async doQuery(sql, params) {
            params = params || [];
            if (sql.indexOf('SELECT validator_pubkey, batch_seq FROM validator_rewards') === 0) {
                // Read at ISSUE time, answer later: a real SELECT sees the table as it
                // stood when the server ran it, and two handlers that both issue before
                // either INSERT lands both see it empty. That is the TOCTOU window.
                let snapshot = rows.filter(r => Number(r.round_number) === Number(params[0]) &&
                                                r.reward_type === params[1])
                                   .map(r => ({ validator_pubkey: r.validator_pubkey, batch_seq: r.batch_seq }));
                await new Promise(r => setImmediate(r));
                return snapshot;
            }
            if (sql.indexOf('DELETE FROM validator_rewards') === 0) {
                rows = rows.filter(r => !(Number(r.round_number) === Number(params[0]) &&
                                          r.reward_type === params[1] && r.batch_seq == null));
                return [];
            }
            if (sql.indexOf('INSERT IGNORE INTO validator_rewards') === 0) {
                let [pk, round, type, amount, blockIndex] = params;
                let dup = rows.some(r => r.validator_pubkey === pk &&
                                         Number(r.round_number) === Number(round) && r.reward_type === type);
                if (!dup) rows.push({ validator_pubkey: pk, round_number: Number(round), reward_type: type,
                                      amount: amount, block_index: blockIndex, batch_seq: null });
                return [];
            }
            return [];
        }
    };
    let hub = { db, network: '', p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '10.00000000' } };
    let rt  = new RewardTracker(hub);
    rt._pushRewardsToBtcIndexer = async () => {};      // no network from a unit test
    return { rt, rows: () => rows };
}

describe('RewardTracker #4182 anchor reward dedup is atomic across failover publishers', function () {

    it('CONTROL: the unlocked body still double-mints under the same interleave', async function () {
        let { rt, rows } = makeTracker();
        await Promise.all([
            rt._recordAnchorRewardLocked(TYPE, ROUND, PK_HIGH, BLOCK, ''),
            rt._recordAnchorRewardLocked(TYPE, ROUND, PK_LOW,  BLOCK, '')
        ]);
        expect(rows().length, 'the original defect must reproduce, or the fixed case proves nothing').to.equal(2);
    });

    it('two concurrent failover publishers leave exactly ONE row, the smallest pubkey', async function () {
        let { rt, rows } = makeTracker();
        await Promise.all([
            rt.recordAnchorReward(TYPE, ROUND, PK_HIGH, BLOCK, ''),
            rt.recordAnchorReward(TYPE, ROUND, PK_LOW,  BLOCK, '')
        ]);
        expect(rows().length).to.equal(1);
        expect(rows()[0].validator_pubkey).to.equal(PK_LOW);
    });

    it('holds in the other arrival order too', async function () {
        let { rt, rows } = makeTracker();
        await Promise.all([
            rt.recordAnchorReward(TYPE, ROUND, PK_LOW,  BLOCK, ''),
            rt.recordAnchorReward(TYPE, ROUND, PK_HIGH, BLOCK, '')
        ]);
        expect(rows().length).to.equal(1);
        expect(rows()[0].validator_pubkey).to.equal(PK_LOW);
    });

    it('a DIFFERENT logical anchor is not serialized behind it', async function () {
        let { rt, rows } = makeTracker();
        await Promise.all([
            rt.recordAnchorReward(TYPE, ROUND,     PK_LOW,  BLOCK, ''),
            rt.recordAnchorReward(TYPE, ROUND + 1, PK_HIGH, BLOCK, ''),
            rt.recordAnchorReward('anchor_DOGE', ROUND, PK_HIGH, BLOCK, '')
        ]);
        expect(rows().length, 'three distinct anchors, three rows').to.equal(3);
    });

    it('replaying the same pubkey stays idempotent', async function () {
        let { rt, rows } = makeTracker();
        await rt.recordAnchorReward(TYPE, ROUND, PK_LOW, BLOCK, '');
        await rt.recordAnchorReward(TYPE, ROUND, PK_LOW, BLOCK, '');
        expect(rows().length).to.equal(1);
    });

    it('never displaces a row that already rode an on-chain archive', async function () {
        let { rt, rows } = makeTracker();
        await rt.recordAnchorReward(TYPE, ROUND, PK_HIGH, BLOCK, '');
        rows()[0].batch_seq = 3;                                   // archived: immutable, canonical fleet-wide
        await rt.recordAnchorReward(TYPE, ROUND, PK_LOW, BLOCK, '');
        expect(rows().length).to.equal(1);
        expect(rows()[0].validator_pubkey, 'the archived winner stands').to.equal(PK_HIGH);
    });

    it('releases the lock map once a key drains', async function () {
        let { rt } = makeTracker();
        await Promise.all([
            rt.recordAnchorReward(TYPE, ROUND, PK_LOW,  BLOCK, ''),
            rt.recordAnchorReward(TYPE, ROUND, PK_HIGH, BLOCK, '')
        ]);
        expect(rt._anchorLocks.size, 'no unbounded growth on a long-lived hub').to.equal(0);
    });
});
