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

// Shared wiring for signed votes, federation snapshots and asynchronous round
// setup in the consensus chaos experiments.

const sinon = require('sinon');
const { createMockHub }                        = require('../../helpers/mockHub');
const { VALIDATORS_4, makeFederationSnapshot } = require('../../helpers/fixtures');
const { buildEnvelope }                        = require('../../helpers/testPeerNetwork');
const { waitUntil }                            = require('../../helpers/waitUntil');

// The block every experiment anchors its snapshot at, and the height a leader
// stamps into PRE_PREPARE. Followers bound it against their own tip, so both
// read the same value.
const SNAPSHOT_BLOCK = 800000;

// A gossip envelope as PeerManager hands it on after verifying the signature:
// sig_pubkey is the key the admission gate and the quorum tally read.
function signedEnvelope(type, data, validator) {
    return Object.assign(buildEnvelope(type, data, validator.addr), { sig_pubkey: validator.pubkey });
}

// A mock hub running as `validator`, so its own self-votes carry the same key
// the snapshot lists for it rather than the mock's placeholder key.
function createValidatorHub(validator) {
    let identity = {
        getPubkeyHex: sinon.stub().returns(validator.pubkey),
        sign:         sinon.stub().returns('bb'.repeat(64)),
        signEnvelope: sinon.stub().returns('cc'.repeat(64))
    };
    return createMockHub({ validatorAddr: validator.addr, identity: identity });
}

// Stub the federation snapshot so chaos injections reach the behavior under
// test instead of the fail-closed indexer-outage guard. Keep quorum explicit.
function wireFederationSnapshot(hub, quorum, validators) {
    let snapshot = makeFederationSnapshot(validators || VALIDATORS_4, SNAPSHOT_BLOCK);
    hub.capabilitySnapshot = {
        getActiveValidatorSnapshot: sinon.stub().resolves(snapshot),
        getActiveWeightSnapshot:    sinon.stub().resolves(snapshot),
        getQuorum:                  sinon.stub().returns(quorum)
    };
    hub.resolveBtcLatestBlock = sinon.stub().resolves(SNAPSHOT_BLOCK);
    return snapshot;
}

// Resolve once `seq` has a pending proposal. Both propose() and the follower
// PRE_PREPARE handler await a snapshot lock before registering the round, and a
// vote for a round the leader has not opened is never replayed on the leader.
function waitForRound(con, seq) {
    return waitUntil(() => con.pendingProposals.get(seq),
        { timeoutMs: 5000, label: 'the PBFT round for seq ' + seq + ' to open' });
}

module.exports = { SNAPSHOT_BLOCK, signedEnvelope, createValidatorHub, wireFederationSnapshot, waitForRound };
