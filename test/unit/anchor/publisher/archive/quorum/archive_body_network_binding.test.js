'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const { CP_ROW, buildMesh, registerMeshHooks } = require('../../../../../helpers/anchor_mesh.js');

// The wrapper sits on a network whose wrapper group is oracle_publish at this block,
// and the forged body names the one network where it is archive_publish.
const WRAPPER_NETWORK = 'testnet';
const FORGED_NETWORK = 'regtest';

function publisher() {
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS },
        network: 'regtest',
        getIdentity: () => null,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {},
    });
    return pub;
}

function archive(network) {
    return { network, matches: [], capability_snapshots: [] };
}

describe('archive body network binding', function () {
    it('refuses either mismatch before resolving a capability set', async function () {
        const pub = publisher();
        let resolutions = 0;
        pub.resolveCapabilitySet = async () => {
            resolutions += 1;
            return [];
        };

        expect(await pub.verifyArchiveAgainstLocal(archive('regtest'), 100, 'mainnet')).to.equal(false);
        expect(await pub.verifyArchiveAgainstLocal(archive('mainnet'), 100, 'regtest')).to.equal(false);
        expect(resolutions).to.equal(0);
    });

    it('accepts a matching wrapper network and refuses a missing one', async function () {
        const pub = publisher();
        pub.resolveCapabilitySet = async () => [];

        expect(await pub.verifyArchiveAgainstLocal(archive('regtest'), 100, 'regtest')).to.equal(true);
        expect(await pub.verifyArchiveAgainstLocal(archive('regtest'), 100, null)).to.equal(false);
    });

    it('refuses a call that omits the wrapper network', async function () {
        const pub = publisher();
        let resolutions = 0;
        pub.resolveCapabilitySet = async () => {
            resolutions += 1;
            return [];
        };

        expect(await pub.verifyArchiveAgainstLocal(archive('regtest'), 100)).to.equal(false);
        expect(await pub.verifyArchiveAgainstLocal(archive('regtest'))).to.equal(false);
        expect(resolutions).to.equal(0);
    });
});

// A follower whose own wrapper row sits on WRAPPER_NETWORK, with every check before
// the archive body comparison stubbed to pass.
function signReqFollower(bodyNetwork) {
    const bus = buildMesh(2);
    const follower = bus.nodes[0];
    const sender = bus.nodes[1].pubkey;
    const mine = Object.assign({}, CP_ROW, { network: WRAPPER_NETWORK });
    const seen = { refusals: [], cosigned: 0 };
    const pub = follower.pub;
    pub.hub.resolveBtcLatestBlock = async () => 500;
    pub.noteArchiveSignReqRefusal = (reason) => {
        seen.refusals.push(reason);
    };
    pub.archiveFollowerPubkeys = async () => [sender, follower.pubkey];
    pub.verifiedArchiveCanonical = () => 'canonical';
    pub.archiveSenderUnlocked = () => true;
    pub.getNextBatchSeq = async () => 0;
    pub.ownArchiveWrapper = () => mine;
    pub.decodeArchiveProposal = () => archive(bodyNetwork);
    pub.resolveCapabilitySet = async () => [];
    pub.coSignArchive = async () => {
        seen.cosigned += 1;
    };
    const request = {
        data: {
            checkpoint: mine,
            election_block: 500,
            batch_seq: 7,
            sig_pubkey: sender,
            sig: 'stubbed',
        },
    };
    return { pub, request, seen };
}

// coSignFoldArchiveRequest from a module copy whose fold gate is open, run against a
// mesh publisher holding the wrapper row on WRAPPER_NETWORK.
function foldCoSigner(bodyNetwork) {
    const forms = proxyquire('../../../../../../src/anchor/publisher/canonical_forms.js', {
        '../../consensus/gate_registry.js': { activeAt: () => true },
    });
    const bus = buildMesh(2);
    const pub = bus.nodes[0].pub;
    const leader = bus.nodes[1];
    const mine = Object.assign({}, CP_ROW, { network: WRAPPER_NETWORK });
    pub.hub.resolveDogeLatestBlock = async () => 100;
    pub.db.getStateCheckpointByChain = async () => [mine];
    pub.ownArchiveWrapper = () => mine;
    pub.getNextBatchSeq = async () => 7;
    pub.archiveSigningSet = async () => [{ pubkey: pub.identity.getPubkeyHex().toLowerCase() }];
    pub.decodeArchiveProposal = () => archive(bodyNetwork);
    pub.resolveCapabilitySet = async () => [];
    pub.claimArchiveWrapperSlot = async () => true;
    const canonical = forms.foldArchiveCanonical(mine, 7, 0, 'crc', 1);
    const section = { chain: mine.chain, block_index: mine.block_index, checkpoint_seq: mine.checkpoint_seq };
    const envelope = {
        data: {
            network: WRAPPER_NETWORK,
            sections: [section],
            sig_pubkey: leader.pubkey,
            publisher: leader.pubkey,
            archive: {
                checkpoint: mine,
                wrapper_section_index: 0,
                batch_seq: 7,
                match_count: 0,
                batch_crc32: 'crc',
                total_chunks: 1,
                sig: leader.identity.sign(canonical),
            },
        },
    };
    return () => forms.foldPublisherMethods.coSignFoldArchiveRequest.call(pub, envelope);
}

describe('archive body network binding on the co-sign paths', function () {
    registerMeshHooks();

    it('handleSignReq refuses a forged body network and co-signs the matching one', async function () {
        const forged = signReqFollower(FORGED_NETWORK);
        await forged.pub.handleSignReq(forged.request);
        expect(forged.seen.refusals).to.deep.equal(['archive_diverges_from_local']);
        expect(forged.seen.cosigned).to.equal(0);

        const honest = signReqFollower(WRAPPER_NETWORK);
        await honest.pub.handleSignReq(honest.request);
        expect(honest.seen.refusals).to.deep.equal([]);
        expect(honest.seen.cosigned).to.equal(1);
    });

    it('coSignFoldArchiveRequest refuses a forged body network and co-signs the matching one', async function () {
        expect(await foldCoSigner(FORGED_NETWORK)()).to.equal(null);
        const accepted = await foldCoSigner(WRAPPER_NETWORK)();
        expect(accepted).to.not.equal(null);
        expect(accepted.archive.network).to.equal(WRAPPER_NETWORK);
    });
});
