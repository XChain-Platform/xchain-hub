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

// Pins archive rank-0 failover under checkpoint churn: with a 36-block election
// tolerance and a checkpoint every six blocks, the election anchor stays on the
// oldest pending checkpoint, so rank 1 unlocks only once six intervals have passed,
// and the leader gate and the follower gate agree on that block.

const assert = require('node:assert/strict');
const archiveBuildMethods = require('../../../../../src/anchor/publisher/archive/build.js');
const archiveRoundMethods = require('../../../../../src/anchor/publisher/archive/round.js');
const archiveSignMethods = require('../../../../../src/anchor/publisher/archive/sign.js');

describe('archive checkpoint churn', function () {

    it('replaces a silent archive rank 0 after six checkpoint intervals with follower agreement', function () {
        const methods = Object.assign({
            electionToleranceBlocks: 36,
            isRankZero(order){ return order[0] === this.me; }
        }, archiveBuildMethods, archiveRoundMethods, archiveSignMethods);
        const pubkeys = ['11', '22', '33', '44'].map(value => value.repeat(32));
        const checkpoints = [];
        const rankOnePublishBlocks = [];
        let rankOne;

        for(let block = 100, checkpointSeq = 0; block <= 136; block += 6, checkpointSeq++){
            const cp = { chain: 'BTC', network: 'regtest', snapshot_block: block,
                         checkpoint_seq: checkpointSeq };
            checkpoints.push(cp);
            const archive = { state_checkpoints: checkpoints.slice() };
            const probe = methods.archiveElectionDecision(cp, archive, pubkeys, pubkeys[0], block);
            if(rankOne === undefined) rankOne = probe.order[1];
            assert.equal(probe.order[1], rankOne);
            assert.equal(methods.archiveElectionDecision(
                cp, archive, pubkeys, probe.order[0], block).unlocked, true);
            const decision = methods.archiveElectionDecision(cp, archive, pubkeys, rankOne, block);
            const leaderLocked = methods.archiveRankLocked(
                cp, pubkeys, rankOne, block, 0, false, archive);
            const followerUnlocked = methods.archiveSenderUnlocked(
                pubkeys, cp, rankOne, block, archive);

            assert.equal(decision.anchor.block, 100);
            assert.equal(leaderLocked, !decision.unlocked);
            assert.equal(followerUnlocked, decision.unlocked);
            assert.equal(decision.unlocked, block >= 136);
            if(!leaderLocked && followerUnlocked) rankOnePublishBlocks.push(block);
        }

        const finalCp = checkpoints[checkpoints.length - 1];
        const finalDecision = methods.archiveElectionDecision(
            finalCp, { state_checkpoints: checkpoints }, pubkeys, rankOne, 136);
        assert.equal(finalDecision.since, 36);
        assert.equal(finalDecision.unlocked, true);
        assert.deepEqual(rankOnePublishBlocks, [136]);
    });

});
