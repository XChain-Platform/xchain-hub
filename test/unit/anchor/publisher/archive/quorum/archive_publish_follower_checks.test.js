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

const { expect } = require('chai');
const {
    CP_ROW, buildMesh, registerMeshHooks
} = require('../../../../../helpers/anchor_mesh.js');

function checkpoint(network){
    return Object.assign({}, CP_ROW, { network, snapshot_block: 123 });
}

function signRequest(cp, sender){
    return { data: {
        checkpoint: cp,
        election_block: 500,
        batch_seq: 7,
        sig_pubkey: sender,
        sig: 'stubbed'
    }};
}

function prepareSignReq(pub, refusals){
    pub.hub.resolveBtcLatestBlock = async () => 500;
    pub.noteArchiveSignReqRefusal = (reason) => { refusals.push(reason); };
    pub.verifiedArchiveCanonical = () => 'canonical';
    pub.archiveSenderUnlocked = () => true;
    pub.getNextBatchSeq = async () => 0;
    pub.bindObservedArchiveLeader = () => {};
    pub.ownArchiveWrapper = () => null;
}

async function signReqUsesGatedArchiveSet(){
    const bus = buildMesh(3, { capabilitySets: { archive_publish: [1] } });
    const follower = bus.nodes[0];
    const archiveSender = bus.nodes[1].pubkey;
    const oracleOnlySender = bus.nodes[2].pubkey;
    const refusals = [];
    prepareSignReq(follower.pub, refusals);

    await follower.pub.handleSignReq(signRequest(checkpoint('regtest'), archiveSender));
    await follower.pub.handleSignReq(signRequest(checkpoint('regtest'), oracleOnlySender));
    await follower.pub.handleSignReq(signRequest(checkpoint('mainnet'), oracleOnlySender));

    expect(refusals).to.deep.equal([
        'signer_not_in_snapshot_set',
        'sender_not_elected_or_unlocked',
        'local_checkpoint_mismatch'
    ]);
    expect(bus.snapshotReads).to.deep.equal([
        ['archive_publish', 500],
        ['archive_publish', 123],
        ['archive_publish', 500],
        ['oracle_publish', 500],
        ['oracle_publish', 123]
    ]);
}

async function consumedSeqUsesGatedArchiveSet(){
    const bus = buildMesh(2, { capabilitySets: { archive_publish: [0] } });
    const leader = bus.nodes[0];
    const oracleOnlyFollower = bus.nodes[1];
    const learned = [];
    leader.pub.noteConsumedBatchSeq = (seq) => learned.push(seq);
    const refusal = { data: {
        batch_seq: 7,
        sig_pubkey: oracleOnlyFollower.pubkey,
        sig: '',
        consumed_seq: 7,
        refusal_sig: oracleOnlyFollower.identity.sign(leader.pub.seqRefusalCanonical(7, 7))
    }};
    const round = (network) => ({
        batchSeq: 7,
        done: false,
        electionBlock: 500,
        cp: checkpoint(network)
    });

    const aboveGate = round('regtest');
    Reflect.set(leader.pub, '_archiveRound', aboveGate);
    await leader.pub.handleSign(refusal);
    expect(learned).to.deep.equal([]);
    expect(aboveGate.done).to.equal(false);

    const belowGate = round('mainnet');
    Reflect.set(leader.pub, '_archiveRound', belowGate);
    await leader.pub.handleSign(refusal);
    expect(learned).to.deep.equal([7]);
    expect(belowGate.done).to.equal(true);
    expect(bus.snapshotReads).to.deep.equal([
        ['archive_publish', 500],
        ['oracle_publish', 500]
    ]);
}

async function finalizedMirrorUsesGatedArchiveSet(){
    const bus = buildMesh(2, { capabilitySets: { archive_publish: [0] } });
    const follower = bus.nodes[0];
    const oracleOnlySender = bus.nodes[1].pubkey;
    const rewards = [];
    let network = 'regtest';
    follower.pub.finalizedPricesWithLocalProof = async () => [];
    follower.pub.backfillBatch = async () => {};
    follower.pub.observedArchiveCheckpoint = () => checkpoint(network);
    follower.pub.verifyArchiveCheckpointOnChain = async () => 'verified';
    follower.pub.recordReward = (...args) => rewards.push(args);
    const finalized = () => follower.pub.applyFinalized({
        batch_seq: 7,
        txid: 'archive-txid',
        snapshot_block: 123,
        matches: []
    }, oracleOnlySender, [], [], {
        bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [], lists: []
    });

    await finalized();
    expect(rewards).to.deep.equal([]);

    network = 'mainnet';
    await finalized();
    expect(rewards).to.deep.equal([
        ['anchor_archive', 7, oracleOnlySender, 123, 'mainnet']
    ]);
    expect(bus.snapshotReads).to.deep.equal([
        ['archive_publish', 123],
        ['oracle_publish', 123]
    ]);
}

function archivePublishFollowerChecks(){
    registerMeshHooks();
    it('uses archive_publish for SIGN_REQ sender and signer checks above the gate', signReqUsesGatedArchiveSet);
    it('uses archive_publish for consumed_seq refusal membership above the gate', consumedSeqUsesGatedArchiveSet);
    it('uses archive_publish for the FINALIZED mirror above the gate and oracle_publish below it', finalizedMirrorUsesGatedArchiveSet);
}

describe('archive_publish follower checks', archivePublishFollowerChecks);
