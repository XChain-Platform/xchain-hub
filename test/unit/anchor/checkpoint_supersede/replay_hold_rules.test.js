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
const { indexerReplayOpen, supersedeCosignDecline } =
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
        expect(supersedeCosignDecline({}, replayRules('replaying')))
            .to.equal('indexer_replaying');
        expect(supersedeCosignDecline(null, replayRules('pending')))
            .to.equal('indexer_replaying');
    });

    it('accepts a plain checkpoint when no replay is open', function () {
        expect(supersedeCosignDecline({}, replayRules('replayed'))).to.equal(null);
        expect(supersedeCosignDecline({}, null)).to.equal(null);
    });

    it('returns supersede_no_replay without a completed replay body', function () {
        const cp = { supersedes_from: 30, rules_digest: DIGEST };
        expect(supersedeCosignDecline(cp, null)).to.equal('supersede_no_replay');
        expect(supersedeCosignDecline(cp, { digest: DIGEST, replay: null }))
            .to.equal('supersede_no_replay');
        expect(supersedeCosignDecline(cp, replayRules('failed')))
            .to.equal('supersede_no_replay');
    });

    it('returns supersede_target_mismatch for another replay target', function () {
        const cp = { supersedes_from: 31, rules_digest: DIGEST };
        expect(supersedeCosignDecline(cp, replayRules('replayed')))
            .to.equal('supersede_target_mismatch');
    });

    it('returns supersede_digest_mismatch for another rules digest', function () {
        const cp = { supersedes_from: 30, rules_digest: '00'.repeat(32) };
        expect(supersedeCosignDecline(cp, replayRules('replayed')))
            .to.equal('supersede_digest_mismatch');
    });

    it('accepts a matching supersede with a case-insensitive digest', function () {
        const cp = { supersedes_from: '30', rules_digest: DIGEST.toUpperCase() };
        expect(supersedeCosignDecline(cp, replayRules('replayed'))).to.equal(null);
    });
});
