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

// A follower opens its ATTEST round and counts the leader's and its own PREPARE in
// one synchronous step, so a PREPARE the gossip layer delivers on the first
// microtask after the round exists finds both votes already in the round.

const { expect }       = require('chai');
const CrossChainEngine = require('../../../src/cross_chain/engine');

const ATTESTATION_ID = 'BTC:7:DOGE';
const DIGEST         = 'digest-7';

// A follower whose snapshot and indexer reads resolve at once over a four-member
// set with a locked quorum of three, and which records every broadcast type.
function buildFollower() {
    let broadcasts = [];
    let hub = { getPeerManager: () => ({ broadcast: (type) => broadcasts.push(type) }), db: {}, p2pConfig: {}, network: 'regtest' };
    let engine = new CrossChainEngine(hub);
    engine.isKnownSender        = () => true;
    engine.digest               = () => DIGEST;
    engine.verifySourceAction   = async () => true;
    engine.resolveQuorum        = async () => 3;
    engine.resolveMemberPubkeys = async () => new Set(['leader', 'self', 'v2', 'v3']);
    engine.selfPubkey           = () => 'self';
    return { engine, broadcasts };
}

function envelope(pubkey, data) {
    return { sender: pubkey, sig_pubkey: pubkey, data };
}

describe('CrossChainEngine follower round open', function () {
    let engine;

    afterEach(function () {
        for (let round of engine.pendingAttestations.values()) if (round.timer) clearTimeout(round.timer);
    });

    it('holds the leader and own PREPARE before a PREPARE arriving right after the round opens', async function () {
        let built = buildFollower();
        engine = built.engine;

        // Prepare-vote count each time the round is tested for quorum, in order.
        let tallies = [];
        let checkPrepareQuorum = engine.checkPrepareQuorum.bind(engine);
        engine.checkPrepareQuorum = (id) => {
            tallies.push(engine.pendingAttestations.get(id).prepares.size);
            return checkPrepareQuorum(id);
        };

        // The earliest a gossip delivery can run once the round exists is the next
        // microtask, so deliver v2's PREPARE there and note what it finds.
        let foundByPrepare = [];
        let rounds = engine.pendingAttestations;
        let setRound = rounds.set.bind(rounds);
        rounds.set = (id, round) => {
            setRound(id, round);
            queueMicrotask(() => {
                foundByPrepare.push([...round.prepares].sort().join(','));
                engine.handlePrepare(envelope('v2', { attestationId: ATTESTATION_ID, digest: DIGEST }));
            });
            return rounds;
        };

        await engine.handlePropose(envelope('leader', {
            attestationId: ATTESTATION_ID, sourceChain: 'BTC', sourceActionIndex: 7, destChain: 'DOGE',
            confirmations: 6, digest: DIGEST, btcBlockHeight: 100
        }));
        await new Promise((resolve) => setImmediate(resolve));

        expect(foundByPrepare).to.deep.equal(['leader,self']);
        expect(tallies).to.deep.equal([2, 3]);
        expect([...rounds.get(ATTESTATION_ID).prepares].sort()).to.deep.equal(['leader', 'self', 'v2']);
        expect(built.broadcasts.filter((type) => /COMMIT/.test(type))).to.have.length(1);
    });
});
