'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../src/anchor/publisher');
const ar = require('../../../src/consensus/gates/anchor_reward_gate.js');
const { XANC_SIGN_REQ, XANCPUB_SIGN_REQ } = require('../../../src/anchor/publisher/constants.js');
const { CP_ROW, buildMesh, v0Order, startAll, registerMeshHooks } = require('../../helpers/anchor_mesh.js');

function section(chain, sig){
    return Object.assign({}, CP_ROW, {
        chain,
        validator_signatures: JSON.stringify([{ pubkey: sig + 'pk', sig: sig + 'sg' }])
    });
}

function walkSections(wire){
    let fields = wire.split('|');
    let count = Number(fields[4]);
    let i = 5, sections = [];
    for(let n = 0; n < count; n++){
        let start = i;
        i += 12;
        let sigCount = Number(fields[i++]);
        let sigs = [];
        for(let s = 0; s < sigCount; s++) sigs.push({ pubkey: fields[i++], sig: fields[i++] });
        sections.push({ chain: fields[start], sigs });
    }
    return { fields, sections, next: i };
}

function archiveCount(wire){
    let parsed = walkSections(wire);
    return Number(parsed.fields[parsed.next]);
}

describe('ANCHOR v3 one-round archive fold', function () {
    registerMeshHooks();
    let priorFold;
    let priorReward;
    let priorDerive;

    beforeEach(function () {
        priorFold = StateAnchorPublisher.ANCHOR_FOLD_ACTIVATION.regtest;
        priorReward = ar.ANCHOR_REWARD_ACTIVATION.regtest;
        priorDerive = ar.ANCHOR_REWARD_DERIVE_ACTIVATION.regtest;
        StateAnchorPublisher.ANCHOR_FOLD_ACTIVATION.regtest = 0;
        ar.ANCHOR_REWARD_ACTIVATION.regtest = 0;
        ar.ANCHOR_REWARD_DERIVE_ACTIVATION.regtest = 0;
    });

    afterEach(function () {
        StateAnchorPublisher.ANCHOR_FOLD_ACTIVATION.regtest = priorFold;
        ar.ANCHOR_REWARD_ACTIVATION.regtest = priorReward;
        ar.ANCHOR_REWARD_DERIVE_ACTIVATION.regtest = priorDerive;
    });

    it('builds the v3 archive fields after the sections and replaces only the wrapper signatures', function () {
        let pub = Object.create(StateAnchorPublisher.prototype);
        let archive = {
            wrapperSectionIndex: 0, batchSeq: 42, count: 17,
            crc: '9C4E1B22', chunks: ['body'],
            signatures: [{ pubkey: 'b', sig: 'bs' }, { pubkey: 'a', sig: 'as' }]
        };
        let wire = pub.buildV3Payload({ network: 'regtest', snapshot_block: 100 },
            [section('LTC', 'l'), section('BTC', 'b')], archive, 'publisher', []);
        let parsed = walkSections(wire);
        expect(parsed.fields.slice(0, 5)).to.deep.equal(['ANCHOR', '3', 'regtest', '100', '2']);
        expect(parsed.sections.map(s => s.chain)).to.deep.equal(['BTC', 'LTC']);
        expect(parsed.sections[0].sigs).to.deep.equal([{ pubkey: 'a', sig: 'as' }, { pubkey: 'b', sig: 'bs' }]);
        expect(parsed.sections[1].sigs).to.deep.equal([{ pubkey: 'lpk', sig: 'lsg' }]);
        expect(parsed.fields.slice(parsed.next, parsed.next + 7))
            .to.deep.equal(['1', '0', '42', '17', '9c4e1b22', '1', 'body']);
    });

    it('supports an explicit empty-section header and ARCHIVE_COUNT 0', function () {
        let pub = Object.create(StateAnchorPublisher.prototype);
        expect(pub.buildV3Payload({ network: 'regtest', snapshot_block: 321 }, [], null, 'pub', []))
            .to.equal('ANCHOR|3|regtest|321|0|0|pub|0');
    });

    it('backfills every row family carried by the folded archive', async function () {
        let pub = Object.create(StateAnchorPublisher.prototype);
        let forwarded;
        let ids = {
            matchIds: ['matches'], callIds: ['calls'], rewardIds: ['rewards'],
            bridgeIds: ['bridges'], policyIds: ['policies'], checkpointIds: ['checkpoints'],
            priceIds: ['prices'], tombstoneIds: ['tombstones']
        };
        pub.markArchiveSent = async () => {};
        pub.broadcastArchiveChunks = async () => 0;
        pub.archiveBackfillIds = () => ids;
        pub.backfillBatch = async (...args) => { forwarded = args; };
        pub.settleArchiveIntent = async () => {};
        pub.announceArchiveFinalized = () => {};
        await pub.completeFoldArchive(
            { cp: { network: 'regtest' }, batchSeq: 4 }, { broadcastFn: async () => {} }, 'txid4');
        expect(forwarded).to.deep.equal([
            4, ids.matchIds, 'txid4', ids.callIds, ids.rewardIds,
            ids.bridgeIds, ids.policyIds, ids.checkpointIds, ids.priceIds, ids.tombstoneIds
        ]);
    });

    it('publishes one folded transaction and retires the separate archive reward', async function () {
        let bus = buildMesh(1, { stakeWeighted: true, checkpointCommitment: true });
        let node = bus.nodes[0];
        await startAll(bus);
        await node.pub.flush();
        expect(node.published).to.have.length(1);
        expect(node.published[0].split('|')[1]).to.equal('3');
        expect(archiveCount(node.published[0])).to.equal(1);
        expect(node.db.matches[0].batch_seq).to.equal(0);
        expect(node.rewards.filter(r => r.type === 'anchor_bundle')).to.have.length(1);
        expect(node.rewards.filter(r => r.type === 'anchor_archive')).to.have.length(0);
    });

    it('co-signs the archive through the bundle attestation request in a multi-node round', async function () {
        let bus = buildMesh(4, { stakeWeighted: true, checkpointCommitment: true });
        await startAll(bus);
        let leader = v0Order(bus)[0];
        let messages = [];
        let broadcast = leader.pub.peerManager.broadcast.bind(leader.pub.peerManager);
        leader.pub.peerManager.broadcast = (type, data) => {
            messages.push({ type, data });
            return broadcast(type, data);
        };
        await leader.pub.flush();
        expect(leader.published).to.have.length(1);
        expect(archiveCount(leader.published[0])).to.equal(1);
        expect(messages.filter(m => m.type === XANC_SIGN_REQ)).to.have.length(0);
        let requests = messages.filter(m => m.type === XANCPUB_SIGN_REQ);
        expect(requests).to.have.length(1);
        expect(requests[0].data.archive).to.include({ batch_seq: 0, wrapper_section_index: 0 });
        expect(walkSections(leader.published[0]).sections[0].sigs).to.have.length(3);
    });

    it('ships checkpoints on the archive sub-deadline with ARCHIVE_COUNT 0', async function () {
        let bus = buildMesh(1, { stakeWeighted: true, checkpointCommitment: true });
        let node = bus.nodes[0];
        node.pub.archiveFoldSubdeadlineMs = 10;
        node.pub.buildFoldArchiveSection = () => new Promise(() => {});
        await startAll(bus);
        await node.pub.flush();
        expect(node.published).to.have.length(1);
        expect(node.published[0].split('|')[1]).to.equal('3');
        expect(archiveCount(node.published[0])).to.equal(0);
        expect(node.db.checkpoints[0].anchor_txid).to.equal('txid1');
        expect(node.db.matches[0].batch_seq).to.equal(null);
    });

    it('emits one transaction per network per cycle even when the byte budget splits the sections', async function () {
        let run = async (foldBlock) => {
            let pub = Object.create(StateAnchorPublisher.prototype);
            let calls = [];
            pub.identity = null;
            pub.getActiveOraclePublishPubkeys = async () => ['aa'];
            pub.splitBundle = () => ({ bundles: [[section('BTC', 'b')], [section('LTC', 'l')]], oversize: [] });
            pub.hub = { resolveDogeLatestBlock: async () => foldBlock };
            pub.suppressLegacyArchiveLeg = () => {};
            pub.publishBundle = async (signer, network, group) => { calls.push(group.map(x => x.chain)); };
            await pub.publishNetworkBundles({}, 'regtest', [section('BTC', 'b'), section('LTC', 'l')], 100, false, [], { rows: 0 });
            return calls;
        };
        expect(await run(0)).to.deep.equal([['BTC']]);
        StateAnchorPublisher.ANCHOR_FOLD_ACTIVATION.regtest = 1e9;
        expect(await run(0)).to.deep.equal([['BTC'], ['LTC']]);
    });

    it('guards a folded spend by row attributes rather than the version byte', async function () {
        let pub = new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
        let txid = 'ab'.repeat(32);
        pub.indexers = { DOGE: { url: 'http://doge-indexer' } };
        pub.indexerCall = async (coin, method) => method === 'getanchoraction'
            ? { exists: true, status: 'valid', version: 91, chain: 'BTC', match_batch_seq: null, txid }
            : { exists: true, status: 'valid', version: 2, chain: null, match_batch_seq: 7, txid };
        let found = await pub.findExistingFoldedBundle([
            { chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 2 }
        ], { batchSeq: 7 });
        expect(found).to.deep.equal({ exists: true, txid });
    });

    it('accepts v3 only for the surviving anchor_bundle reward family', function () {
        let pub = new StateAnchorPublisher({ db: {}, p2pConfig: {} });
        let payload = {
            network: 'regtest', snapshot_block: 100,
            reward_type: 'anchor_bundle', chain: 'BTC', publisher: 'aa', sig_pubkey: 'bb',
            doge_anchor_txid: '01'.repeat(32), round_reference: 100,
            anchor_version: 3, block_index: 9, checkpoint_seq: 10,
            attest_sigs: [{ pubkey: 'aa', sig: 'cc' }]
        };
        expect(pub.federatedRewardTuple(payload)).to.include({ rewardType: 'anchor_bundle', version: 3 });
        expect(pub.federatedRewardTuple(Object.assign({}, payload, { reward_type: 'anchor_archive' }))).to.equal(null);
    });
});
