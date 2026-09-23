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
// StateAnchorPublisher: the v0 bundle election on a mesh: per-row election
// with the archive leader and back-fill, the already-anchored and rootless
// checkpoint skips, failover adoption of a mined bundle, the failover ladder,
// and one bundle per election for every chain.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const { waitUntil }         = require('../../../helpers/waitUntil');
const { CP_ROW, parseV7Sections, buildMesh, v0Order, archiveLeader, startAll, flushAll,
        registerMeshHooks } = require('../../../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerMeshElectionCase();
    registerCheckpointSkipCases();
    registerFailoverAdoptionCase();
    registerLadderCases();
});

// N=4: per-row v0 election plus the archive leader, with back-fill on every hub.
function registerMeshElectionCase() {
    it('N=4: per-row v0 election + archive leader; v1 carries 2f+1 sigs; back-fill propagates', async function () {
        // Count-path: mainnet record below the 961000 SWQ activation, so the archive
        // quorum stays legacy 2f+1 (the weighted path has its own dedicated suite below).
        // checkpointCommitment arms the bundle floor so the block-100 section still rides.
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet', checkpointCommitment: true });
        await startAll(bus);
        let v0Pub  = v0Order(bus)[0];                                  // elected for the BTC checkpoint
        let leader = archiveLeader(bus);                          // elected archive leader
        await flushAll(bus);                                           // every hub's timer fires
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints[0].anchor_txid) && bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the v0 back-fill to reach every hub and the archive to publish' });

        // Exactly one v0, published by the hash-order rank-0 node for that row's key.
        let v0s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '0').map(() => nd));
        expect(v0s.length).to.equal(1);
        expect(v0s[0]).to.equal(v0Pub);
        // XANC_BUNDLE_DONE back-fills every peer's rows, so no other hub re-anchors.
        for (let nd of bus.nodes) expect(nd.db.checkpoints[0].anchor_txid, 'node ' + nd.i).to.be.a('string');

        // Exactly one v1, published by the elected archive leader with quorum sigs.
        let v1Nodes = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(v1Nodes.length).to.equal(1);
        expect(v1Nodes[0]).to.equal(leader);
        let v1 = leader.published.find(p => p.split('|')[1] === '1').split('|');
        let sigCount = Number(v1[16]);
        expect(sigCount).to.be.at.least(3);                            // quorum 2f+1 = 3
        let canonical = leader.pub.archiveCanonical(leader.pub.cpFromRow(leader.db.checkpoints[0]), 0, 1, v1[13], 1);
        for (let i = 0; i < sigCount; i++)
            expect(ValidatorIdentity.verify(canonical, v1[18 + 2 * i], v1[17 + 2 * i])).to.be.true;

        // All nodes back-filled batch metadata (leader directly, rest via XANC_FINALIZED).
        for (let nd of bus.nodes) {
            expect(nd.db.matches[0].batch_seq, 'node ' + nd.i).to.equal(0);
            expect(nd.db.matches[0].archived_status).to.equal('finalized');
        }

        // Rewards: EVERY hub records both rows - the earner at publish time, the
        // rest by mirroring the signature-verified BUNDLE_DONE / FINALIZED
        // announcements - credited to the publisher/leader with the quorum-agreed
        // snapshot_block, so all hubs hold identical reward rows and any of them
        // can build/verify the archive's rewards section. ONE anchor_bundle per
        // bundle, keyed on the bundle's snapshot_block (D3, D21).
        for (let nd of bus.nodes) {
            let v0r = nd.rewards.filter(r => r.type === 'anchor_bundle');
            expect(v0r.length, 'node ' + nd.i + ' anchor_bundle').to.equal(1);
            expect(v0r[0], 'node ' + nd.i).to.deep.equal({ type: 'anchor_bundle', round: 100, pubkey: v0Pub.pubkey, blk: 100 });
            let arr = nd.rewards.filter(r => r.type === 'anchor_archive');
            expect(arr.length, 'node ' + nd.i + ' anchor_archive').to.equal(1);
            expect(arr[0], 'node ' + nd.i).to.deep.equal({ type: 'anchor_archive', round: 0, pubkey: leader.pubkey, blk: 100 });
        }
    });
}

// An already-anchored chain is omitted and a rootless checkpoint is skipped.
function registerCheckpointSkipCases() {
    it('omits a chain whose newest eligible checkpoint is already anchored (the normal daily case)', async function () {
        // D4: a short bundle is not an anomaly. Under a daily cadence any chain that did
        // not cut a new checkpoint is simply absent, and the cycle must not wait for it.
        let bus = buildMesh(1);
        let nd  = bus.nodes[0];
        nd.db.checkpoints.length = 0;
        for (let chain of ['BTC', 'LTC', 'DOGE'])
            nd.db.checkpoints.push(Object.assign({}, CP_ROW, {
                chain: chain, anchor_txid: chain === 'LTC' ? 'already-anchored' : null }));
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '0'), { label: 'the short bundle to be published' });

        let bundle = nd.published.find(p => p.split('|')[1] === '0');
        expect(bundle.split('|')[4], 'SECTION_COUNT').to.equal('2');
        expect(parseV7Sections(bundle).map(x => x.chain), 'LTC is absent, the cycle still anchors')
            .to.deep.equal(['BTC', 'DOGE']);
        expect(nd.db.checkpoints.find(c => c.chain === 'LTC').anchor_txid, 'LTC keeps its earlier anchor')
            .to.equal('already-anchored');
        expect(nd.pub.getAnchorStats()).to.include({ anchorsPublished: 1, sectionsAnchored: 2 });
    });

    it('skips a checkpoint with no light-client roots rather than emitting a rootless section (D8)', async function () {
        let bus = buildMesh(1);
        let nd  = bus.nodes[0];
        nd.db.checkpoints.length = 0;
        nd.db.checkpoints.push(Object.assign({}, CP_ROW, { chain: 'BTC', anchor_txid: null }));
        nd.db.checkpoints.push(Object.assign({}, CP_ROW, { chain: 'LTC', anchor_txid: null,
            state_root: null, state_root_version: null, block_merkle_root: null, block_merkle_version: null }));
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '0'), { label: 'the root-bearing section to be published' });

        expect(parseV7Sections(nd.published.find(p => p.split('|')[1] === '0')).map(x => x.chain))
            .to.deep.equal(['BTC']);
        expect(nd.db.checkpoints.find(c => c.chain === 'LTC').anchor_txid, 'the rootless row stays pending').to.equal(null);
    });
}

// A failover publisher adopts an already-mined bundle without a second spend.
function registerFailoverAdoptionCase() {
    it('a failover publisher ADOPTS an already-mined bundle by per-section lookup, with no second spend', async function () {
        // AT5 in unit form. The rank-0 hub publishes; the rank-1 hub then flushes with
        // its ladder unlocked and its rows still un-stamped (the announcement never
        // reached it). findExistingBundle resolves every section to the SAME mined
        // transaction, so the backup adopts that txid rather than paying again.
        let bus = buildMesh(2, { btcBlock: 200 });    // 100 blocks past snapshot_block: rank 1 unlocked
        let order  = v0Order(bus);
        let leader = order[0], backup = order[1];
        await startAll(bus);
        await leader.pub.flush();
        await waitUntil(() => leader.db.checkpoints[0].anchor_txid, { label: 'the leader to anchor the bundle' });

        // The backup never saw the announcement, so its row is still un-stamped.
        backup.db.checkpoints[0].anchor_txid = null;
        let before = backup.published.length;
        await backup.pub.flush();

        expect(backup.published.length, 'no second transaction is built').to.equal(before);
        // It stamps the txid its OWN indexer reports for the mined sections, which is what
        // the adopt path exists to recover: the bundle is on chain, so nothing is re-sent.
        expect(backup.db.checkpoints[0].anchor_txid, 'the backup adopts the mined bundle').to.equal('onchain-txid');
        // An adoption is NOT a publish: this hub spent nothing, so every publish counter
        // stays flat and only the adoption counter moves.
        let st = backup.pub.getAnchorStats();
        expect(st.anchorsPublished,  'adoption is not a publish').to.equal(0);
        expect(st.sectionsAnchored,  'no sections were paid for').to.equal(0);
        expect(st.anchorsAsBackup,   'no failover publish happened').to.equal(0);
        expect(st.anchorsAsLeader,   'nor a leader publish').to.equal(0);
        expect(st.anchorsAdopted,    'the adoption is still visible').to.equal(1);
        expect(st.lastAnchorRank.adopted, 'and the last-anchor posture names it').to.equal(true);
        expect(st.anchorsAsLeader + st.anchorsAsBackup, 'the split still sums to anchorsPublished')
            .to.equal(st.anchorsPublished);
        // Contrast that keeps the assertions above honest: the paying hub still counts,
        // so this is a narrowed signal rather than a silenced one.
        let ls = leader.pub.getAnchorStats();
        expect(ls.anchorsPublished, 'the hub that paid still counts the publish').to.equal(1);
        expect(ls.anchorsAdopted,   'and did not adopt anything').to.equal(0);
    });
}

// The failover ladder unlocks by rank, and every chain rides ONE bundle.
function registerLadderCases() {
    it('failover ladder: higher ranks unlock only after the tolerance window', async function () {
        // since = btcBlock - snapshot_block = 37 → floor(37/36) = 1 → ranks 0–1.
        let bus = buildMesh(4, { btcBlock: 137 });
        await startAll(bus);
        let order = v0Order(bus);

        await order[2].pub.flush();                                    // rank 2: still locked
        await order[3].pub.flush();                                    // rank 3: still locked
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '0').length).to.equal(0);

        await order[1].pub.flush();                                    // rank 1: unlocked (rank 0 absent)
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '0')), { label: 'the unlocked rank-1 publisher to emit the v0 anchor' });
        let v0s = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '0'));
        expect(v0s.length).to.equal(1);
        expect(v0s[0]).to.equal(order[1]);
        // Back-fill reached rank 0 too - it won't double-publish when it returns.
        await order[0].pub.flush();
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '0').length).to.equal(1);
    });

    it('every chain rides ONE bundle under ONE election, not one anchor per chain', async function () {
        // The whole point of the bundle. Three pending checkpoints, one per chain, all at the
        // same block: exactly one hub publishes exactly one transaction carrying three
        // sections, and exactly one anchor_bundle reward is earned. The retired per-row
        // election could hand these to three different publishers and three DOGE fees.
        let bus = buildMesh(4, { btcBlock: 101 });
        for (let nd of bus.nodes) {
            nd.db.checkpoints.length = 0;
            for (let chain of ['BTC', 'LTC', 'DOGE'])
                nd.db.checkpoints.push(Object.assign({}, CP_ROW, { chain: chain, anchor_txid: null }));
        }
        await startAll(bus);
        await flushAll(bus);
        await waitUntil(() => bus.nodes.every(nd => nd.db.checkpoints.every(c => c.anchor_txid)), { label: 'every chain to be anchored on every hub' });

        let bundles = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '0'));
        expect(bundles.length, 'ONE transaction for the whole cycle').to.equal(1);
        expect(parseV7Sections(bundles[0]).map(x => x.chain), 'three sections, chain-ascending')
            .to.deep.equal(['BTC', 'DOGE', 'LTC']);

        let expectedPublisher = v0Order(bus)[0];
        let publishers = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '0'));
        expect(publishers.length, 'one elected publisher for the bundle').to.equal(1);
        expect(publishers[0]).to.equal(expectedPublisher);
        expect(publishers[0].rewards.filter(r => r.type === 'anchor_bundle' && r.round === 100).length,
            'ONE anchor_bundle reward for the whole bundle').to.equal(1);
        expect(publishers[0].pub.getAnchorStats()).to.include({ anchorsPublished: 1, sectionsAnchored: 3 });
        // Every node's row for every chain is anchored (publisher or gossip).
        for (let chain of ['BTC', 'LTC', 'DOGE'])
            for (let nd of bus.nodes)
                expect(nd.db.checkpoints.find(c => c.chain === chain).anchor_txid, chain + ' node ' + nd.i).to.be.a('string');
    });
}
