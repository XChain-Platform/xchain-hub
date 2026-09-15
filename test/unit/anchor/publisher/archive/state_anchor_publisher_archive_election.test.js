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
// StateAnchorPublisher: the archive signing round on a mesh: follower refusal
// of a divergent archive, late joiners, the archive failover ladder, the
// oracle_publish membership gates, the snapshot_block signing set, and an
// archive that cannot reach on-chain quorum.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const { waitUntil }         = require('../../../../helpers/waitUntil');
const { buildMesh, archiveOrder, archiveLeader, startAll, flushAll, pkOf, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerFollowerCoSignCases();
    registerArchiveLadderCases();
    registerMembershipGateCases();
    registerSnapshotSetCase();
    registerArchiveQuorumFailureCase();
});

// Followers refuse a divergent archive and late joiners co-sign by signature quorum.
function registerFollowerCoSignCases() {
    it('followers refuse an archive that diverges from their own match rows', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        let leader = archiveLeader(bus);
        // Two followers hold a different amount for m1 → the leader can reach at
        // most 2 sigs (self + 1 honest) < quorum 3 → nothing published.
        let mutated = 0;
        for (let nd of bus.nodes) {
            if (nd !== leader && mutated < 2) { nd.db.matches[0].a_amount = '999'; mutated++; }
        }
        await startAll(bus);
        // flush() is fully awaited and every co-sign this round can collect is gathered
        // inside it, so the refusal is already decided here: there is no later condition
        // a poll could wait for, and the fixed settle it replaces only added dead time.
        await leader.pub.flush();
        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length).to.equal(0);
        for (let nd of bus.nodes) expect(nd.db.matches[0].batch_seq).to.equal(null);
    });

    it('late joiners co-sign archives covering history they never held (signature quorum alone)', async function () {
        // Live finding (3-hub venue): rows from the single-hub era exist only in
        // the founding hub's DB; followers added later refused every archive
        // containing them ("diverges from our DB"), so quorum 3 could never be
        // reached and history became unarchivable. A locally-MISSING row must be
        // accepted purely on its archived 2f+1 signatures; a present-but-
        // DIFFERENT row must still refuse (the divergence test above).
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet' });   // count-path (SWQ off below 961000)
        let leader = archiveLeader(bus);
        let pruned = 0;
        for (let nd of bus.nodes) {
            if (nd !== leader && pruned < 2) { nd.db.matches.length = 0; pruned++; }   // joined after m1
        }
        await startAll(bus);
        await leader.pub.flush();
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the archive to publish despite two late joiners' });

        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length, 'archive published despite two late joiners').to.equal(1);
        let v1 = v1s[0].split('|');
        expect(Number(v1[16]), 'sig count').to.be.at.least(3);                          // real quorum
    });
}

// The archive failover ladder, and a hub outside the snapshot never publishes.
function registerArchiveLadderCases() {
    it('archive failover ladder: a non-leader publishes once its rank unlocks, with full co-sign quorum', async function () {
        // Live finding (3-hub test cluster): the archive election had NO rank
        // tolerance - a signer-less elected leader stalled archiving (only
        // 1-of-3 elections could publish), and on a static regtest tip the
        // same leader won forever. The election key is now content-anchored
        // (wrapper checkpoint + batch seq) and ranks unlock like v0 anchors:
        // since = btcBlock - wrapper snapshot_block = 37 → floor(37/36) = 1.
        let bus = buildMesh(4, { btcBlock: 137, network: 'mainnet' });   // count-path (SWQ off below 961000)
        await startAll(bus);
        let order = archiveOrder(bus);

        await order[2].pub.flush();                                    // rank 2: still locked
        await order[3].pub.flush();                                    // rank 3: still locked
        expect(bus.nodes.flatMap(nd => nd.published).filter(p => p.split('|')[1] === '1').length).to.equal(0);

        await order[1].pub.flush();                                    // rank 1: unlocked (rank-0 hub signer-less)
        await waitUntil(() => order[1].published.some(p => p.split('|')[1] === '1') && bus.nodes.every(nd => nd.db.matches[0].batch_seq === 0), { label: 'the rank-1 archive to publish and back-fill every hub' });
        let v1Nodes = bus.nodes.filter(nd => nd.published.some(p => p.split('|')[1] === '1'));
        expect(v1Nodes.length).to.equal(1);
        expect(v1Nodes[0]).to.equal(order[1]);
        // Followers co-signed the rank-1 publisher - a real quorum, not a self-sign.
        let v1 = order[1].published.find(p => p.split('|')[1] === '1').split('|');
        expect(Number(v1[16])).to.be.at.least(3);
        // Back-fill reached every node - the stalled rank-0 won't re-archive on return.
        for (let nd of bus.nodes) expect(nd.db.matches[0].batch_seq, 'node ' + nd.i).to.equal(0);
    });

    it('a hub outside the oracle_publish snapshot never publishes', async function () {
        let bus = buildMesh(4, { btcBlock: 101 });
        // Drop node 0 from every hub's view of the eligible set.
        let outsider = bus.nodes[0];
        for (let nd of bus.nodes) {
            let eligible = bus.nodes.filter(o => o !== outsider).map(o => ({ pubkey: o.pubkey, amount: '1' }));
            nd.pub.capSnapshot = { async getSnapshot() { return { validators: eligible }; } };
            nd.pub.hub.capabilitySnapshot = nd.pub.capSnapshot;
        }
        await startAll(bus);
        await outsider.pub.flush();
        expect(outsider.published.length).to.equal(0);
        expect(outsider.rewards.length).to.equal(0);
    });
}

// An empty oracle_publish set defers publication and fails mayPublish closed.
function registerMembershipGateCases() {
    // ── fail closed when the oracle_publish set is empty / unresolved ────────────
    // An empty eligible set (empty validator snapshot, or an indexer that resolves
    // to no oracle_publish members) must DEFER publication, not bypass the election
    // gate. The pre-fix bug skipped the gate on an empty set, so every hub anchored
    // the same checkpoint from its own DOGE wallet - a guaranteed N-way double-
    // anchor + fee burn. Both call sites (v0 anchor + v1/v2 archive) fail closed.
    it('an empty oracle_publish set defers publication (no v0 anchor, no v1 archive, no reward)', async function () {
        let bus = buildMesh(3, { btcBlock: 200 });
        let empty = { async getSnapshot() { return { validators: [] }; } };
        for (let nd of bus.nodes) { nd.pub.capSnapshot = empty; nd.pub.hub.capabilitySnapshot = empty; }
        await startAll(bus);
        let summaries = [];
        for (let nd of bus.nodes) summaries.push(await nd.pub.flush());
        // Nothing went out from ANY hub, and no anchor reward was minted.
        for (let nd of bus.nodes) {
            expect(nd.published.length, 'node ' + nd.i + ' published nothing').to.equal(0);
            expect(nd.rewards.length, 'node ' + nd.i + ' minted no reward').to.equal(0);
        }
        for (let s of summaries) {
            expect(s.anchored.length, 'no checkpoints anchored').to.equal(0);
            expect(s.archive, 'archive round deferred').to.equal('none');
        }
        // The pending checkpoint is still unanchored on every hub (deferred, not lost).
        for (let nd of bus.nodes) expect(nd.db.checkpoints[0].anchor_txid).to.equal(null);
    });

    it('mayPublish fails closed on an empty election order', function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        expect(nd.pub.mayPublish([], 0)).to.equal(false);
        expect(nd.pub.mayPublish([], 1000)).to.equal(false);
        // Sanity: a real single-member order in which this hub is rank 0 still may.
        expect(nd.pub.mayPublish([nd.pubkey], 0)).to.equal(true);
    });
}

// The archive is signed by the snapshot_block set, not the election-block set.
function registerSnapshotSetCase() {
    // ── signing set is resolved at snapshot_block, not the election block ────────
    // The published v1 declares the wrapper checkpoint's snapshot_block on the
    // wire, and the indexer + full-parse recovery verify the wrapper signatures
    // against oracle_publish AT snapshot_block. The leader is elected by the
    // current BTC block for liveness, but the SIGNING/QUORUM set must track
    // snapshot_block - otherwise, when oracle_publish membership drifts inside the
    // tolerance window, a signer present only in the election set contributes a
    // signature the indexer drops, the v1 stores `invalid`, and the rows (already
    // dequeued) become permanently unrecoverable.
    it('archive is signed by the snapshot_block set even when the election-block set has drifted', async function () {
        // Wrapper checkpoint snapshot_block = 100 (CP_ROW); current BTC tip = 110
        // (a 10-block drift, well inside the 36-block tolerance window). Between
        // the two blocks oracle_publish membership changed: C left, D joined.
        let bus = buildMesh(4, { btcBlock: 110, network: 'mainnet' });   // count-path (SWQ off below 961000)
        let [A, B, C, D] = bus.nodes;
        let snapSet = [A, B, C].map(nd => ({ pubkey: nd.pubkey, amount: '1' }));   // oracle_publish @ snapshot_block 100
        let elecSet = [A, B, D].map(nd => ({ pubkey: nd.pubkey, amount: '1' }));   // oracle_publish @ election block 110
        let fullSet = bus.nodes.map(nd => ({ pubkey: nd.pubkey, amount: '1' }));   // cross_chain (block-agnostic here)
        let blockAware = {
            async getSnapshot(capability, block) {
                if (capability === 'cross_chain') return { validators: fullSet };
                return { validators: (Number(block) === 100) ? snapSet : elecSet };  // oracle_publish
            }
        };
        for (let nd of bus.nodes) { nd.pub.capSnapshot = blockAware; nd.pub.hub.capabilitySnapshot = blockAware; }

        await startAll(bus);
        await flushAll(bus);
        await waitUntil(() => bus.nodes.some(nd => nd.published.some(p => p.split('|')[1] === '1')), { label: 'the archive to publish under the snapshot-block signer set' });

        // Exactly one v1, and every signature on it belongs to the snapshot_block
        // set - so the indexer, verifying against oracle_publish @ snapshot_block,
        // accepts them all and stores the archive `valid`.
        let v1s = bus.nodes.flatMap(nd => nd.published.filter(p => p.split('|')[1] === '1'));
        expect(v1s.length, 'exactly one v1 archive').to.equal(1);
        let v1 = v1s[0].split('|');
        expect(v1[10], 'wire SNAPSHOT_BLOCK').to.equal('100');
        let sigCount = Number(v1[16]);
        let snapPubkeys = new Set(snapSet.map(v => v.pubkey));
        let signers = [];
        for (let i = 0; i < sigCount; i++) signers.push(v1[17 + 2 * i]);
        for (let s of signers)
            expect(snapPubkeys.has(s), 'signer ' + s.substring(0, 12) + '… is in the snapshot_block set').to.equal(true);
        // The election-only validator D never contributes a signature that would
        // be dropped on-chain (the pre-fix bug had it signing into the quorum).
        expect(signers.includes(D.pubkey), 'election-only validator absent from the v1 sigs').to.equal(false);
        // Indexer simulation: valid sigs over oracle_publish @ snapshot_block (N=3
        // → quorum 2) clear quorum, so the v1 is on-chain `valid`.
        expect(signers.length, 'sigs valid at snapshot_block reach quorum').to.be.at.least(2);

        // The archive is valid, so the source rows are safely dequeued on every hub.
        for (let nd of bus.nodes) {
            expect(nd.db.matches[0].batch_seq, 'node ' + nd.i).to.equal(0);
            expect(nd.db.matches[0].archived_status, 'node ' + nd.i).to.equal('finalized');
        }
    });
}

// publishArchive keeps rows pending without on-chain quorum.
function registerArchiveQuorumFailureCase() {
    // ── back-fill is gated on confirmed on-chain validity ───────────────────────
    // Even after a successful DOGE broadcast, the source rows must NOT be marked
    // archived unless the broadcast v1 will reach quorum over oracle_publish @
    // snapshot_block (the indexer's own check). Otherwise settled cross-chain
    // state is dequeued behind an `invalid` on-chain copy and lost forever.
    it('publishArchive keeps rows pending when the broadcast v1 cannot reach on-chain quorum', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let cp = nd.pub.cpFromRow(nd.db.checkpoints[0]);                  // snapshot_block 100
        let batchSeq = 0, count = 1, crc = 'deadbeef';
        let canonical = nd.pub.archiveCanonical(cp, batchSeq, count, crc, 1);
        // A 3-member snapshot signing set (quorum 2) but only the leader's own
        // signature collected (1 valid) - the indexer would reject it as invalid.
        let validators = [nd.pubkey, pkOf(1), pkOf(2)];
        let round = {
            cp, batchSeq, crc, count, canonical,
            b64: 'x', chunks: ['x'],
            signer: { broadcastFn: nd.pub.broadcastFn },
            quorum: 2,
            matchIds: [{ match_id: 'm1', status: 'finalized' }],
            callIds: [], rewardIds: [],
            validators,
            signatures: new Map([[nd.pubkey, nd.identity.sign(canonical)]]),
            done: true, timer: null
        };
        await nd.pub.publishArchive(round);
        await waitUntil(() => nd.published.some(p => p.split('|')[1] === '1'), { label: 'the v1 archive broadcast' });

        // The v1 broadcast happened (a txid was produced) …
        expect(nd.published.some(p => p.split('|')[1] === '1'), 'v1 was broadcast').to.equal(true);
        // … but the row stays PENDING: batch_seq advances (a re-archive needs a
        // fresh seq) while archived_status is the sentinel, so archived_status <>
        // status keeps it eligible for re-archival rather than lost.
        expect(nd.db.matches[0].batch_seq, 'seq advances').to.equal(0);
        expect(nd.db.matches[0].archived_status, 'row stays pending via sentinel').to.equal('__partial__');
        // No archive reward is recorded for an invalid (non-finalized) publish.
        expect(nd.rewards.filter(r => r.type === 'anchor_archive').length, 'no reward on invalid publish').to.equal(0);
    });
}
