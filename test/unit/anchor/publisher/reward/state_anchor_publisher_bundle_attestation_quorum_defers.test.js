'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');

const ME    = 'ab'.repeat(32);
const SIG   = 'ef'.repeat(64);
const GROUP = [{ chain: 'BTC', block_index: 10, checkpoint_seq: 1, snapshot_block: 50 }];

function makePublisher(round) {
    let pub = Object.create(StateAnchorPublisher.prototype);
    pub.unattestedDeferrals = 0;
    pub.rounds = 0;
    pub.runPublisherAttestationRound = async () => { pub.rounds++; return round; };
    return pub;
}

// A count-0 tail is refused by the indexer's bundle parser, so a missed quorum
// defers the bundle rather than publishing it unattested.
describe('StateAnchorPublisher: a bundle with no attestation defers', function () {
    it('defers a bundle whose attestation round misses quorum at the flag-day', async function () {
        let pub = makePublisher({ met: false, sigs: [] });
        let result = await pub.collectBundleAttestation(GROUP, ME, 'BTC', 'mainnet', 961000);
        expect(result).to.equal(null);
        expect(pub.rounds).to.equal(1);
        expect(pub.unattestedDeferrals).to.equal(1);
    });

    it('returns the attestation sigs when the round meets quorum at the flag-day', async function () {
        let sigs = [{ pubkey: ME, sig: SIG }];
        let pub = makePublisher({ met: true, sigs });
        let result = await pub.collectBundleAttestation(GROUP, ME, 'BTC', 'mainnet', 961000);
        expect(result).to.deep.equal({ attested: true, attestSigs: sigs });
        expect(pub.rounds).to.equal(1);
        expect(pub.unattestedDeferrals).to.equal(0);
    });
});
