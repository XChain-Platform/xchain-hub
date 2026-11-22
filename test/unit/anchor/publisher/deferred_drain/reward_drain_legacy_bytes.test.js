'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The hub's legacy-byte screen reads the same list the binding's legacyDropped filter removes,
// so a byte the indexer stops proving is a byte the hub drain screens.

const { expect } = require('chai');
const { LEGACY_BYTES, hasLegacyByteRow } = require('../../../../../src/anchor/publisher/legacy_reward_pin.js');
const { REWARD_FAMILY_VERSIONS, ATTESTED_VERSIONS, rewardFamilyVersions } = require('../../../../../src/anchor/anchor_proof_binding.js');

// Every byte the binding's legacyDropped form removes, family by family.
function droppedBytes(){
    let out = [];
    for(const f of Object.keys(REWARD_FAMILY_VERSIONS)){
        let kept = rewardFamilyVersions(f, { legacyDropped: true });
        for(const v of rewardFamilyVersions(f)) if(!kept.includes(v)) out.push(v);
    }
    return out;
}

describe('hub reward drain legacy byte list', () => {
    it('equals the set the binding drops under legacyDropped', () => {
        expect([...LEGACY_BYTES].sort((a, b) => a - b)).to.deep.equal([...new Set(droppedBytes())].sort((a, b) => a - b));
    });

    it('holds only attested bytes and is read-only', () => {
        for(const v of LEGACY_BYTES) expect(ATTESTED_VERSIONS).to.include(v);
        expect(Object.isFrozen(LEGACY_BYTES)).to.equal(true);
    });

    // A change to the binding's dropped bytes lands here first: the hub now screens the new byte
    // under the same gate, so confirm the byte belongs behind that gate before moving this pin.
    it('is the pre-restart pair 6 and 7 today', () => {
        expect([...LEGACY_BYTES]).to.deep.equal([6, 7]);
    });

    it('screens every byte the binding drops', () => {
        for(const v of droppedBytes()) expect(hasLegacyByteRow([{ version: v }]), 'byte ' + v).to.equal(true);
    });

    it('does not screen a byte the binding keeps under legacyDropped', () => {
        let dropped = droppedBytes();
        for(const f of Object.keys(REWARD_FAMILY_VERSIONS)){
            for(const v of rewardFamilyVersions(f, { legacyDropped: true })){
                expect(dropped).to.not.include(v);
                expect(hasLegacyByteRow([{ version: v }]), 'byte ' + v).to.equal(false);
            }
        }
    });

    it('reads one legacy row among kept rows and coerces a string version', () => {
        expect(hasLegacyByteRow([{ version: 0 }, { version: 7 }])).to.equal(true);
        expect(hasLegacyByteRow([{ version: '6' }])).to.equal(true);
    });

    it('is false for an empty or malformed anchor set', () => {
        for(const bad of [[], null, undefined, 'x', {}, [null], [{}]]) expect(hasLegacyByteRow(bad)).to.equal(false);
    });
});
