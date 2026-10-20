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
//
// StateAnchorPublisher: one XANCPUB publisher attestation per equivocation slot.
// The indexer slashes two signatures under one XANCPUB header that differ only in
// the publisher field, and a rank-unlocked failover proposes exactly that pair at
// the same snapshot_block (bundle) or batch_seq (archive). Every hub therefore signs
// at most one publisher per slot, on all four sign sites, across a restart.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const arMod                 = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const ValidatorIdentity     = require('../../../../../src/validators/identity');
const { XANCPUB_SIGN, XANCARCHPUB_SIGN, XANCPUB_SIGN_REQ, XANCARCHPUB_SIGN_REQ } =
    require('../../../../../src/anchor/publisher/constants.js');
const { buildMesh, v0Order, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

// Rank 1 unlocks once the BTC tip is one ladder step (36 blocks) past the snapshot.
const FAILOVER_TIP = 200;

// The indexer's publisher-only test on two XANCPUB contents (header stripped).
function isPublisherOnlyPair(a, b) {
    let x = a.split('|'), y = b.split('|');
    if (x.length !== 6 || y.length !== 6 || x[4] === y[4]) return false;
    return [0, 1, 2, 3, 5].every(k => x[k] === y[k]);
}

// Every canonical one key signed among `sent`, read back by trying each candidate.
function signedBy(sent, type, pubkey, candidates) {
    let out = [];
    for (let s of sent) {
        if (s.type !== type) continue;
        let hit = candidates.find(c => ValidatorIdentity.verify(c, String(s.data.sig || ''), pubkey));
        if (hit) out.push(hit);
    }
    return out;
}

const contentOf = (canonical) => canonical.slice(canonical.indexOf('||') + 2);

function bundleRequest(publisher, row) {
    let cp = publisher.pub.cpFromRow(row);
    let canonical = publisher.pub.attestationCanonical(cp, publisher.pubkey);
    return { canonical, req: { data: {
        network: row.network, snapshot_block: Number(row.snapshot_block),
        publisher: publisher.pubkey, sig_pubkey: publisher.pubkey,
        sections: [{ chain: row.chain, block_index: row.block_index, checkpoint_seq: row.checkpoint_seq }],
        body: publisher.pub.buildV7Payload([row], publisher.pubkey, []),
        sig: publisher.identity.sign(canonical)
    }}};
}

function captureBroadcasts(node) {
    let sent = [];
    node.pub.peerManager.broadcast = (type, data) => { sent.push({ type, data }); };
    return sent;
}

function bundleSetup() {
    // stakeWeighted wires the weighted snapshot the proposer round resolves its set from.
    let bus = buildMesh(3, { btcBlock: FAILOVER_TIP, stakeWeighted: true, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
    let order = v0Order(bus);
    let row = order[0].db.checkpoints[0];
    return { bus, order, row, p0: bundleRequest(order[0], row), p1: bundleRequest(order[1], row) };
}

function registerBundleFollowerTests() {
    it('the rank-0 and rank-1 bundle attestations form a publisher-only pair', function () {
        let { p0, p1 } = bundleSetup();
        expect(isPublisherOnlyPair(contentOf(p0.canonical), contentOf(p1.canonical))).to.equal(true);
    });

    it('a follower that co-signed rank 0 refuses rank 1 in the same slot', async function () {
        let { order, p0, p1 } = bundleSetup();
        let follower = order[2];
        let sent = captureBroadcasts(follower);
        await follower.pub.handleAttestSignReq(p0.req);
        await follower.pub.handleAttestSignReq(p1.req);
        let signed = signedBy(sent, XANCPUB_SIGN, follower.pubkey, [p0.canonical, p1.canonical]);
        expect(signed, 'one XANCPUB signature in the slot').to.deep.equal([p0.canonical]);
        expect(follower.pub._attestSlotRefusals).to.equal(1);
    });

    it('two concurrent requests for different publishers cannot both be co-signed', async function () {
        let { order, p0, p1 } = bundleSetup();
        let follower = order[2];
        let sent = captureBroadcasts(follower);
        await Promise.all([follower.pub.handleAttestSignReq(p0.req), follower.pub.handleAttestSignReq(p1.req)]);
        expect(signedBy(sent, XANCPUB_SIGN, follower.pubkey, [p0.canonical, p1.canonical]).length).to.equal(1);
    });

    it('a re-delivered request for the publisher already signed is still co-signed', async function () {
        let { order, p0 } = bundleSetup();
        let follower = order[2];
        let sent = captureBroadcasts(follower);
        await follower.pub.handleAttestSignReq(p0.req);
        await follower.pub.handleAttestSignReq(p0.req);
        expect(signedBy(sent, XANCPUB_SIGN, follower.pubkey, [p0.canonical]).length).to.equal(2);
    });

    it('the refusal survives a restart through consensus_state', async function () {
        let { order, p0, p1 } = bundleSetup();
        let follower = order[2];
        let sent = captureBroadcasts(follower);
        await follower.pub.handleAttestSignReq(p0.req);
        follower.pub._attestSlots = new Map();                   // process memory gone, db kept
        await follower.pub.handleAttestSignReq(p1.req);
        expect(signedBy(sent, XANCPUB_SIGN, follower.pubkey, [p0.canonical, p1.canonical]))
            .to.deep.equal([p0.canonical]);
    });

    it('fails closed while the slot cannot be recorded, then signs once it can', async function () {
        let { order, p0 } = bundleSetup();
        let follower = order[2];
        let sent = captureBroadcasts(follower);
        let insert = follower.db.createConsensusStateIfAbsent;
        follower.db.createConsensusStateIfAbsent = async () => { throw new Error('db down'); };
        await follower.pub.handleAttestSignReq(p0.req);
        expect(signedBy(sent, XANCPUB_SIGN, follower.pubkey, [p0.canonical]), 'no signature without a durable record')
            .to.deep.equal([]);
        follower.db.createConsensusStateIfAbsent = insert;
        await follower.pub.handleAttestSignReq(p0.req);
        expect(signedBy(sent, XANCPUB_SIGN, follower.pubkey, [p0.canonical])).to.deep.equal([p0.canonical]);
    });
}

// The one-section bundle a proposer round takes: identity plus its sections.
const bundleOf = (row) => ({ network: row.network, snapshot_block: Number(row.snapshot_block), sections: [row] });

// The canonicals `node` signed in the requests it broadcast as a proposer.
function proposedBy(sent, reqType, node, candidates) {
    let reqs = sent.filter(s => s.type === reqType).map(s => ({ type: reqType, data: s.data }));
    return signedBy(reqs, reqType, node.pubkey, candidates);
}

function registerBundleProposerTests() {
    // Control for the case below: the same hub, with no prior co-sign, does open its
    // round and sign its own attestation, so the abstention is the latch at work.
    it('a hub that co-signed nothing proposes itself in the slot (control)', async function () {
        let { order, row } = bundleSetup();
        let rank1 = order[1];
        let sent = captureBroadcasts(rank1);
        let mine = rank1.pub.attestationCanonical(bundleOf(row), rank1.pubkey);
        await rank1.pub.runPublisherAttestationRound(bundleOf(row), rank1.pubkey);
        expect(proposedBy(sent, XANCPUB_SIGN_REQ, rank1, [mine])).to.deep.equal([mine]);
    });

    it('a hub that co-signed rank 0 abstains from proposing itself in that slot', async function () {
        let { order, row, p0 } = bundleSetup();
        let rank1 = order[1];
        let sent = captureBroadcasts(rank1);
        await rank1.pub.handleAttestSignReq(p0.req);
        expect(signedBy(sent, XANCPUB_SIGN, rank1.pubkey, [p0.canonical])).to.deep.equal([p0.canonical]);
        let mine = rank1.pub.attestationCanonical(bundleOf(row), rank1.pubkey);
        let r = await rank1.pub.runPublisherAttestationRound(bundleOf(row), rank1.pubkey);
        expect(r).to.deep.equal({ met: false, sigs: [] });
        expect(proposedBy(sent, XANCPUB_SIGN_REQ, rank1, [mine])).to.deep.equal([]);
    });
}

function archiveSetup() {
    let bus = buildMesh(3, { btcBlock: FAILOVER_TIP, stakeWeighted: true, cfg: { ANCHOR_ROUND_TIMEOUT_MS: '40' } });
    let order = v0Order(bus);
    let row = order[0].db.checkpoints[0];
    let follower = order[2];
    let batchSeq = 5;
    let make = (node) => {
        let canonical = node.pub.archiveAttestationCanonical(node.pub.cpFromRow(row), batchSeq, node.pubkey);
        follower.pub.recordObservedArchiveLeader(batchSeq, node.pubkey, row);
        return { canonical, req: { data: { batch_seq: batchSeq, publisher: node.pubkey,
                                           sig_pubkey: node.pubkey, sig: node.identity.sign(canonical) } } };
    };
    return { follower, row, batchSeq, a0: make(order[0]), a1: make(order[1]) };
}

function registerArchiveTests() {
    it('a follower co-signs one archive publisher per batch slot', async function () {
        let { follower, a0, a1 } = archiveSetup();
        expect(isPublisherOnlyPair(contentOf(a0.canonical), contentOf(a1.canonical))).to.equal(true);
        let sent = captureBroadcasts(follower);
        await follower.pub.handleArchiveAttestSignReq(a0.req);
        await follower.pub.handleArchiveAttestSignReq(a1.req);
        expect(signedBy(sent, XANCARCHPUB_SIGN, follower.pubkey, [a0.canonical, a1.canonical]))
            .to.deep.equal([a0.canonical]);
    });

    it('a hub that co-signed nothing runs its own archive round in the slot (control)', async function () {
        let { follower, row, batchSeq } = archiveSetup();
        let sent = captureBroadcasts(follower);
        let mine = follower.pub.archiveAttestationCanonical(follower.pub.cpFromRow(row), batchSeq, follower.pubkey);
        await follower.pub.runArchiveAttestationRound(follower.pub.cpFromRow(row), batchSeq, follower.pubkey);
        expect(proposedBy(sent, XANCARCHPUB_SIGN_REQ, follower, [mine])).to.deep.equal([mine]);
    });

    it('a hub that co-signed rank 0 abstains from its own archive round in that slot', async function () {
        let { follower, row, batchSeq, a0 } = archiveSetup();
        let sent = captureBroadcasts(follower);
        await follower.pub.handleArchiveAttestSignReq(a0.req);
        expect(signedBy(sent, XANCARCHPUB_SIGN, follower.pubkey, [a0.canonical])).to.deep.equal([a0.canonical]);
        let mine = follower.pub.archiveAttestationCanonical(follower.pub.cpFromRow(row), batchSeq, follower.pubkey);
        let r = await follower.pub.runArchiveAttestationRound(follower.pub.cpFromRow(row), batchSeq, follower.pubkey);
        expect(r).to.deep.equal({ met: false, sigs: [] });
        expect(proposedBy(sent, XANCARCHPUB_SIGN_REQ, follower, [mine])).to.deep.equal([]);
    });
}

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    describe('one XANCPUB publisher attestation per slot', function () {
        beforeEach(function () { arMod.ANCHOR_REWARD_ACTIVATION.regtest = 0; });

        registerBundleFollowerTests();
        registerBundleProposerTests();
        registerArchiveTests();
    });
});
