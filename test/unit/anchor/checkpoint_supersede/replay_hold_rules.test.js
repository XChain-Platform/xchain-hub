/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Checkpoint supersede replay holds and follower co-sign declines.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { indexerReplayOpen, supersedePrefilterDecline, supersedeStrictDecline, checkpointProposalDecline } =
    require('../../../../src/anchor/checkpoint_engine/replay_hold.js');

const DIGEST = 'ef'.repeat(32);

function replayRules(state){
    return { digest: DIGEST, replay: { state, target: 30, replay_to: 44 } };
}

describe('checkpoint supersede replay-hold rules @regression', function () {
    it('indexerReplayOpen holds only pending and replaying rules', function () {
        expect(indexerReplayOpen(replayRules('pending'))).to.equal(true);
        expect(indexerReplayOpen(replayRules('replaying'))).to.equal(true);
        expect(indexerReplayOpen(replayRules('replayed'))).to.equal(false);
        expect(indexerReplayOpen(null)).to.equal(false);
        expect(indexerReplayOpen({ digest: DIGEST, replay: null })).to.equal(false);
    });

    it('returns indexer_replaying before inspecting any checkpoint metadata', function () {
        expect(supersedePrefilterDecline({}, replayRules('replaying')))
            .to.equal('indexer_replaying');
        expect(supersedePrefilterDecline(null, replayRules('pending')))
            .to.equal('indexer_replaying');
    });

    it('accepts a plain checkpoint when no replay is open', function () {
        expect(supersedePrefilterDecline({}, replayRules('replayed'))).to.equal(null);
        expect(supersedePrefilterDecline({}, null)).to.equal(null);
    });

    it('returns supersede_no_replay without a completed replay body', function () {
        const cp = { supersedes_from: 30, rules_digest: DIGEST };
        expect(supersedePrefilterDecline(cp, null)).to.equal('supersede_no_replay');
        expect(supersedePrefilterDecline(cp, { digest: DIGEST, replay: null }))
            .to.equal('supersede_no_replay');
        expect(supersedePrefilterDecline(cp, replayRules('failed')))
            .to.equal('supersede_no_replay');
    });

});

describe('checkpoint supersede replay-hold rules @regression', function () {
    it('returns supersede_target_mismatch for another replay target', function () {
        const cp = { supersedes_from: 31, rules_digest: DIGEST };
        expect(supersedePrefilterDecline(cp, replayRules('replayed')))
            .to.equal('supersede_target_mismatch');
    });

    it('returns supersede_digest_mismatch for another rules digest', function () {
        const cp = { supersedes_from: 30, rules_digest: '00'.repeat(32) };
        expect(supersedePrefilterDecline(cp, replayRules('replayed')))
            .to.equal('supersede_digest_mismatch');
    });

    it('accepts a matching supersede with a case-insensitive digest', function () {
        const cp = { supersedes_from: '30', rules_digest: DIGEST.toUpperCase() };
        expect(supersedePrefilterDecline(cp, replayRules('replayed'))).to.equal(null);
    });

    it('names strict witness and disagreement requirements explicitly', function () {
        const cp = { supersedes_from: 30, rules_digest: DIGEST };
        const rules = replayRules('replayed');
        rules.replay.changed = true;
        expect(supersedeStrictDecline(cp, rules, { target: 30 })).to.equal('supersede_unwitnessed');
        rules.replay.witness = 'passed';
        rules.replay.changed = false;
        expect(supersedeStrictDecline(cp, rules, { target: 30 })).to.equal('supersede_no_disagreement');
        rules.replay.changed = true;
        expect(supersedeStrictDecline(cp, rules)).to.equal('supersede_no_disagreement');
        expect(supersedeStrictDecline(cp, rules, { target: 30 })).to.equal(null);
    });

    it('keeps checkpointProposalDecline on the strict fail-closed path', function () {
        const cp = { supersedes_from: 30, rules_digest: DIGEST };
        const rules = replayRules('replayed');
        rules.replay.witness = 'passed';
        rules.replay.changed = true;
        expect(checkpointProposalDecline(cp, { rules })).to.equal('supersede_no_disagreement');
    });
});
