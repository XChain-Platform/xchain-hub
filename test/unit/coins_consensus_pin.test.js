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

const { expect } = require('chai');
const coins      = require('../../src/coins');

function registerConsensusPinTests() {
    describe('consensus config pin', () => {
        const { CONSENSUS_CONFIG_PIN } = require('../../src/coins/consensus_pin.js');

        it('pins match the canonical hashes for every armed network/coin', () => {
            for(const net of coins.NETWORKS){
                const pin = CONSENSUS_CONFIG_PIN[net];
                if(pin === null || pin === undefined) continue; // mainnet skipped pre-arm
                for(const tick of coins.ALLOWED_COINS)
                    expect(pin[tick], `${tick}/${net}`).to.equal(coins.consensusHash(tick, net));
            }
        });

        it('mainnet is null (pin armed only in the Phase 6 coordinated release)', () => {
            expect(CONSENSUS_CONFIG_PIN.mainnet).to.equal(null);
        });

        it('verifyConsensusPin passes for armed networks and skips mainnet', () => {
            expect(coins.verifyConsensusPin('testnet')).to.deep.equal({ ok: true, skipped: false });
            expect(coins.verifyConsensusPin('regtest')).to.deep.equal({ ok: true, skipped: false });
            expect(coins.verifyConsensusPin('mainnet')).to.deep.equal({ ok: true, skipped: true });
        });

        it('consensusHashes returns a hash for every coin', () => {
            const h = coins.consensusHashes('regtest');
            expect(Object.keys(h)).to.deep.equal(coins.ALLOWED_COINS);
            expect(h.BTC).to.match(/^[0-9a-f]{64}$/);
        });
    });
}

describe('coins registry', () => {
    registerConsensusPinTests();
});
