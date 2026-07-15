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

// Regression guard for the archive reward cross-pubkey check in
// StateAnchorPublisher._verifyArchiveAgainstLocal (finding #4383).
//
// This is the only follower-side gate that stops a Byzantine elected archive
// leader from collecting a co-sign quorum for a fabricated reward. It must
// reject a leader that credits an eligible-but-non-winning oracle_publish
// member while honest followers hold the real deterministic winner W for that
// (reward_type, round_number). Commit 5ef4dbd keyed the local-row query on the
// archived pubkey itself ("... AND validator_pubkey = ?"), which made the
// divergence test dead code: the query could only return a row for the
// archived pubkey or, when that pubkey was not held locally, return empty and
// fall through to "predates our history; accept on re-derivation". The fix
// queries ALL local rows for the (reward_type, round_number) pair and rejects
// when rows exist but none is for the archived pubkey.
//
// The db mock here is QUERY-FAITHFUL: it honors a "validator_pubkey = ?"
// clause and a "LIMIT 1" if the SQL carries them. So the broken pubkey-keyed
// query reproduces its real empty-result behaviour and these tests fail,
// rather than masking the regression the way a pubkey-agnostic mock would.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

const PK_WINNER = 'aa'.repeat(32);   // W: the row every honest hub derives + holds
const PK_OTHER  = 'bb'.repeat(32);   // X: an eligible publisher that did NOT win
const ROUND     = 7;
const TYPE      = 'anchor_BTC';
const AMOUNT    = '10.00000000';
const BLOCK     = 100;

function srcOf(pk) { return 'src_' + String(pk).toLowerCase().substring(0, 12); }

function localRow(pk, over) {
    return Object.assign({
        validator_pubkey: pk, reward_type: TYPE, round_number: ROUND,
        amount: AMOUNT, block_index: BLOCK
    }, over || {});
}

function archivedReward(pk, over) {
    return Object.assign({
        validator_pubkey: pk, source: srcOf(pk), round_number: ROUND,
        reward_type: TYPE, amount: AMOUNT, block_index: BLOCK
    }, over || {});
}

function makePublisher(localRewardRows, oraclePublishSet) {
    const db = {
        async doQuery(sql, params) {
            params = params || [];
            if (sql.startsWith('SELECT validator_pubkey, amount, block_index FROM validator_rewards')) {
                let rows = localRewardRows.filter(r =>
                    r.reward_type === params[0] && Number(r.round_number) === Number(params[1]));
                if (/validator_pubkey = \?/.test(sql))
                    rows = rows.filter(r => String(r.validator_pubkey).toLowerCase() === String(params[2]).toLowerCase());
                if (/LIMIT 1/.test(sql)) rows = rows.slice(0, 1);
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
        rewardTracker: {
            anchorReward: AMOUNT,
            resolveSourceByPubkey: async (pk) => srcOf(pk)
        }
    };
    return new StateAnchorPublisher(hub);
}

const verify = (pub, ar) =>
    pub._verifyArchiveAgainstLocal({ matches: [], calls: [], rewards: [ar], capability_snapshots: [] });

describe('StateAnchorPublisher #4383 archive reward cross-pubkey guard', function () {

    it('accepts the real winner this hub holds', async function () {
        const pub = makePublisher([localRow(PK_WINNER)], [PK_WINNER, PK_OTHER]);
        expect(await verify(pub, archivedReward(PK_WINNER))).to.equal(true);
    });

    it('REJECTS a misattributed credit to an eligible non-winner while we hold the winner', async function () {
        // W = PK_WINNER held locally; the leader archives X = PK_OTHER (a member
        // of the oracle_publish set at the earn block, so it clears the
        // membership + amount + source checks) for the SAME (type, round). Every
        // honest hub holds W, never X, so it must refuse to co-sign.
        const pub = makePublisher([localRow(PK_WINNER)], [PK_WINNER, PK_OTHER]);
        expect(await verify(pub, archivedReward(PK_OTHER))).to.equal(false);
    });

    it('REJECTS an inflated second reward for a round already credited to one winner', async function () {
        // Only PK_WINNER earned round 7. A Byzantine leader adds a duplicate
        // reward crediting PK_OTHER for that same round (the inflation axis): we
        // never derived a PK_OTHER row, so the cross-check rejects it.
        const pub = makePublisher([localRow(PK_WINNER)], [PK_WINNER, PK_OTHER]);
        expect(await verify(pub, archivedReward(PK_OTHER))).to.equal(false);
    });

    it('tolerates the transient failover window where BOTH pubkeys legitimately hold rows', async function () {
        // The benefit commit 5ef4dbd was protecting: under a failover
        // double-publish two pubkeys can co-exist for one (type, round). When the
        // hub holds both, archiving either is matched and accepted.
        const pub = makePublisher([localRow(PK_WINNER), localRow(PK_OTHER)], [PK_WINNER, PK_OTHER]);
        expect(await verify(pub, archivedReward(PK_WINNER))).to.equal(true);
        expect(await verify(pub, archivedReward(PK_OTHER))).to.equal(true);
    });

    it('tolerates a genuine late joiner that holds no row for the round', async function () {
        // No local rows at all for (type, round): re-derivation alone bounds the
        // reward, so a late joiner still co-signs.
        const pub = makePublisher([], [PK_WINNER, PK_OTHER]);
        expect(await verify(pub, archivedReward(PK_WINNER))).to.equal(true);
    });

    it('still rejects a divergent amount on the held winner row', async function () {
        const pub = makePublisher([localRow(PK_WINNER, { amount: '9.00000000' })], [PK_WINNER]);
        expect(await verify(pub, archivedReward(PK_WINNER))).to.equal(false);
    });
});
