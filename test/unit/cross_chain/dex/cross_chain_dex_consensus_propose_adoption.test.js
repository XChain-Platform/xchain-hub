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

// A follower that adopts the leader's row writes the leader's and its own signature
// and runs the prepare-quorum check in the same synchronous step, so a PREPARE
// delivered on the first microtask after adoption is the vote that crosses quorum
// and the finalized signature list keeps the leader and this hub first.

const { expect }             = require('chai');
const CrossChainDexConsensus = require('../../../../src/cross_chain/dex_consensus');
const ValidatorIdentity      = require('../../../../src/validators/identity');

const MATCH_ID = 'm1';

// Canonical over the fields this test moves; the leader's row differs from the
// round's own only in effective_time, so the snapshot does not need a rebind.
function canonicalMatch(row, view) {
    return ['XMATCH', row.match_id, String(row.snapshot_block), row.network, String(row.effective_time), String(view || 0)].join('|');
}

function identity(n) {
    return new ValidatorIdentity(String(10 + n).repeat(32).slice(0, 64));
}

// A follower holding a round over its own pre-built row, the four identities
// named by role (leader chosen by the consensus's own leaderFor), and the broadcasts it sends.
function buildRound() {
    let keys = [0, 1, 2, 3].map(identity);
    let validators = keys.map((k) => ({ pubkey: k.getPubkeyHex().toLowerCase() }));
    let leaderPk = CrossChainDexConsensus.prototype.leaderFor(MATCH_ID, validators, 0);
    let leader = keys.find((k) => k.getPubkeyHex().toLowerCase() === leaderPk);
    let [self, v2, v3] = keys.filter((k) => k !== leader);

    let broadcasts = [];
    let engine = {
        hub: { p2pConfig: {} },
        peerManager: { broadcast: (type) => broadcasts.push(String(type)) },
        identity: self,
        capSnapshot: null,
        canonicalMatch,
        validateProposedMatch: async () => true
    };
    let consensus = new CrossChainDexConsensus(engine, {});
    let ownRow = { match_id: MATCH_ID, snapshot_block: 100, network: 'regtest', effective_time: 1700000000 };
    let round = {
        rid: MATCH_ID, row: ownRow, canonical: canonicalMatch(ownRow, 0), view: 0, validators, quorum: 3, weighted: false,
        myPubkey: self.getPubkeyHex().toLowerCase(), signatures: new Map(), prepares: new Set(), commits: new Set(),
        _commitSent: false, finalized: false, timer: null
    };
    consensus.pending.set(MATCH_ID, round);
    return { consensus, round, leader, self, v2, v3, broadcasts };
}

function pk(key) {
    return key.getPubkeyHex().toLowerCase();
}

describe('CrossChainDexConsensus PROPOSE adoption', function () {
    it('writes the leader and own PREPARE before a PREPARE arriving right after adoption', async function () {
        let { consensus, round, leader, self, v2, v3, broadcasts } = buildRound();
        let leaderRow = { match_id: MATCH_ID, snapshot_block: 100, network: 'regtest', effective_time: 1700000001 };
        let adopted = canonicalMatch(leaderRow, 0);

        // Prepare-vote count each time the round is tested for quorum, in order.
        let tallies = [];
        let checkPrepareQuorum = consensus.checkPrepareQuorum.bind(consensus);
        consensus.checkPrepareQuorum = (rid) => {
            tallies.push(consensus.pending.get(rid).prepares.size);
            return checkPrepareQuorum(rid);
        };

        // The earliest a gossip delivery can run once the round has taken the leader's
        // canonical is the next microtask, so deliver v2's PREPARE there.
        let canonical = round.canonical;
        let foundByPrepare = [];
        Object.defineProperty(round, 'canonical', {
            get: () => canonical,
            set: (next) => {
                canonical = next;
                queueMicrotask(() => {
                    foundByPrepare.push([...round.signatures.keys()].length);
                    consensus.handlePrepare({ data: { matchId: MATCH_ID, view: 0, sig_pubkey: pk(v2), sig: v2.sign(adopted) } });
                });
            }
        });

        let finalized = null;
        consensus.on('match:finalized', (event) => { finalized = event; });

        await consensus.handlePropose({ data: { matchId: MATCH_ID, view: 0, sig_pubkey: pk(leader), sig: leader.sign(adopted), row: leaderRow } });
        await new Promise((resolve) => setImmediate(resolve));
        for (let voter of [v2, v3]) {
            consensus.handleCommit({ data: { matchId: MATCH_ID, view: 0, sig_pubkey: pk(voter), sig: voter.sign(adopted),
                commit_sig: voter.sign(consensus.commitPayload(adopted)) } });
        }

        expect(round.canonical).to.equal(adopted);
        expect(foundByPrepare).to.deep.equal([2]);
        expect(tallies).to.deep.equal([2, 3]);
        expect(broadcasts.filter((type) => /COMMIT/.test(type))).to.have.length(1);
        expect(finalized, 'round finalized').to.not.equal(null);
        expect(finalized.signatures.map((s) => s.pubkey)).to.deep.equal([pk(leader), pk(self), pk(v2), pk(v3)]);
    });
});
