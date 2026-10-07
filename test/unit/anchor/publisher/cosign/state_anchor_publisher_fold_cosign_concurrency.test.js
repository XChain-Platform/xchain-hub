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
//
// StateAnchorPublisher: the fold-archive co-sign rides the bundle attestation
// request, and it must be released only for the request THIS call accepted.
// Two overlapping XANCPUB_SIGN_REQs, an elected leader's and a rank-locked
// peer's, must not credit each other: the rank-locked peer never enters the
// observed-leader set and never gets an archive_sig, and the shared broadcast
// is left exactly as it was found. The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const arMod                 = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const { XANCPUB_SIGN }      = require('../../../../../src/anchor/publisher/constants.js');
const { buildMesh, v0Order, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

// Build a three-node mesh in election order and instrument the follower.
function setup() {
    let bus      = buildMesh(3, { btcBlock: 100 });
    let order    = v0Order(bus);
    let leader   = order[0];
    let rogue    = order[1];   // a federation member, rank-locked at this BTC tip
    let follower = order[2];
    let row      = follower.db.checkpoints[0];
    function reqFrom(node) {
        let cp = node.pub.cpFromRow(row);
        return { data: {
            network: row.network, snapshot_block: Number(row.snapshot_block),
            publisher: node.pubkey, sig_pubkey: node.pubkey,
            sections: [{ chain: row.chain, block_index: row.block_index, checkpoint_seq: row.checkpoint_seq }],
            body: node.pub.buildV7Payload([row], node.pubkey, []),
            sig: node.identity.sign(node.pub.attestationCanonical(cp, node.pubkey))
        }};
    }
    let sent = [];
    let base = (type, data) => { sent.push({ type, data }); };
    follower.pub.peerManager.broadcast = base;
    // The archive half is not under test: accept any proposer's archive, so the
    // bundle handler's own election verdict is the only thing that can refuse it.
    follower.pub.coSignFoldArchiveRequest = async (envelope) => ({
        batchSeq: 7, sender: envelope.data.sig_pubkey, cp: { chain: row.chain }, archive: {},
        reply: { network: row.network, sig: '', archive_sig: 'archive-sig-for-' + envelope.data.sig_pubkey }
    });
    let observed = [];
    follower.pub.recordObservedArchiveLeader = (batchSeq, sender) => { observed.push(sender); };
    follower.pub.recordObservedArchiveContent = () => {};
    return { leader, rogue, follower, reqFrom, sent, base, observed };
}

const archiveSigs = (sent) => sent.filter(s => s.type === XANCPUB_SIGN && s.data && s.data.archive_sig);
const bundleSigs  = (sent) => sent.filter(s => s.type === XANCPUB_SIGN && s.data && s.data.sig);

function registerControlTests() {
    it('co-signs the elected leader alone (control)', async function () {
        let { leader, follower, reqFrom, sent, observed } = setup();
        await follower.pub.handleAttestSignReq(reqFrom(leader));
        expect(bundleSigs(sent).length, 'bundle co-sign').to.equal(1);
        expect(archiveSigs(sent).length, 'archive co-sign').to.equal(1);
        expect(observed).to.deep.equal([leader.pubkey]);
    });

    it('declines the rank-locked peer alone (control)', async function () {
        let { rogue, follower, reqFrom, sent, observed } = setup();
        await follower.pub.handleAttestSignReq(reqFrom(rogue));
        expect(sent.length, 'nothing broadcast for a rank-locked proposer').to.equal(0);
        expect(observed).to.deep.equal([]);
    });
}

function registerOverlapTest() {
    it('does not credit the rank-locked request with the leader\'s acceptance', async function () {
        let { leader, rogue, follower, reqFrom, sent, base, observed } = setup();
        // Hold the rogue request inside its first await, so the leader's request runs
        // and broadcasts its acceptance while the rogue one is still in flight.
        let release;
        let gate = new Promise(resolve => { release = resolve; });
        let realEligible = follower.pub.getActiveOraclePublishPubkeys;
        let calls = 0;
        follower.pub.getActiveOraclePublishPubkeys = async function (...args) {
            calls++;
            if (calls === 1) await gate;
            return realEligible.apply(this, args);
        };
        let rogueDone = follower.pub.handleAttestSignReq(reqFrom(rogue));
        await follower.pub.handleAttestSignReq(reqFrom(leader));
        release();
        await rogueDone;

        expect(observed, 'only the elected leader is observed').to.deep.equal([leader.pubkey]);
        expect(archiveSigs(sent).map(s => s.data.archive_sig))
            .to.deep.equal(['archive-sig-for-' + leader.pubkey]);
        expect(follower.pub.peerManager.broadcast, 'no wrapper left on the shared broadcast').to.equal(base);
    });
}

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    describe('fold-archive co-sign under overlapping XANCPUB_SIGN_REQs', function () {
        beforeEach(function () { arMod.ANCHOR_REWARD_ACTIVATION.regtest = 0; });
        registerControlTests();
        registerOverlapTest();
    });
});
