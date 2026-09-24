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
// StateAnchorPublisher: what a XANC_FINALIZED binds (the archive txid and v1
// version, the announced status, the reward types, the sender's oracle_publish
// membership) and what backfillBatch may re-stamp and re-broadcast.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const { CP_ROW, matchRow, buildMesh, registerMeshHooks } = require('../../../helpers/anchor_mesh.js');
const HubDbBroadcaster      = require('../../../../src/peers/hub_db_broadcaster.js');
const { admitMarginBlocks } = require('../../../../src/consensus/gates/mirror_admission_gate.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerTxidBindingCases();
    registerStatusDivergenceCase();
    registerRewardListGateCases();
    registerBackfillStampCase();
    registerBackfillBroadcastCases();
    registerLateWindowStampCase();
});

// ── XANC-ELECTED-FORGE-1 (archive half): bind the v1 archive txid ────────────
// Proving the CHECKPOINT is anchored is not enough: an elected leader could
// reference a real-but-different anchored checkpoint and still mirror itself the
// anchor_archive reward, which is LIVE (not retired by the anchor-reward flag-day).

// The announced txid and v1 version are bound to the indexer lookup.
function registerTxidBindingCases() {
    it('a FINALIZED binds the announced archive txid and v1 version to the indexer lookup', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub.recordObservedArchiveLeader(11, leader.pubkey, CP_ROW);
        let seen = null;
        follower.pub.indexerCall = async (coin, method, params) => {
            seen = params;
            return { exists: true, checkpoint_anchored: true, status: 'valid', version: Number(params.version),
                     confirmations: follower.pub.dogeConfirmations, txid: params.txid,
                     block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
                     actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash };
        };
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 11, txid: 'ab'.repeat(32), snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(11, 'ab'.repeat(32), fMatches.length))
        }});
        expect(seen.txid, 'archive gate binds the announced v1 head txid').to.equal('ab'.repeat(32));
        expect(seen.version, 'archive gate binds ANCHOR v1').to.equal(1);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'a verified archive anchor mirrors the reward').to.equal(true);
    });

    it('a FINALIZED naming a txid that is NOT the on-chain archive earns no reward', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub.recordObservedArchiveLeader(12, leader.pubkey, CP_ROW);
        // The checkpoint IS anchored, but no v1 archive with the announced txid exists:
        // the elected leader is referencing someone else's anchor.
        follower.pub.indexerCall = async () => ({ exists: false, checkpoint_anchored: true, confirmations: 0 });
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 12, txid: 'ff'.repeat(32), snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(12, 'ff'.repeat(32), fMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'referencing a different anchor earns nothing').to.equal(false);
    });
}

// An announced status that diverges from the local row is rejected.
function registerStatusDivergenceCase() {
    it('a FINALIZED whose announced status diverges from the local row is rejected (unsigned content)', async function () {
        // XANC-FINALIZED-CONTENT-1: the XANCFIN canonical binds only (batch_seq,
        // txid, match COUNT), so a Byzantine ELECTED leader could announce
        // attacker-chosen id/status lists. The receiver must re-verify announced
        // content against its own rows before stamping.
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub.recordObservedArchiveLeader(4, leader.pubkey);   // leader IS observed for the batch

        // Announce m1 with a status that diverges from the follower's row
        // ('finalized'): stamping it would mark the row archived under a bogus
        // terminal status and strand it from every future archive round.
        let fMatches = [matchRow('m1', 'attacker_status')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 4, txid: 'dogetx_content', snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(4, 'dogetx_content', fMatches.length))
        }});
        let m1 = follower.db.matches.find(m => m.match_id === 'm1');
        expect(m1.batch_seq, 'no batch_seq stamped from diverging content').to.equal(null);
        expect(m1.archived_status, 'no archived_status stamped').to.equal(null);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'), 'no reward mirrored').to.equal(false);

        // Control: the TRUE status (and the __partial__ sentinel) both pass, so
        // the rejection above came from the content check, not a malformed envelope.
        let okMatches = [matchRow('m1', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 4, txid: 'dogetx_content', snapshot_block: 100, matches: okMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(4, 'dogetx_content', okMatches.length))
        }});
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq,
            'matching content IS stamped').to.equal(4);
    });
}

// The reward list and the sender's oracle_publish membership gate the mirror.
function registerRewardListGateCases() {
    it('a FINALIZED with a non-anchor reward_type in the reward list is rejected', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub.recordObservedArchiveLeader(5, leader.pubkey);
        follower.db.rewardRows.push({ reward_type: 'oracle_round', round_number: 1,
                                      validator_pubkey: leader.pubkey, batch_seq: null, block_index: 100 });
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 5, txid: 'dogetx_rw', snapshot_block: 100, matches: fMatches, calls: [],
            rewards: [{ reward_type: 'oracle_round', round_number: 1, validator_pubkey: leader.pubkey }],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(5, 'dogetx_rw', fMatches.length))
        }});
        expect(follower.db.rewardRows[0].batch_seq, 'indexer-derived reward row NOT stamped').to.equal(null);
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq, 'whole message rejected').to.equal(null);
    });

    it('the archive-reward mirror rejects a snapshot_block where the sender holds no oracle_publish', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub.recordObservedArchiveLeader(6, leader.pubkey);
        // d.snapshot_block is unsigned: resolve an EMPTY oracle_publish set at the
        // announced block (membership everywhere else stays intact).
        let orig = follower.pub.getActiveOraclePublishPubkeys.bind(follower.pub);
        follower.pub.getActiveOraclePublishPubkeys = async (blk) => (blk === 999999 ? [] : orig(blk));
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 6, txid: 'dogetx_snap', snapshot_block: 999999, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(6, 'dogetx_snap', fMatches.length))
        }});
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq,
            'back-fill itself still applies').to.equal(6);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'no reward mirrored for an unresolvable snapshot_block').to.equal(false);
    });
}

// backfillBatch re-stamps only a __partial__ row.
function registerBackfillStampCase() {
    it('backfillBatch cannot re-stamp a fully archived row, but a __partial__ row re-stamps', async function () {
        // Guard = the pending selectors' archive-eligibility predicate: a settled
        // row (batch_seq set AND archived_status = status) is immutable to a
        // replayed/forged FINALIZED; a __partial__ sentinel row must still take
        // its fresh seq on the legitimate re-archive.
        let archived = Object.assign(matchRow('ma', 'finalized'), { batch_seq: 0, archived_status: 'finalized', anchor_txid: 'dogetx_orig' });
        let partial  = Object.assign(matchRow('mp', 'finalized'), { batch_seq: 0, archived_status: '__partial__' });
        let bus = buildMesh(1, { matches: [archived, partial],
                                 rewards: [{ reward_type: 'anchor_DOGE', round_number: 3,
                                             validator_pubkey: 'aa'.repeat(32), batch_seq: 2, block_index: 100 }] });
        let nd = bus.nodes[0];

        await nd.pub.backfillBatch(9,
            [{ match_id: 'ma', status: 'finalized' }, { match_id: 'mp', status: 'finalized' }],
            'dogetx_replay', [],
            [{ reward_type: 'anchor_DOGE', round_number: 3, validator_pubkey: 'aa'.repeat(32) }]);

        let ma = nd.db.matches.find(m => m.match_id === 'ma');
        expect(ma.batch_seq, 'settled row keeps its original batch').to.equal(0);
        expect(ma.anchor_txid, 'settled row keeps its original txid').to.equal('dogetx_orig');
        expect(nd.db.matches.find(m => m.match_id === 'mp').batch_seq, '__partial__ row re-stamps').to.equal(9);
        expect(nd.db.rewardRows[0].batch_seq, 'already-archived reward row keeps its batch').to.equal(2);
    });
}

// backfillBatch re-broadcasts stamped rows on the mirror feed, and only then.
function registerBackfillBroadcastCases() {
    it('backfillBatch re-broadcasts stamped match rows on the hub-DB mirror feed', async function () {
        let bus = buildMesh(1, { matches: [matchRow('m1'), matchRow('m2', 'retracted')] });
        let nd = bus.nodes[0];
        let broadcast = [];
        nd.pub.hub.hubDbBroadcaster = {
            broadcastMatchAnchorStamp: (matchId, anchorTxid) => broadcast.push({ matchId, anchorTxid })
        };

        await nd.pub.backfillBatch(0,
            [{ match_id: 'm1', status: 'finalized' }, { match_id: 'm2', status: 'retracted' }],
            'dogetx_rebroadcast', [], []);

        // Only the non-retracted row emits a metadata-only update. A full-row replay
        // would either be refused after the admission window or admit a missing row
        // below the certified watermark.
        expect(broadcast.length, 'exactly one re-broadcast').to.equal(1);
        expect(broadcast[0].matchId).to.equal('m1');
        expect(broadcast[0].anchorTxid).to.equal('dogetx_rebroadcast');
    });

    it('backfillBatch does NOT re-broadcast on a null txid or without a broadcaster', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let broadcast = [];
        nd.pub.hub.hubDbBroadcaster = {
            broadcastMatchAnchorStamp: (matchId, anchorTxid) => broadcast.push({ matchId, anchorTxid })
        };

        // Null txid = the archive never landed on-chain (rows stay pending); there is
        // no stamp to propagate, so the feed stays quiet.
        await nd.pub.backfillBatch(0, [{ match_id: 'm1', status: '__partial__' }], null, [], []);
        expect(broadcast.length, 'no re-broadcast for a null txid').to.equal(0);

        // No broadcaster wired (standalone hub before start()): the back-fill itself
        // must still complete without throwing.
        delete nd.pub.hub.hubDbBroadcaster;
        await nd.pub.backfillBatch(1, [{ match_id: 'm1', status: 'finalized' }], 'dogetx_x', [], []);
        expect(nd.db.matches.find(m => m.match_id === 'm1').anchor_txid, 'back-fill still applied').to.equal('dogetx_x');
    });
}

// A stamp raised after the admission window still reaches the mirror, because it
// rides the metadata-only frame rather than a full-row admission.
function registerLateWindowStampCase() {
    it('backfillBatch delivers an anchor stamp after the match admission window closes', async function () {
        let margin = admitMarginBlocks('cross_chain_matches');
        let lateMatch = Object.assign(matchRow('m1'), { admit_block_btc: 899999 + margin });
        let bus = buildMesh(1, { matches: [lateMatch] });
        let nd = bus.nodes[0];
        let broadcaster = new HubDbBroadcaster({}, nd.db);
        broadcaster.admissionWatermark.observeTip('BTC', 900000, Date.now() - 600000);
        let sent = [];
        broadcaster.subscribers.add({
            readyState: 1, bufferedAmount: 0, _hubBuffered: 0,
            send: (raw) => sent.push(JSON.parse(raw)), close: () => {}
        });
        nd.pub.hub.hubDbBroadcaster = broadcaster;

        try {
            await nd.pub.backfillBatch(0, [{ match_id: 'm1', status: 'finalized' }],
                'dogetx_after_window', [], []);
            expect(sent.length, 'the streaming mirror receives the late anchor stamp').to.equal(1);
            expect(sent[0]).to.deep.include({
                type: 'row:anchor-stamped', table: 'cross_chain_matches',
                match_id: 'm1', anchor_txid: 'dogetx_after_window'
            });
            expect(sent[0]).to.not.have.property('row');
        } finally {
            broadcaster.stop();
        }
    });
}
