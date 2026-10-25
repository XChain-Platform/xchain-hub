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
 * Checkpoint supersession field fill and gate refusal rules.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { supersedeFieldsFor, supersedeGateRefusal } =
    require('../../../../src/anchor/checkpoint_engine/supersede_fill.js');

const DIGEST = 'AB'.repeat(32);

function replayRules(state, target = '40') {
    return {
        digest: DIGEST,
        replay: { state, target, replay_to: 50, witness: 'passed', changed: true },
    };
}

describe('checkpoint supersede fill rules @regression', function () {
    it('fills exactly supersedes_from and rules_digest after replay completes', function () {
        const rules = replayRules('replayed');
        const finalizedRows = [{ rules_digest: 'ef'.repeat(32) }];

        expect(supersedeFieldsFor(rules, finalizedRows)).to.deep.equal({
            supersedes_from: 40,
            rules_digest: DIGEST.toLowerCase(),
        });
        expect(rules).to.deep.equal(replayRules('replayed'));
        expect(finalizedRows).to.deep.equal([{ rules_digest: 'ef'.repeat(32) }]);
    });

    it('leaves later checkpoints null after a case-insensitive digest match', function () {
        const finalizedRows = [{ rules_digest: DIGEST.toLowerCase() }];

        expect(supersedeFieldsFor(replayRules('replayed'), finalizedRows)).to.equal(null);
    });

    it('returns null while replay is open or absent', function () {
        expect(supersedeFieldsFor(replayRules('pending'), [])).to.equal(null);
        expect(supersedeFieldsFor(replayRules('replaying'), [])).to.equal(null);
        expect(supersedeFieldsFor(null, [])).to.equal(null);
        expect(supersedeFieldsFor({ digest: DIGEST, replay: null }, [])).to.equal(null);
    });

    it('returns null for a malformed digest or replay target', function () {
        expect(supersedeFieldsFor({
            digest: 'ab',
            replay: { state: 'replayed', target: 40, replay_to: 50, witness: 'passed', changed: true },
        }, [])).to.equal(null);

        for (const target of [null, true, '', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'not-a-number'])
            expect(supersedeFieldsFor(replayRules('replayed', target), [])).to.equal(null);
    });

    it('returns supersede_below_gate for supersede fields unless the gate is exactly true', function () {
        const complete = { supersedes_from: 40, rules_digest: DIGEST };

        expect(supersedeGateRefusal(complete, false)).to.equal('supersede_below_gate');
        expect(supersedeGateRefusal({ rules_digest: DIGEST })).to.equal('supersede_below_gate');
        expect(supersedeGateRefusal(complete, 1)).to.equal('supersede_below_gate');
        expect(supersedeGateRefusal(complete, true)).to.equal(null);
    });

    it('never refuses a plain checkpoint', function () {
        expect(supersedeGateRefusal({ block_index: 5 }, false)).to.equal(null);
        expect(supersedeGateRefusal(null, false)).to.equal(null);
    });
});
