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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    supersedeWitnessDecline,
    checkpointHoldDecline,
} = require('../../../../src/anchor/checkpoint_engine/checkpoint_hold.js');

function checkpoint(overrides){
    return {
        block_index: 100,
        block_hash: 'aa',
        ledger_hash: '11',
        actions_hash: '22',
        contract_hash: '33',
        state_root: '44',
        ...overrides,
    };
}

function replay(overrides){
    return {
        replay: {
            state: 'replayed',
            target: 90,
            replay_to: 110,
            witness: 'passed',
            changed: true,
            ...overrides,
        },
    };
}

function acceptsOnlyPassedReplayWitness(){
    expect(supersedeWitnessDecline(replay())).to.equal(null);
    expect(supersedeWitnessDecline(replay({ witness: null })))
        .to.equal('supersede_unwitnessed');
    expect(supersedeWitnessDecline(null)).to.equal('supersede_unwitnessed');
}

function comparesHashesCaseInsensitively(){
    const row = checkpoint({
        block_hash: 'AA',
        ledger_hash: 'AB',
        actions_hash: 'CD',
        contract_hash: 'EF',
        state_root: '12',
    });
    const own = checkpoint({
        ledger_hash: 'ab',
        actions_hash: 'cd',
        contract_hash: 'ef',
        state_root: '12',
    });

    expect(checkpointHoldDecline(row, own, null)).to.equal(null);
}

function returnsReorgedFirstForBlockHashMismatch(){
    const row = checkpoint();
    const own = checkpoint({ block_hash: 'bb', ledger_hash: '99' });

    expect(checkpointHoldDecline(row, own, replay()))
        .to.equal('checkpoint_reorged');
}

function returnsDisagreementForOtherHashMismatch(){
    const fields = ['ledger_hash', 'actions_hash', 'contract_hash', 'state_root'];
    for(const field of fields){
        const own = checkpoint({ [field]: '99' });
        expect(checkpointHoldDecline(checkpoint(), own, null))
            .to.equal('checkpoint_disagreement');
    }
}

function ignoresUnavailableStateRoot(){
    expect(checkpointHoldDecline(
        checkpoint({ state_root: null }), checkpoint(), null
    )).to.equal(null);
    expect(checkpointHoldDecline(
        checkpoint(), checkpoint({ state_root: null }), null
    )).to.equal(null);
}

function acceptsCoveredDisagreement(){
    const own = checkpoint({ ledger_hash: '99' });

    expect(checkpointHoldDecline(checkpoint(), own, replay())).to.equal(null);
    expect(checkpointHoldDecline(
        checkpoint({ block_index: '100' }), own,
        replay({ target: '100', replay_to: '100' })
    )).to.equal(null);
}

function declinesIncompleteOrOutOfRangeReplay(){
    const row = checkpoint();
    const own = checkpoint({ ledger_hash: '99' });
    const cases = [
        replay({ state: 'replaying' }),
        replay({ witness: null }),
        replay({ changed: false }),
        replay({ target: 101 }),
        replay({ replay_to: 99 }),
        null,
    ];

    for(const rules of cases){
        expect(checkpointHoldDecline(row, own, rules))
            .to.equal('checkpoint_disagreement');
    }
}

describe('checkpoint hold rules', function checkpointHoldRulesSuite(){
    it('accepts only a passed replay witness', acceptsOnlyPassedReplayWitness);
    it('compares checkpoint hashes case-insensitively',
        comparesHashesCaseInsensitively);
    it('returns reorged first for block hash mismatch',
        returnsReorgedFirstForBlockHashMismatch);
    it('returns disagreement for each other hash mismatch',
        returnsDisagreementForOtherHashMismatch);
    it('ignores state_root unless both readings provide one',
        ignoresUnavailableStateRoot);
    it('accepts disagreement covered by witnessed replay',
        acceptsCoveredDisagreement);
    it('declines incomplete or out-of-range replay',
        declinesIncompleteOrOutOfRangeReplay);
});
