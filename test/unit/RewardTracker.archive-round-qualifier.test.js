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

// The anchor_archive leg keys on MATCH_BATCH_SEQ, a dense counter the hub allocates from
// its own tables, and a wipe-and-replay rebase reissues seq values earlier archive batches
// already used. Two genuinely distinct archive anchors - different snapshot blocks,
// different quorum-attested publishes - then present the same round_number, and every site
// keyed on (reward_type, round_number) alone collapsed them into one: the dedup guard
// dropped the second reward, and the follower cross-check then refused to co-sign a
// perfectly valid archive because "our local rows credit someone else". round_qualifier
// (src/anchor_reward_key.js: snapshot_block for the archive leg, 0 for every other type)
// is what tells them apart.
//
// Both suites carry a CONTROL that drives the SAME code against a database which still
// collapses on the reduced key - which is exactly what an un-migrated hub is - so a green
// fixed-path assertion cannot be green merely because the harness never presented the
// collision.

const { expect }           = require('chai');
const RewardTracker        = require('../../src/RewardTracker');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

const PK_LOW   = 'aa'.repeat(32);
const PK_HIGH  = 'bb'.repeat(32);
const SEQ      = 7;                  // the reissued MATCH_BATCH_SEQ both archives present
const TYPE     = 'anchor_archive';
const AMOUNT   = '10.00000000';
const SNAP_OLD = 953200;             // the pre-rebase archive's snapshot block
const SNAP_NEW = 961500;             // the post-rebase archive's snapshot block

// In-memory validator_rewards. `qualified` picks which UNIQUE key the table enforces and
// whether it honours an `AND round_qualifier = ?` clause: true is the migrated hub, false
// is the un-migrated one (and the pre-fix code path), which is the control.
function makeTracker(qualified) {
    let rows = [];
    const matches = (r, params) => Number(r.round_number) === Number(params[0]) &&
                                   r.reward_type === params[1] &&
                                   (!qualified || Number(r.round_qualifier) === Number(params[2]));
    let db = {
        async doQuery(sql, params) {
            params = params || [];
            if (sql.indexOf('SELECT validator_pubkey, batch_seq FROM validator_rewards') === 0)
                return rows.filter(r => matches(r, params))
                           .map(r => ({ validator_pubkey: r.validator_pubkey, batch_seq: r.batch_seq }));
            if (sql.indexOf('DELETE FROM validator_rewards') === 0) {
                rows = rows.filter(r => !(matches(r, params) && r.batch_seq == null));
                return [];
            }
            if (sql.indexOf('INSERT IGNORE INTO validator_rewards') === 0) {
                let [pk, round, type, amount, blockIndex, qualifier] = params;
                let dup = rows.some(r => r.validator_pubkey === pk &&
                                         Number(r.round_number) === Number(round) &&
                                         r.reward_type === type &&
                                         (!qualified || Number(r.round_qualifier) === Number(qualifier)));
                if (!dup) rows.push({ validator_pubkey: pk, round_number: Number(round), reward_type: type,
                                      amount: amount, block_index: blockIndex, batch_seq: null,
                                      round_qualifier: Number(qualifier || 0) });
                return [];
            }
            return [];
        }
    };
    let hub = { db, network: '', p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: AMOUNT } };
    return { rt: new RewardTracker(hub), rows: () => rows };
}

describe('RewardTracker archive rewards survive a reissued batch_seq', function () {

    it('CONTROL: a hub still keyed on (round, type) alone loses one of the two archives', async function () {
        let { rt, rows } = makeTracker(false);
        await rt.recordAnchorReward(TYPE, SEQ, PK_LOW,  SNAP_OLD, '');
        await rt.recordAnchorReward(TYPE, SEQ, PK_HIGH, SNAP_NEW, '');
        expect(rows().length,
            'the original defect must reproduce here, or the fixed case below proves nothing').to.equal(1);
        expect(rows()[0].block_index, 'the second, genuinely distinct archive was dropped').to.equal(SNAP_OLD);
    });

    it('records BOTH archives when their snapshot blocks differ', async function () {
        let { rt, rows } = makeTracker(true);
        await rt.recordAnchorReward(TYPE, SEQ, PK_LOW,  SNAP_OLD, '');
        await rt.recordAnchorReward(TYPE, SEQ, PK_HIGH, SNAP_NEW, '');
        expect(rows().length).to.equal(2);
        expect(rows().map(r => r.round_qualifier).sort((a, b) => a - b)).to.deep.equal([SNAP_OLD, SNAP_NEW]);
    });

    it('holds in the other arrival order, and the lower pubkey does not delete the twin', async function () {
        let { rt, rows } = makeTracker(true);
        await rt.recordAnchorReward(TYPE, SEQ, PK_HIGH, SNAP_NEW, '');
        await rt.recordAnchorReward(TYPE, SEQ, PK_LOW,  SNAP_OLD, '');
        expect(rows().length).to.equal(2);
    });

    it('still collapses two pubkeys competing for the SAME archive to the lowest', async function () {
        let { rt, rows } = makeTracker(true);
        await rt.recordAnchorReward(TYPE, SEQ, PK_HIGH, SNAP_NEW, '');
        await rt.recordAnchorReward(TYPE, SEQ, PK_LOW,  SNAP_NEW, '');
        expect(rows().length, 'one logical anchor, one row').to.equal(1);
        expect(rows()[0].validator_pubkey).to.equal(PK_LOW);
    });

    it('leaves the per-chain legs on exactly the key they had (qualifier 0)', async function () {
        let { rt, rows } = makeTracker(true);
        await rt.recordAnchorReward('anchor_BTC', SEQ, PK_HIGH, SNAP_NEW, '');
        await rt.recordAnchorReward('anchor_BTC', SEQ, PK_LOW,  SNAP_OLD, '');
        expect(rows().length, 'a height-keyed leg must not gain a second identity').to.equal(1);
        expect(rows()[0].round_qualifier).to.equal(0);
        expect(rows()[0].validator_pubkey).to.equal(PK_LOW);
    });

    it('stays idempotent on a replay of the same archive', async function () {
        let { rt, rows } = makeTracker(true);
        await rt.recordAnchorReward(TYPE, SEQ, PK_LOW, SNAP_NEW, '');
        await rt.recordAnchorReward(TYPE, SEQ, PK_LOW, SNAP_NEW, '');
        expect(rows().length).to.equal(1);
    });
});

// ---------------------------------------------------------------------------
// The follower co-sign cross-check, the second site keyed on the reduced identity.
// ---------------------------------------------------------------------------

function srcOf(pk) { return 'src_' + String(pk).toLowerCase().substring(0, 12); }

function localRow(pk, snapshotBlock) {
    return { validator_pubkey: pk, reward_type: TYPE, round_number: SEQ,
             amount: AMOUNT, block_index: snapshotBlock, round_qualifier: snapshotBlock };
}

function archivedReward(pk, snapshotBlock) {
    return { validator_pubkey: pk, source: srcOf(pk), round_number: SEQ,
             reward_type: TYPE, amount: AMOUNT, block_index: snapshotBlock };
}

// Query-faithful like the cross-pubkey guard's mock: it honours the round_qualifier clause only when the
// SQL actually carries one, so the pre-fix (unqualified) query reproduces its real
// cross-archive match instead of being masked by a qualifier-agnostic mock.
function makePublisher(localRewardRows, oraclePublishSet) {
    const db = {
        async doQuery(sql, params) {
            params = params || [];
            if (sql.startsWith('SELECT validator_pubkey, amount, block_index FROM validator_rewards')) {
                let rows = localRewardRows.filter(r =>
                    r.reward_type === params[0] && Number(r.round_number) === Number(params[1]));
                if (/round_qualifier = \?/.test(sql))
                    rows = rows.filter(r => Number(r.round_qualifier) === Number(params[2]));
                return rows;
            }
            return [];
        }
    };
    const setRows = oraclePublishSet.map(pk => ({ pubkey: pk, amount: '1', weight: '1', source: srcOf(pk) }));
    const hub = {
        db,
        network: '',
        p2pConfig: { ANCHOR_ENABLED: 'false' },
        capabilitySnapshot: {
            async getSnapshot()       { return { validators: setRows }; },
            async getWeightSnapshot() { return { validators: setRows }; }
        },
        rewardTracker: { anchorReward: AMOUNT, resolveSourceByPubkey: async (pk) => srcOf(pk) }
    };
    return new StateAnchorPublisher(hub);
}

const verify = async (pub, reward, snapshotBlock) => {
    let set   = await pub._resolveCapabilitySet('oracle_publish', snapshotBlock, '');
    let snaps = set.map(v => ({ snapshot_block: snapshotBlock, capability: 'oracle_publish',
                                signing_pubkey: v.pubkey, amount: v.amount, source: v.source }));
    return pub._verifyArchiveAgainstLocal({ matches: [], calls: [], rewards: [reward],
                                            capability_snapshots: snaps });
};

describe('StateAnchorPublisher co-signs the archive its own snapshot block names', function () {

    it('CONTROL: an unqualified local read makes the older archive refuse the newer one', async function () {
        const pub = makePublisher([localRow(PK_LOW, SNAP_OLD)], [PK_LOW, PK_HIGH]);
        // Force the pre-fix predicate by stripping the qualifier clause the fix added.
        const real = pub.db.doQuery.bind(pub.db);
        pub.db.doQuery = (sql, params) => real(sql.replace(' AND round_qualifier = ?', ''), params);
        expect(await verify(pub, archivedReward(PK_HIGH, SNAP_NEW), SNAP_NEW),
            'the stall this fix ends must reproduce, or the fixed case proves nothing').to.equal(false);
    });

    it('co-signs a valid archive whose seq an earlier archive already used', async function () {
        const pub = makePublisher([localRow(PK_LOW, SNAP_OLD), localRow(PK_HIGH, SNAP_NEW)], [PK_LOW, PK_HIGH]);
        expect(await verify(pub, archivedReward(PK_HIGH, SNAP_NEW), SNAP_NEW)).to.equal(true);
    });

    it('still REFUSES a credit to a pubkey we did not derive for THIS archive', async function () {
        const pub = makePublisher([localRow(PK_LOW, SNAP_NEW)], [PK_LOW, PK_HIGH]);
        expect(await verify(pub, archivedReward(PK_HIGH, SNAP_NEW), SNAP_NEW)).to.equal(false);
    });
});
