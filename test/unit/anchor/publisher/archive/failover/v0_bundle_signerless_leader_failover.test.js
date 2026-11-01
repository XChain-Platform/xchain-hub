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

// Pins the v0 bundle failover ladder on content age: when the elected rank 0 has
// no signer, its flush skips, and the rank 1 backup anchors the pending bundle with
// both the old and the newer checkpoint sections, ages counted from the oldest
// pending content rather than the newest row. With a new checkpoint every six blocks
// replacing the pending section, the age runs from the first checkpoint since the
// chain's last anchor, and leader and followers measure it the same way.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const assert = require('node:assert/strict');
const { CP_ROW, buildMesh, v0Order, startAll, parseV7Sections, registerMeshHooks } =
    require('../../../../../helpers/anchor_mesh.js');

const NETWORK = 'regtest';

// A four-hub regtest mesh whose seeded checkpoint (seq 7 @ 100) is the chain's last
// anchor, with every hub's BTC tip read from `state.tip`.
function anchoredMesh(state){
    const bus = buildMesh(4, { btcBlock: state.tip, network: NETWORK, checkpointCommitment: true, matches: [] });
    for(const node of bus.nodes){
        node.db.checkpoints[0].anchor_txid = 'feedbeef';
        node.pub.hub.resolveBtcLatestBlock = async () => state.tip;
    }
    return bus;
}

// Move the tip six blocks and give every hub the checkpoint at it.
function addCheckpoint(bus, state){
    state.tip += 6;
    state.seq += 1;
    for(const node of bus.nodes)
        node.db.checkpoints.push(Object.assign({}, CP_ROW, {
            id: state.seq, network: NETWORK, snapshot_block: state.tip, checkpoint_seq: state.seq,
            block_index: CP_ROW.block_index + state.tip - 100, anchor_txid: null
        }));
}

// Run `pipeline`'s failover wake after each new checkpoint until it anchors a bundle
// or the tip passes every rank's unlock plus eight more checkpoints.
async function churnUntilAnchored(bus, pipeline, state, contentBlock){
    const tolerance = pipeline.pub.electionToleranceBlocks;
    const steps = [];
    while(tolerance * 3 + 48 > state.tip - contentBlock){
        addCheckpoint(bus, state);
        const rank = v0Order(bus, { network: NETWORK, snapshot_block: state.tip }).indexOf(pipeline);
        const unlocked = Math.floor((state.tip - contentBlock) / tolerance);
        const before = pipeline.published.length;
        await pipeline.pub.flush({ failoverOnly: true });
        const bundles = pipeline.published.slice(before).filter(payload => payload.split('|')[1] === '0');
        steps.push({ tip: state.tip, rank, unlocked, bundle: bundles[0] || null });
        if(bundles.length) break;
    }
    return steps;
}

// The XANCPUB co-sign request `proposer` sends for the bundle over `rows`.
function attestRequest(proposer, rows){
    const snapshotBlock = Math.max(...rows.map(row => row.snapshot_block));
    const canonical = proposer.pub.attestationCanonical({ network: NETWORK, snapshot_block: snapshotBlock },
                                                         proposer.pubkey);
    return { type: 'XANCPUB_SIGN_REQ', sender: proposer.pubkey, data: {
        network: NETWORK, snapshot_block: snapshotBlock,
        sections: rows.map(row => ({ chain: row.chain, block_index: row.block_index,
                                     checkpoint_seq: row.checkpoint_seq })),
        body: proposer.pub.buildV7Payload(rows, proposer.pubkey, []),
        publisher: proposer.pubkey, sig_pubkey: proposer.pubkey, sig: proposer.identity.sign(canonical)
    } };
}

// The wake anchors at the first checkpoint whose backup rank has unlocked, never
// earlier; returns that step.
function assertAnchoredAtFirstUnlock(steps){
    const last = steps[steps.length - 1];
    assert.ok(last.bundle, 'no bundle anchored: ' + JSON.stringify(steps));
    for(const step of steps.slice(0, -1))
        assert.ok(step.rank === 0 || step.rank > step.unlocked, JSON.stringify(step));
    assert.ok(last.rank >= 1 && last.rank <= last.unlocked, JSON.stringify(last));
    return last;
}

// Did `follower` co-sign `proposer`'s attestation request? Read from its XANCPUB_SIGN broadcast.
async function coSigns(follower, proposer, rows){
    const sent = [];
    const broadcast = follower.pub.peerManager.broadcast;
    follower.pub.peerManager.broadcast = (type, data) => { sent.push(type); };
    try { await follower.pub.handleAttestSignReq(attestRequest(proposer, rows)); }
    finally { follower.pub.peerManager.broadcast = broadcast; }
    return sent.includes('XANCPUB_SIGN');
}

// Hand `follower` the signed BUNDLE_DONE `publisher` announces for `row` under `txid`.
async function deliverBundleDone(follower, publisher, row, txid){
    const d = { network: NETWORK, snapshot_block: row.snapshot_block, txid,
                sections: [{ chain: row.chain, block_index: row.block_index, checkpoint_seq: row.checkpoint_seq }],
                sig_pubkey: publisher.pubkey };
    d.sig = publisher.identity.sign(publisher.pub.bundleDoneCanonical(d, txid));
    await follower.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
}

describe('v0 bundle failover with a signerless rank 0', function () {
    registerMeshHooks();

    it('a backup anchors a mixed-height v0 bundle when rank 0 is signerless', async function () {
        const bus = buildMesh(4, { btcBlock: 137, network: 'mainnet', checkpointCommitment: true });
        for(const node of bus.nodes){
            node.db.checkpoints.push(Object.assign({}, CP_ROW, {
                chain: 'LTC', network: 'mainnet', snapshot_block: 136,
                checkpoint_seq: 7, block_index: 990, anchor_txid: null
            }));
        }
        const order = v0Order(bus, { network: 'mainnet', snapshot_block: 136 });
        const leader = order[0];
        const backup = order[1];
        leader.pub.setBroadcastHook(null);
        await startAll(bus);
        assert.equal((await leader.pub.flush()).skipped, 'no_pipeline');
        await backup.pub.flush();
        const bundles = backup.published.filter(payload => payload.split('|')[1] === '0');
        assert.equal(bundles.length, 1);
        assert.deepEqual(parseV7Sections(bundles[0]).map(section => section.snapshot_block), [100, 136]);
        assert.equal(backup.pub.getAnchorStats().anchorsAsBackup, 1);
    });

    // The rail case: one hub has a DOGE pipeline and only runs the failover wake, which
    // skips rank 0; the others have none, so a rank 0 that is not the pipeline hub never
    // anchors. Aged from the replaced section, no backup rank ever unlocked.
    it('a backup anchors within the ladder bound while checkpoints churn every six blocks', async function () {
        const state = { tip: 100, seq: 7 };
        const bus = anchoredMesh(state);
        const pipeline = bus.nodes[0];
        for(const node of bus.nodes.slice(1)) node.pub.setBroadcastHook(null);
        await startAll(bus);

        const steps = await churnUntilAnchored(bus, pipeline, state, 106);
        const last = assertAnchoredAtFirstUnlock(steps);
        assert.deepEqual(parseV7Sections(last.bundle).map(section => section.snapshot_block), [last.tip]);
        // Every follower accepts the backup's BUNDLE_DONE on its own ladder and stamps the section
        for(const follower of bus.nodes.slice(1)){
            const row = follower.db.checkpoints.find(r => r.checkpoint_seq === state.seq);
            await deliverBundleDone(follower, pipeline, row, 'txid1');
            assert.equal(row.anchor_txid, 'txid1', 'follower ' + follower.i + ' did not stamp the anchored section');
        }
    });

    it('a follower co-signs the attestation of a rank its own rows have unlocked, and no higher', async function () {
        const state = { tip: 100, seq: 7 };
        const bus = anchoredMesh(state);
        for(let i = 0; i < 6; i++) addCheckpoint(bus, state);       // newest @ 136, content since 106
        state.tip = 142;                                             // 36 blocks of content age: rank 1 only
        const order = v0Order(bus, { network: NETWORK, snapshot_block: 136 });
        const follower = order[3];
        const rows = follower.db.checkpoints.filter(r => r.checkpoint_seq === state.seq);
        assert.equal(await coSigns(follower, order[1], rows), true);
        assert.equal(await coSigns(follower, order[2], rows), false);
    });

});
