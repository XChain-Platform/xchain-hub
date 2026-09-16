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
// StateAnchorPublisher: the anchor_archive reward mirror on XANC_FINALIZED: a
// __partial__ archive earns nothing, a forged or unobserved FINALIZED is
// rejected, rows the archive never carried cannot be suppressed, an unanchored
// checkpoint mirrors nothing, and the gate reads the CHECKPOINT network.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const { waitUntil }         = require('../../../../helpers/waitUntil');
const arMod                 = require('../../../../../src/anchor_reward_activation.js');
const { CP_ROW, matchRow, buildMesh, archiveLeader, startAll, flushAll, registerMeshHooks } = require('../../../../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerPartialArchiveCase();
    registerForgedFinalizedCase();
    registerSuppressionCase();
    registerMirrorGateCases();
});

// A __partial__ archive does NOT mirror the reward; a complete one does.
function registerPartialArchiveCase() {
    it('a __partial__ archive does NOT mirror the anchor_archive reward (a complete one does)', async function () {
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];          // signature-verified sender; both are oracle_publish validators
        let txid = 'dogetx_partialtest', snap = 100;
        bus.anchorVersions.set(txid, 1);      // the announced head really is a v1 archive on-chain (#4180 gate)

        // This test drives handleFinalized directly (bypassing the SIGN_REQ round
        // that normally binds the elected leader), so seed the observed-leader
        // binding AND the batch's checkpoint identity the same way handleSignReq
        // would after validating the election. The checkpoint (CP_ROW, in the mesh
        // DB) then verifies on-chain via the harness getanchoraction oracle, so the
        // COMPLETE control reaches the reward mirror.
        follower.pub.recordObservedArchiveLeader(0, leader.pubkey, CP_ROW);
        follower.pub.recordObservedArchiveLeader(1, leader.pubkey, CP_ROW);

        // (1) PARTIAL: a match carries the __partial__ sentinel → the follower must NOT mirror the reward.
        let pMatches = [matchRow('mp', '__partial__')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 0, txid: txid, snapshot_block: snap, matches: pMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(0, txid, pMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'no archive reward on a __partial__ publish').to.be.false;

        // (2) CONTROL - a COMPLETE archive (no sentinel) DOES mirror the reward. Also proves the
        // envelope is well-formed enough to reach the reward gate (guards against a false pass
        // where backfillBatch silently failed for both cases).
        let cMatches = [matchRow('mc', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 1, txid: txid, snapshot_block: snap, matches: cMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(1, txid, cMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'a complete publish DOES mirror the reward').to.be.true;
    });
}

// A FINALIZED from an un-observed member is rejected outright.
function registerForgedFinalizedCase() {
    it('a forged XANC_FINALIZED from an un-observed member is rejected: no back-fill, no reward', async function () {
        // XANC-FINALIZED-STRAND-1 + XANC-REWARD-THEFT-1 (archive half): membership +
        // signature alone let ANY oracle_publish member forge a FINALIZED. Without the
        // observed-leader gate the forge would (a) mark m1 archived under a bogus
        // batch_seq (stranding it from full-parse recovery) and (b) mirror the
        // anchor_archive reward crediting the attacker (minting COLLECT XCHAIN, since
        // the archive reward push is NOT retired by the anchor-reward flag-day).
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let attacker = bus.nodes[1];        // a real oracle_publish member, but no observed archive election for seq 7
        let txid = 'dogetx_forged', snap = 100;
        bus.anchorVersions.set(txid, 1);      // a real v1 archive head, so ONLY the observed-leader gate decides
        let fMatches = [matchRow('m1', 'finalized')];
        let env = () => ({ data: {
            batch_seq: 7, txid: txid, snapshot_block: snap, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: attacker.pubkey, sig: attacker.identity.sign(follower.pub.finalizedCanonical(7, txid, fMatches.length))
        }});

        await follower.pub.handleFinalized(env());
        let m1 = follower.db.matches.find(m => m.match_id === 'm1');
        expect(m1.archived_status, 'row NOT archived by the forge').to.not.equal('finalized');
        expect(m1.batch_seq, 'no bogus batch_seq stamped').to.equal(null);
        expect(follower.rewards.some(r => r.type === 'anchor_archive'), 'no forged archive reward').to.equal(false);

        // The SAME envelope IS honored once the follower has observed that member's
        // election (with the batch's checkpoint identity) for the batch, proving the
        // gate (not a malformed envelope) rejected it.
        follower.pub.recordObservedArchiveLeader(7, attacker.pubkey, CP_ROW);
        await follower.pub.handleFinalized(env());
        expect(follower.db.matches.find(m => m.match_id === 'm1').archived_status,
            'observed leader IS honored').to.equal('finalized');
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'observed leader mirrors the reward').to.equal(true);
    });
}

// A FINALIZED cannot suppress rows the co-signed archive never carried.
function registerSuppressionCase() {
    it('a FINALIZED cannot suppress rows the co-signed archive never carried', async function () {
        // XANC-FINALIZED-MEMBER-1: the XANCFIN canonical commits to (batch_seq, txid,
        // match COUNT) and never to WHICH rows, and the content re-verification only asks
        // that each announced row exist locally at the announced status. An elected
        // leader that archives one row and announces two real ones therefore gets
        // archived_status = status stamped on both, and the pending selector
        // (`batch_seq IS NULL OR archived_status <> status`) skips a TERMINAL row
        // forever: the unarchived row is suppressed on every follower and unreachable to
        // full-parse recovery.
        // Count-path mesh (mainnet record below the 961000 SWQ activation), the same
        // shape the N=4 back-fill-propagates round above uses.
        let bus = buildMesh(4, { btcBlock: 101, network: 'mainnet' });
        let leader = archiveLeader(bus);
        await startAll(bus);
        await flushAll(bus);                                 // honest round: m1 archived fleet-wide
        await waitUntil(() => bus.nodes.every(nd => nd.db.matches[0].archived_status === 'finalized'),
            { label: 'the honest archive back-fill to reach every hub' });

        let followers = bus.nodes.filter(nd => nd !== leader);
        let gated = followers[0], abstaining = followers[1];
        let seq  = leader.db.matches[0].batch_seq;
        let txid = leader.db.matches[0].anchor_txid;
        expect(seq,  'the honest round stamped a batch seq').to.not.equal(null);
        expect(txid, 'the honest round stamped an archive txid').to.be.a('string');

        // HONEST CONTROL: the round's real SIGN_REQ + FINALIZED stamped the row the
        // archive DOES carry, on the gated follower, through the path under test.
        expect(gated.db.matches[0].match_id).to.equal('m1');
        expect(gated.db.matches[0].archived_status, 'the archived row IS stamped').to.equal('finalized');

        // m2 is settled on both followers and rode no archive.
        for (let nd of [gated, abstaining]) nd.db.matches.push(matchRow('m2'));

        // The leader announces m1 AND m2 under the batch it really published: real rows,
        // true statuses, a real on-chain v1 head, signed over its own list.
        let announced = [{ match_id: 'm1', status: 'finalized' }, { match_id: 'm2', status: 'finalized' }];
        let forged = () => ({ data: {
            batch_seq: seq, txid: txid, snapshot_block: 100, matches: announced, calls: [], rewards: [],
            sig_pubkey: leader.pubkey,
            sig: leader.identity.sign(gated.pub.finalizedCanonical(seq, txid, announced.length))
        }});

        await gated.pub.handleFinalized(forged());
        let m2 = gated.db.matches.find(m => m.match_id === 'm2');
        expect(m2.archived_status, 'a row outside the co-signed archive is NOT suppressed').to.equal(null);
        expect(m2.batch_seq, 'and carries no batch seq').to.equal(null);

        // CONTROL: the SAME envelope on a hub holding no archive body for this (batch,
        // proposer) still back-fills, so the envelope is valid all the way down and the
        // membership record is the only thing that stopped it above.
        abstaining.pub._observedArchiveContents.clear();
        await abstaining.pub.handleFinalized(forged());
        expect(abstaining.db.matches.find(m => m.match_id === 'm2').archived_status,
            'a hub holding no co-signed body abstains and still back-fills').to.equal('finalized');
    });
}

// The mirror needs an on-chain checkpoint and reads the CHECKPOINT network.
function registerMirrorGateCases() {
    it('a FINALIZED for a batch whose checkpoint was NEVER anchored on-chain mirrors NO archive reward', async function () {
        // XANC-REWARD-THEFT-1 (archive half, LIVE): an elected-yet-Byzantine leader
        // that announces a FINALIZED for an archive it never published on DOGE must
        // earn nothing. The back-fill (local bookkeeping) still applies; only the
        // COLLECT-spendable anchor_archive reward mirror is gated on the batch's
        // checkpoint being on-chain at depth.
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        follower.pub.recordObservedArchiveLeader(9, leader.pubkey, CP_ROW);        // observed + checkpoint identity stashed
        follower.pub.indexerCall = async () => ({ exists: false, confirmations: 0 });  // the checkpoint was never anchored
        let fMatches = [matchRow('m1', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 9, txid: 'dogetx_phantom', snapshot_block: 100, matches: fMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(9, 'dogetx_phantom', fMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'phantom archive earns no COLLECT-spendable reward').to.equal(false);
        expect(follower.db.matches.find(m => m.match_id === 'm1').batch_seq,
            'back-fill still applies (rows re-archive on a fresh seq if the checkpoint later confirms)').to.equal(9);
    });

    it('archive mirror gates on the CHECKPOINT network, not this.network, so an unscoped hub retires the push at/above the flag-day (#2359)', async function () {
        // Archive leg: on an unscoped hub (this.network===''),
        // ARCHIVE_REWARD_ACTIVATION[''] is undefined so isArchiveRewardActive('') is
        // false and the OLD code failed to retire the mirror even for a checkpoint
        // whose OWN network is at/above the archive flag-day, push-mirroring a reward
        // the indexer independently derives from the v1 tail (a COLLECT-spendable double-credit).
        // The fix reads the checkpoint's network from the stashed identity, so the
        // mirror correctly retires. Here the checkpoint is regtest AT the flag-day
        // while the hub is unscoped.
        arMod.ARCHIVE_REWARD_ACTIVATION.regtest = 0;             // regtest checkpoint IS at/above its archive flag-day
        let bus = buildMesh(2);
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        expect(follower.pub.network).to.equal('');              // unscoped hub: the drift precondition
        bus.anchorVersions.set('dogetx_scoped', 1);             // real v1 head, so the flag-day gate is what decides
        // Observe the leader AND stash the batch's checkpoint identity (regtest), the
        // same way handleSignReq would. The checkpoint verifies on-chain via the
        // default honest oracle, so the ONLY thing keeping the mirror from firing is
        // the corrected flag-day gate reading the checkpoint's network.
        follower.pub.recordObservedArchiveLeader(3, leader.pubkey, CP_ROW);
        let cMatches = [matchRow('m1', 'finalized')];
        await follower.pub.handleFinalized({ data: {
            batch_seq: 3, txid: 'dogetx_scoped', snapshot_block: 100, matches: cMatches, calls: [], rewards: [],
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(follower.pub.finalizedCanonical(3, 'dogetx_scoped', cMatches.length))
        }});
        expect(follower.rewards.some(r => r.type === 'anchor_archive'),
            'unscoped hub retires the mirror for a checkpoint at/above its OWN archive flag-day').to.equal(false);
    });
}
