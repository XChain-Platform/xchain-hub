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

// Pins every archive follower membership check to one block-and-network seam.

const { expect } = require('chai');
const {
    CP_ROW, buildMesh, registerMeshHooks
} = require('../../../../../helpers/anchor_mesh.js');

function checkpoint(overrides){
    return Object.assign({}, CP_ROW, overrides || {});
}

function signRequest(cp, sender, electionBlock){
    return { data: {
        checkpoint: cp,
        election_block: electionBlock,
        batch_seq: 7,
        sig_pubkey: sender,
        sig: 'stubbed'
    }};
}

function prepareSignReq(pub, electionBlock, refusals){
    pub.hub.resolveBtcLatestBlock = async () => electionBlock;
    pub.noteArchiveSignReqRefusal = (reason) => { refusals.push(reason); };
    pub.verifiedArchiveCanonical = () => 'canonical';
    pub.archiveSenderUnlocked = () => true;
    pub.getNextBatchSeq = async () => 0;
    pub.bindObservedArchiveLeader = () => {};
    pub.ownArchiveWrapper = () => null;
}

async function resolvesFollowerChecksOnCheckpointNetwork(){
    const bus = buildMesh(2);
    const follower = bus.nodes[0];
    const sender = bus.nodes[1].pubkey;
    const electionBlock = 500;
    const snapshotBlock = 123;
    const refusals = [];
    const calls = [];
    prepareSignReq(follower.pub, electionBlock, refusals);
    follower.pub.archiveFollowerPubkeys = async (block, network) => {
        calls.push([block, network]);
        return block === electionBlock ? [sender] : [follower.pubkey];
    };

    await follower.pub.handleSignReq(signRequest(
        checkpoint({ network: 'recordnet', snapshot_block: snapshotBlock }),
        sender, electionBlock));
    expect(calls).to.deep.equal([
        [electionBlock, 'recordnet'],
        [snapshotBlock, 'recordnet']
    ]);

    calls.length = 0;
    follower.pub.network = 'hubnet';
    await follower.pub.handleSignReq(signRequest(
        checkpoint({ network: '', snapshot_block: snapshotBlock }),
        sender, electionBlock));
    expect(calls).to.deep.equal([
        [electionBlock, 'hubnet'],
        [snapshotBlock, 'hubnet']
    ]);
    expect(refusals).to.deep.equal(['local_checkpoint_mismatch', 'local_checkpoint_mismatch']);
}

async function preservesSignRequestRefusals(){
    const bus = buildMesh(2);
    const follower = bus.nodes[0];
    const sender = bus.nodes[1].pubkey;
    const electionBlock = 500;
    const snapshotBlock = 123;
    const cp = checkpoint({ network: 'recordnet', snapshot_block: snapshotBlock });
    const refusals = [];
    const calls = [];
    prepareSignReq(follower.pub, electionBlock, refusals);

    follower.pub.archiveFollowerPubkeys = async (block, network) => {
        calls.push([block, network]);
        return [];
    };
    await follower.pub.handleSignReq(signRequest(cp, sender, electionBlock));
    expect(refusals).to.deep.equal(['sender_not_elected_or_unlocked']);
    expect(calls).to.deep.equal([[electionBlock, 'recordnet']]);

    calls.length = 0;
    follower.pub.archiveFollowerPubkeys = async (block, network) => {
        calls.push([block, network]);
        return [sender];
    };
    await follower.pub.handleSignReq(signRequest(cp, sender, electionBlock));
    expect(refusals).to.deep.equal([
        'sender_not_elected_or_unlocked',
        'signer_not_in_snapshot_set'
    ]);
    expect(calls).to.deep.equal([
        [electionBlock, 'recordnet'],
        [snapshotBlock, 'recordnet']
    ]);
}

async function authenticatesConsumedSeqRefusalMembership(){
    const bus = buildMesh(2);
    const leader = bus.nodes[0];
    const outsider = bus.nodes[1];
    const calls = [];
    const learned = [];
    const round = {
        batchSeq: 7,
        done: false,
        electionBlock: 500,
        cp: checkpoint({ network: 'roundnet' })
    };
    Reflect.set(leader.pub, '_archiveRound', round);
    let followerSet = [leader.pubkey];
    leader.pub.archiveFollowerPubkeys = async (block, network) => {
        calls.push([block, network]);
        return followerSet;
    };
    leader.pub.noteConsumedBatchSeq = (seq) => learned.push(seq);

    // The refusal is signed correctly by its own key, so the signature check
    // passes and only follower-set membership can turn it away.
    const refusal = { data: {
        batch_seq: 7,
        sig_pubkey: outsider.pubkey,
        sig: '',
        consumed_seq: 7,
        refusal_sig: outsider.identity.sign(leader.pub.seqRefusalCanonical(7, 7))
    }};
    await leader.pub.handleSign(refusal);

    expect(calls).to.deep.equal([[500, 'roundnet']]);
    expect(learned, 'a validly signed refusal from outside the set moves no seq').to.deep.equal([]);
    expect(Reflect.get(leader.pub, '_archiveRound')).to.equal(round);
    expect(round.done).to.equal(false);

    // Positive control: the same refusal abandons the round once its key is in
    // the answer, so the refusal above was turned away for membership alone.
    followerSet = [leader.pubkey, outsider.pubkey];
    await leader.pub.handleSign(refusal);
    expect(learned).to.deep.equal([7]);
    expect(round.done).to.equal(true);
}

async function checksFinalizedRewardMirrorMembership(){
    const bus = buildMesh(2);
    const follower = bus.nodes[0];
    const sender = bus.nodes[1].pubkey;
    const calls = [];
    const rewards = [];
    follower.pub.finalizedPricesWithLocalProof = async () => [];
    follower.pub.backfillBatch = async () => {};
    follower.pub.observedArchiveCheckpoint = () => checkpoint({ network: 'observednet' });
    // The archive verifies on-chain, so only follower-set membership stands
    // between this FINALIZED and a mirrored reward.
    follower.pub.verifyArchiveCheckpointOnChain = async () => 'verified';
    let followerSet = [follower.pubkey];
    follower.pub.archiveFollowerPubkeys = async (block, network) => {
        calls.push([block, network]);
        return followerSet;
    };
    follower.pub.recordReward = (...args) => rewards.push(args);
    const finalized = () => follower.pub.applyFinalized({
        batch_seq: 7,
        txid: 'archive-txid',
        snapshot_block: 123,
        matches: []
    }, sender, [], [], {
        bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [], lists: []
    });

    await finalized();
    expect(calls).to.deep.equal([[123, 'observednet']]);
    expect(rewards, 'sender outside the follower set records no anchor_archive reward').to.deep.equal([]);

    // Positive control: the same FINALIZED mirrors the reward once the sender
    // is in the answer.
    followerSet = [follower.pubkey, sender];
    await finalized();
    expect(rewards).to.deep.equal([['anchor_archive', 7, sender, 123, 'observednet']]);
}

async function delegatesToActiveOraclePublishPubkeys(){
    const bus = buildMesh(1);
    const pub = bus.nodes[0].pub;
    const answer = [pub.identity.getPubkeyHex().toLowerCase()];
    const blocks = [];
    pub.getActiveOraclePublishPubkeys = async (block) => {
        blocks.push(block);
        return answer;
    };

    expect(await pub.archiveFollowerPubkeys(321, 'ignored-today')).to.equal(answer);
    expect(blocks).to.deep.equal([321]);
}

function archiveFollowerSetSeamTests(){
    registerMeshHooks();
    it('handleSignReq resolves election and snapshot checks on the checkpoint network, with hub fallback', resolvesFollowerChecksOnCheckpointNetwork);
    it('handleSignReq preserves sender_not_elected_or_unlocked and signer_not_in_snapshot_set refusals', preservesSignRequestRefusals);
    it('handleSign authenticates consumed_seq refusal membership on the open round checkpoint network', authenticatesConsumedSeqRefusalMembership);
    it('applyFinalized checks reward-mirror membership on the observed checkpoint network', checksFinalizedRewardMirrorMembership);
    it('archiveFollowerPubkeys returns exactly what getActiveOraclePublishPubkeys returns today', delegatesToActiveOraclePublishPubkeys);
}

describe('StateAnchorPublisher archive follower set seam', archiveFollowerSetSeamTests);
