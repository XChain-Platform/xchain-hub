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
// StateAnchorPublisher: a follower claims the durable fold-archive wrapper slot
// only for a XANCPUB_SIGN_REQ whose own bundle co-sign verdict is true. A
// rank-locked sender's archive is verified alongside the bundle handler but must
// never latch the slot, or the elected publisher's archive for the same wrapper
// would be refused as a second payload.

const { expect }       = require('chai');
const proxyquire       = require('proxyquire');
const arMod            = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const { XANCPUB_SIGN } = require('../../../../../src/anchor/publisher/constants.js');
const { buildMesh, v0Order, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

// canonical_forms with its fold gate open, so the real follower method runs past it.
const forms = proxyquire('../../../../../src/anchor/publisher/canonical_forms.js', {
    '../../consensus/gate_registry.js': { activeAt: () => true },
});
const realCoSign = forms.foldPublisherMethods.coSignFoldArchiveRequest;

function setup() {
    let bus      = buildMesh(3, { btcBlock: 100 });
    let order    = v0Order(bus);
    let leader   = order[0];
    let rogue    = order[1];   // a federation member, rank-locked at this BTC tip
    let follower = order[2];
    let row      = follower.db.checkpoints[0];
    let pub      = follower.pub;
    let claims   = [];
    let sent     = [];
    pub.peerManager.broadcast = (type, data) => { sent.push({ type, data }); };
    pub.coSignFoldArchiveRequest = realCoSign;
    pub.hub.resolveDogeLatestBlock = async () => 100;
    pub.ownArchiveWrapper = () => row;
    pub.getNextBatchSeq = async () => 7;
    pub.archiveSigningSet = async () => [{ pubkey: follower.pubkey }];
    pub.decodeArchiveProposal = () => ({ network: row.network, matches: [] });
    pub.verifyArchiveAgainstLocal = async () => true;
    pub.claimArchiveWrapperSlot = async (canonical) => { claims.push(String(canonical)); return true; };
    pub.recordObservedArchiveLeader = () => {};
    pub.recordObservedArchiveContent = () => {};
    function reqFrom(node, matchCount) {
        let cp = node.pub.cpFromRow(row);
        let canonical = forms.foldArchiveCanonical(row, 7, matchCount, '0000000' + matchCount, 1);
        return { data: {
            network: row.network, snapshot_block: Number(row.snapshot_block),
            publisher: node.pubkey, sig_pubkey: node.pubkey,
            sections: [{ chain: row.chain, block_index: row.block_index, checkpoint_seq: row.checkpoint_seq }],
            body: node.pub.buildV7Payload([row], node.pubkey, []),
            sig: node.identity.sign(node.pub.attestationCanonical(cp, node.pubkey)),
            archive: { checkpoint: cp, wrapper_section_index: 0, batch_seq: 7, match_count: matchCount,
                       batch_crc32: '0000000' + matchCount, total_chunks: 1, sig: node.identity.sign(canonical) }
        }};
    }
    return { leader, rogue, follower, reqFrom, claims, sent };
}

const archiveSigs = (sent) => sent.filter(s => s.type === XANCPUB_SIGN && s.data && s.data.archive_sig);

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    describe('fold-archive wrapper slot claimed only after the bundle verdict', function () {
        beforeEach(function () { arMod.ANCHOR_REWARD_ACTIVATION.regtest = 0; });

        it('never claims the wrapper slot for a rank-locked sender, then co-signs the elected leader', async function () {
            let { leader, rogue, follower, reqFrom, claims, sent } = setup();
            await follower.pub.handleAttestSignReq(reqFrom(rogue, 1));
            expect(claims, 'a declined request must not latch the slot').to.deep.equal([]);
            expect(sent.length, 'nothing broadcast for a rank-locked proposer').to.equal(0);

            await follower.pub.handleAttestSignReq(reqFrom(leader, 2));
            expect(claims.length, 'the elected leader claims the slot').to.equal(1);
            expect(archiveSigs(sent).length, 'archive co-signed for the leader').to.equal(1);
        });

        it('leaves the real slot latch free for the leader after a rank-locked request', async function () {
            let { leader, rogue, follower, reqFrom, sent } = setup();
            let pub = follower.pub;
            delete pub.claimArchiveWrapperSlot;   // back to the durable first-writer-wins latch
            let canonical = (n) => forms.foldArchiveCanonical(follower.db.checkpoints[0], 7, n, '0000000' + n, 1);
            expect(pub.attestSlotOf(canonical(1)), 'the canonical carries an EQUIV slot').to.not.equal(null);
            await pub.handleAttestSignReq(reqFrom(rogue, 1));
            expect(pub.archiveWrapperSlotHeld(canonical(1)), 'declined request holds no slot').to.equal(false);
            await pub.handleAttestSignReq(reqFrom(leader, 2));
            expect(pub.archiveWrapperSlotHeld(canonical(2))).to.equal(true);
            expect(pub._archiveWrapperSlotRefusals || 0, 'no second-payload refusal').to.equal(0);
            expect(archiveSigs(sent).length).to.equal(1);
        });

        it('claims nothing without a true verdict when called directly', async function () {
            let { leader, follower, reqFrom, claims } = setup();
            let env = reqFrom(leader, 3);
            for (let verdict of [undefined, false, Promise.resolve(false), 'true']) {
                expect(await follower.pub.coSignFoldArchiveRequest(env, verdict)).to.equal(null);
            }
            expect(claims).to.deep.equal([]);
            let signed = await follower.pub.coSignFoldArchiveRequest(env, Promise.resolve(true));
            expect(signed).to.not.equal(null);
            expect(claims.length).to.equal(1);
        });
    });
});
