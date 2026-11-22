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

const { expect } = require('chai');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const { foldPublisherMethods } = require('../../../../../src/anchor/publisher/canonical_forms.js');

function setup(){
    const leader = new ValidatorIdentity('11'.repeat(32));
    const follower = new ValidatorIdentity('22'.repeat(32));
    const canonical = 'mixed-height-fold-round';
    const validators = [leader, follower].map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1'
    }));
    const pub = Object.assign({
        archiveFoldSubdeadlineMs: 5000,
        roundTimeoutMs: 5000,
        quorumVerified: (_canonical, signatures) => signatures.length === validators.length
    }, foldPublisherMethods);
    const round = {
        cp: { network: 'regtest', chain: 'BTC', snapshot_block: 100 },
        canonical,
        validators,
        weighted: false,
        signatures: [{ pubkey: validators[0].pubkey, sig: leader.sign(canonical) }]
    };
    pub.armFoldArchiveRound(round, { network: 'regtest', snapshot_block: 105 });
    return { pub, round, follower, followerPubkey: validators[1].pubkey };
}

describe('StateAnchorPublisher mixed-height fold-archive round', function () {
    it('accepts a member signature carrying the bundle maximum', async function () {
        const { pub, round, follower, followerPubkey } = setup();
        pub.acceptFoldArchiveSignature({
            network: 'regtest', snapshot_block: 105, sig_pubkey: followerPubkey,
            archive_sig: follower.sign(round.canonical)
        });
        expect(await round.result).to.equal(round);
    });

    it('does not substitute the wrapper checkpoint height for the bundle identity', function () {
        const { pub, round, follower, followerPubkey } = setup();
        pub.acceptFoldArchiveSignature({
            network: 'regtest', snapshot_block: 100, sig_pubkey: followerPubkey,
            archive_sig: follower.sign(round.canonical)
        });
        expect(round.signatures.size).to.equal(1);
        pub.finishFoldArchiveRound(round, null);
    });
});
