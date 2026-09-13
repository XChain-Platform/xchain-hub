'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// A byte-budget split can leave a lagging chain's sections in a bundle whose MAX
// snapshot_block is OLDER than the network-wide max the caller resolved its
// oracle_publish set at. The election KEY was already per-bundle; the POPULATION was
// not, so the leader ranked itself over a set no verifier uses: _handleAttestSignReq
// and the BUNDLE_DONE gate both re-resolve at the bundle's own block, as does the
// indexer when it verifies the anchor. These tests pin the population to the same
// block as the key.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');

const NETWORK   = 'regtest';
const MAX_BLOCK = 100;                       // the network-wide max the caller resolves at
const OLD_BLOCK = 90;                        // the lagging chain's own snapshot block

const SECTION = {
    id: 1, chain: 'DOGE', network: NETWORK, block_index: 400, block_hash: 'd0'.repeat(32),
    ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: OLD_BLOCK, snapshot_block: OLD_BLOCK,
    state_root: 'e4'.repeat(32), block_merkle_root: 'f5'.repeat(32),
    state_root_version: 1, block_merkle_version: 1
};

function buildPub() {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let hub = {
        db: { async doQuery() { return []; } },
        network: NETWORK,
        capabilitySnapshot: null,
        capabilityRegistry: null,
        getIdentity:    () => identity,
        getPeerManager: () => ({ broadcast() {}, on() {}, removeListener() {} }),
        p2pConfig: {},
        rewardTracker: {
            anchorReward: '10.00000000',
            resolveSourceByPubkey: async (pk) => 'src_' + String(pk).toLowerCase().substring(0, 12)
        },
        _resolveBtcLatestBlock: async () => MAX_BLOCK
    };
    return { pub: new StateAnchorPublisher(hub), me: identity.getPubkeyHex().toLowerCase() };
}

// A peer that OUTRANKS this hub in the real hash order for the OLD block's election
// key. Found by search over the real hashOrder, not by stubbing it, so the ranking
// under test is the shipped one.
function outrankingPeer(pub, me) {
    let key = pub._bundleElectionKey({ network: NETWORK, snapshot_block: OLD_BLOCK });
    for (let i = 0; i < 512; i++) {
        let candidate = String(20 + (i % 80)).repeat(32).slice(0, 64);
        if (candidate === me) continue;
        if (StateAnchorPublisher.hashOrder(key, [me, candidate])[0] === candidate) return candidate;
    }
    return null;
}

describe('StateAnchorPublisher: split bundles elect at their OWN snapshot block', function () {

    it('resolves the election set at the bundle block, not the caller max block', async function () {
        const { pub, me } = buildPub();
        let asked = [];
        pub._getActiveOraclePublishPubkeys = async (block) => { asked.push(block); return [me]; };
        pub._getAnchorIntent               = async () => null;
        pub._runPublisherAttestationRound  = async () => ({ met: false, sigs: [] });

        let skipped = { rows: 0 };
        await pub._publishBundle(null, NETWORK, [SECTION], MAX_BLOCK, false, [], skipped);

        expect(asked).to.deep.equal([OLD_BLOCK]);
    });

    it('SECURITY: defers when the bundle-height set does not rank this hub, even though the max-height set does', async function () {
        const { pub, me } = buildPub();
        const peer = outrankingPeer(pub, me);
        expect(peer, 'a peer outranking this hub must exist').to.not.equal(null);

        // The membership delta: the peer held oracle_publish at the lagging chain's block
        // and no longer holds it at the network max. Electing over the max-height set (the
        // pre-fix behaviour) leaves this hub alone and therefore rank 0.
        const setAt = { [OLD_BLOCK]: [me, peer], [MAX_BLOCK]: [me] };
        const key   = pub._bundleElectionKey({ network: NETWORK, snapshot_block: OLD_BLOCK });
        expect(StateAnchorPublisher.hashOrder(key, setAt[MAX_BLOCK])[0]).to.equal(me);
        expect(StateAnchorPublisher.hashOrder(key, setAt[OLD_BLOCK])[0]).to.equal(peer);

        let reachedMarker = false;
        pub._getActiveOraclePublishPubkeys = async (block) => setAt[block] || [];
        pub._getAnchorIntent               = async () => { reachedMarker = true; return null; };
        pub._runPublisherAttestationRound  = async () => ({ met: false, sigs: [] });

        let skipped = { rows: 0 };
        await pub._publishBundle(null, NETWORK, [SECTION], MAX_BLOCK, false, [], skipped);

        // Not our election at this bundle's own height: nothing past the ladder runs.
        expect(reachedMarker).to.equal(false);
        expect(skipped.rows).to.equal(1);
    });

    // Positive control for the assertion above: with no membership delta this hub IS
    // rank 0 at the bundle's own block and walks past the ladder into the marker check.
    // Without this, the deferral above could be an artefact of any refusal at all.
    it('still publishes when the bundle-height set does rank this hub (control)', async function () {
        const { pub, me } = buildPub();
        let reachedMarker = false;
        pub._getActiveOraclePublishPubkeys = async () => [me];
        pub._getAnchorIntent               = async () => { reachedMarker = true; return null; };
        pub._runPublisherAttestationRound  = async () => ({ met: false, sigs: [] });

        let skipped = { rows: 0 };
        await pub._publishBundle(null, NETWORK, [SECTION], MAX_BLOCK, false, [], skipped);

        expect(reachedMarker).to.equal(true);
        expect(skipped.rows).to.equal(0);
    });

    it('fails closed on an empty set at the bundle block rather than borrowing the caller\'s', async function () {
        const { pub, me } = buildPub();
        let reachedMarker = false;
        pub._getActiveOraclePublishPubkeys = async () => [];      // unresolved at this height
        pub._getAnchorIntent               = async () => { reachedMarker = true; return null; };

        let skipped = { rows: 0 };
        await pub._publishBundle(null, NETWORK, [SECTION], MAX_BLOCK, false, [], skipped);

        expect(reachedMarker).to.equal(false);
        expect(skipped.rows).to.equal(0);          // deferred, not counted as another hub's election
    });
});
