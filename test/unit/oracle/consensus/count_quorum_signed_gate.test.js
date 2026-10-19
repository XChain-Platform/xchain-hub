'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const { expect } = require('chai');
const registry = require('../../../../src/consensus/gate_registry.js');
const commit = require('../../../../src/oracle/consensus/commit.js');

const KEY = 'oracle/consensus/commit.COUNT_QUORUM_SIGNED_ACTIVATION';
const MEMBERS = new Set(['a', 'b', 'c']);
const VOTES = new Set(['a', 'b']);

function pending(signers, height = 100) {
    return {
        weighted: false,
        quorum: 2,
        memberPubkeys: MEMBERS,
        signatures: new Map(signers.map((key) => [key, 'signature'])),
        btcBlockHeight: height,
    };
}

function context(network) {
    return {
        hub: { network },
        getQuorum: () => 2,
        countDistinctMembers: commit.countDistinctMembers,
    };
}

describe('oracle count quorum signed activation', function () {
    it('is armed from regtest genesis and on testnet at its v0.25.0 heights', function () {
        // The v0.25.0 cut arms BTC:testnet 157073, LTC:testnet 4928460, DOGE:testnet 68009330.
        expect(registry.get(KEY)).to.deep.equal({
            mainnet: registry.UNARMED,
            'BTC:testnet': 157073,
            'LTC:testnet': 4928460,
            'DOGE:testnet': 68009330,
            testnet: registry.UNARMED,
            regtest: 0,
        });
    });

    it('counts verified member signatures on regtest', function () {
        expect(commit.quorumMet.call(context('regtest'), pending(['a', 'outside']), VOTES)).to.equal(false);
        expect(commit.quorumMet.call(context('regtest'), pending(['a', 'b']), VOTES)).to.equal(true);
    });

    it('keeps tallying the vote set below activation', function () {
        expect(commit.quorumMet.call(context('regtest'), pending(['a', 'outside'], -1), VOTES)).to.equal(true);
        expect(commit.quorumMet.call(context('mainnet'), pending(['a', 'outside']), VOTES)).to.equal(true);
        expect(commit.quorumMet.call(context('testnet'), pending([]), VOTES)).to.equal(true);
    });

    it('leaves countDistinctMembers unchanged', function () {
        expect(commit.countDistinctMembers(pending([]), VOTES)).to.equal(2);
        expect(commit.countDistinctMembers({ memberPubkeys: null }, VOTES)).to.equal(2);
    });
});
