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

// The XANCREWARD receiver sizes its count-path quorum from the RAW signing-set row count,
// the same size the producer round and the indexer's verifyAttestation use, so a key
// listed under two sources can never lower the bar the receiver holds a federation to.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const swqMod               = require('../../../../../src/consensus/stake_weighted_quorum.js');
const { DB_METHODS }       = require('../../../../helpers/mockHub.js');

const K = ['a1', 'b2', 'c3', 'd4'].map(h => h.repeat(32));

function quorumMet(rows, signers) {
    const pub = new StateAnchorPublisher({ db: { ...DB_METHODS }, network: 'regtest' });
    const pubkeys = new Set(rows.map(r => r.pubkey));
    return pub.federationQuorumMet(rows, pubkeys, signers, 'regtest', 100);
}

describe('StateAnchorPublisher XANCREWARD count-path quorum sizing', function () {
    let saved;
    before(function () {
        saved = swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest;
        swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = 999999999;   // count path at block 100
    });
    after(function () { swqMod.STAKE_WEIGHTED_QUORUM_ACTIVATION.regtest = saved; });

    it('one key under two sources needs two signers, as the indexer counts it', function () {
        const rows = [{ pubkey: K[0], source: 'a' }, { pubkey: K[0], source: 'b' }];
        expect(quorumMet(rows, [K[0]])).to.equal(false);
    });

    it('four rows over three keys need three signers', function () {
        const rows = [{ pubkey: K[0], source: 'a' }, { pubkey: K[0], source: 'b' },
                      { pubkey: K[1], source: 'c' }, { pubkey: K[2], source: 'd' }];
        expect(quorumMet(rows, [K[0], K[1]])).to.equal(false);
        expect(quorumMet(rows, [K[0], K[1], K[2]])).to.equal(true);
    });

    it('a set of distinct keys keeps the usual two-thirds bar', function () {
        const rows = K.map((pk, i) => ({ pubkey: pk, source: 's' + i }));
        expect(quorumMet(rows, K.slice(0, 3))).to.equal(true);
        expect(quorumMet(rows, K.slice(0, 2))).to.equal(false);
    });
});
