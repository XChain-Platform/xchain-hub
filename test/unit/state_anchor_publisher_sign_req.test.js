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
// StateAnchorPublisher: the archive SIGN_REQ path: the observed-leader
// binding, the stale-tip bail, _resolveCapabilitySet under SWQ, and the
// follower refusals for a non-member, an unsigned request and an unresolved
// election set.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const ValidatorIdentity     = require('../../src/validators/identity');
const { CP_ROW, buildMesh, archiveLeader, registerMeshHooks } = require('../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerLeaderBindingCases();
    registerCapabilitySetCases();
    registerNonMemberFollowerCase();
    registerUnsignedRequestCase();
    registerUnresolvedSetCase();
});

// handleSignReq binds the observed leader and bails on a stale tip first.
function registerLeaderBindingCases() {
    it('handleSignReq binds the elected archive leader locally (the FINALIZED gate source)', async function () {
        let bus = buildMesh(3);
        let batchSeq = 0;
        let leader   = archiveLeader(bus, batchSeq);
        let follower = bus.nodes.find(nd => nd !== leader);
        let cp = Object.assign({}, CP_ROW);
        // A SIGN_REQ that passes the election/rank check (valid sender + election_block)
        // but carries no usable archive (empty archive_b64) still binds the leader,
        // because the bind happens before the co-sign eligibility + archive checks.
        let canonical = follower.pub.archiveCanonical(cp, batchSeq, 1, 'deadbeef', 1);
        await follower.pub.handleSignReq({ data: {
            checkpoint: cp, election_block: 100, batch_seq: batchSeq,
            match_count: 1, batch_crc32: 'deadbeef', total_chunks: 1, archive_b64: '',
            sig_pubkey: leader.pubkey, sig: leader.identity.sign(canonical)
        }});
        expect(follower.pub.isObservedArchiveLeader(batchSeq, leader.pubkey),
            'follower bound the elected leader for the batch').to.equal(true);
        let notLeader = bus.nodes.find(nd => nd !== leader && nd !== follower);
        expect(follower.pub.isObservedArchiveLeader(batchSeq, notLeader.pubkey),
            'a non-elected member is not bound').to.equal(false);
    });

    it('handleSignReq bails on a stale tip (election_block far from our BTC view) before any election work', async function () {
        let bus = buildMesh(2, { btcBlock: 1000 });    // follower's BTC tip = 1000
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        let tol = follower.pub.electionToleranceBlocks;            // default 36

        // Spy on the first post-guard step: reached only if the stale-tip guard passes.
        let lookups = [];
        follower.pub._getActiveOraclePublishPubkeys = async (blk) => { lookups.push(blk); return []; };

        let mkReq = (electionBlock) => ({ data: {
            checkpoint: Object.assign({}, CP_ROW), election_block: electionBlock, batch_seq: 0,
            match_count: 1, batch_crc32: '0', total_chunks: 1, sig_pubkey: leader.pubkey, sig: 'deadbeef'
        }});

        // election_block well outside tolerance → bail at the stale-tip guard, no election lookup.
        await follower.pub.handleSignReq(mkReq(1000 + tol + 50));
        expect(lookups.length, 'no election lookup when the tip is stale').to.equal(0);

        // election_block within tolerance → proceeds past the guard into the election lookup
        // (which returns [] here, so the rest of the handler short-circuits harmlessly).
        await follower.pub.handleSignReq(mkReq(1000 + Math.floor(tol / 2)));
        expect(lookups.length, 'election lookup runs once the tip is within tolerance').to.be.greaterThan(0);
    });
}

// _resolveCapabilitySet takes the WEIGHTED snapshot once SWQ is active.
function registerCapabilitySetCases() {
    it('_resolveCapabilitySet uses the WEIGHTED snapshot (weight→amount, source kept) once SWQ is active', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        let weighted = false, plain = false;
        nd.pub.capSnapshot = {
            getWeightSnapshot: async () => { weighted = true; return { validators: [{ pubkey: 'PKA', weight: '7', source: 'srcA' }] }; },
            getSnapshot:       async () => { plain = true;    return { validators: [{ pubkey: 'PKA', amount: '1' }] }; }
        };

        // SWQ activates at block >= 0 on regtest → weighted path, source-keyed.
        nd.pub.network = 'regtest';
        let set = await nd.pub._resolveCapabilitySet('oracle_publish', 100);
        expect(weighted, 'weighted snapshot used').to.be.true;
        expect(plain, 'plain snapshot not used').to.be.false;
        expect(set).to.deep.equal([{ pubkey: 'pka', amount: '7', source: 'srcA' }]);

        // mainnet activation is far in the future (999999999) → SWQ off → plain path, source ''.
        weighted = false; plain = false;
        nd.pub.network = 'mainnet';
        let set2 = await nd.pub._resolveCapabilitySet('oracle_publish', 100);
        expect(plain, 'plain snapshot used when SWQ off').to.be.true;
        expect(weighted, 'weighted snapshot not used when SWQ off').to.be.false;
        expect(set2).to.deep.equal([{ pubkey: 'pka', amount: '1', source: '' }]);
    });

    it('_resolveCapabilitySet carries the truncated flag from a weighted snapshot (XHUB-TRUNC-2)', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub.network = 'regtest';                          // SWQ active -> weighted path
        nd.pub.capSnapshot = {
            getWeightSnapshot: async () => ({ validators: [{ pubkey: 'PKA', weight: '7', source: 'srcA' }], truncated: true }),
            getSnapshot:       async () => ({ validators: [] })
        };
        let set = await nd.pub._resolveCapabilitySet('oracle_publish', 100);
        // Without the flag surviving the map, the archive quorum path would not fail closed.
        expect(set.truncated).to.equal(true);
    });
}

// A follower outside the snapshot_block signing set does not co-sign.
function registerNonMemberFollowerCase() {
    it('handleSignReq: a follower NOT in the snapshot_block signing set does not co-sign', async function () {
        let bus = buildMesh(2, { btcBlock: 500 });
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        let cp = Object.assign({}, CP_ROW);                       // snapshot_block = 100

        // Spy the first step AFTER the snapshot-set membership gate: the local
        // state_checkpoints re-SELECT. This once spied _archiveCanonical, but the
        // proposer-signature verify now runs BEFORE the membership gate (it is what
        // authenticates the observed-leader record against a spoofed d.sig_pubkey), so
        // building the canonical no longer proves the gate was reached.
        let selects = 0;
        let origQuery = follower.pub.db.doQuery.bind(follower.pub.db);
        follower.pub.db.doQuery = (sql, params) => {
            if (/state_checkpoints/i.test(String(sql))) selects++;
            return origQuery(sql, params);
        };

        // A GENUINE leader signature over the archive canonical: with the verify ahead
        // of the membership gate, a bogus one would stop BOTH cases before the gate and
        // the control below would prove nothing.
        let reqCanonical = leader.pub.archiveCanonical(cp, 0, 1, '0', 1);
        let mkReq = () => ({ data: {
            checkpoint: cp, election_block: 500, batch_seq: 0, match_count: 1, batch_crc32: '0',
            total_chunks: 1, sig_pubkey: leader.pubkey, sig: leader.identity.sign(reqCanonical)
        }});

        // The election set must RESOLVE for either case to reach the membership gate at
        // all (#4184 made an empty election set fail closed), so the leader is the sole
        // elected publisher at election_block and ranks 0 on the ladder. Only the
        // snapshot_block set differs between the two cases.
        // (1) EXCLUDED: snapshot_block set omits the follower → bail at the membership
        // gate, never reads its own checkpoint row and never co-signs.
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [leader.pubkey] : [leader.pubkey];
        await follower.pub.handleSignReq(mkReq());
        expect(selects, 'excluded follower stops before the local checkpoint read').to.equal(0);

        // (2) CONTROL - INCLUDED in the snapshot_block set → proceeds past the gate to the
        // local checkpoint read (then stops harmlessly on the absent archive body).
        // Proves the membership gate is what stops case (1).
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [leader.pubkey, follower.pubkey] : [leader.pubkey];
        await follower.pub.handleSignReq(mkReq());
        expect(selects, 'included follower reads its own checkpoint row').to.equal(1);
    });
}

// An UNSIGNED SIGN_REQ never records an observed archive leader.
function registerUnsignedRequestCase() {
    it('handleSignReq: an UNSIGNED SIGN_REQ never records an observed archive leader', async function () {
        // PeerManager authenticates the envelope RELAYER; d.sig_pubkey is a separate
        // application-level field, so any member can name another member there. The rank
        // ladder is no gate either: it is keyed on the WIRE checkpoint, so the sender
        // picks its own rank. Only the proposer's signature over the archive canonical
        // proves it holds the key it names, so nothing may be bound to that name before
        // the signature verifies: a poisoned _observedArchiveCheckpoints entry (first
        // observation wins) starves the genuine round's co-sign and makes the FINALIZED
        // back-fill abstain, and a flood past the cap evicts the in-flight entries.
        let bus = buildMesh(2, { btcBlock: 500 });
        let follower = bus.nodes[0];
        let leader   = bus.nodes[1];
        let cp = Object.assign({}, CP_ROW);
        const SEQ = 42;
        follower.pub._getActiveOraclePublishPubkeys = async () => [leader.pubkey];   // leader ranks 0

        let mkReq = (sig) => ({ data: {
            checkpoint: cp, election_block: 500, batch_seq: SEQ, match_count: 1, batch_crc32: '0',
            total_chunks: 1, sig_pubkey: leader.pubkey, sig: sig
        }});

        // Spoof: the leader's pubkey with a signature its key never produced.
        await follower.pub.handleSignReq(mkReq('deadbeef'));
        expect(follower.pub.isObservedArchiveLeader(SEQ, leader.pubkey),
               'an unsigned SIGN_REQ must not bind the named leader').to.equal(false);
        expect(follower.pub.observedArchiveCheckpoint(SEQ),
               'nor stash a checkpoint identity for the batch').to.equal(null);

        // CONTROL: the same REQ carrying the leader's real signature still records, so
        // the guard is the signature and not some other gate.
        let canonical = leader.pub.archiveCanonical(cp, SEQ, 1, '0', 1);
        await follower.pub.handleSignReq(mkReq(leader.identity.sign(canonical)));
        expect(follower.pub.isObservedArchiveLeader(SEQ, leader.pubkey)).to.equal(true);
        expect(follower.pub.observedArchiveCheckpoint(SEQ).checkpoint_seq).to.equal(Number(cp.checkpoint_seq));
    });
}

// An UNRESOLVED election set fails closed.
function registerUnresolvedSetCase() {
    it('handleSignReq: an UNRESOLVED election set fails closed instead of skipping the ladder (#4184)', async function () {
        // The leader path already defers on an empty oracle_publish election set; the
        // follower fell through it, so during an unresolved window a NON-MEMBER could
        // solicit co-signatures from the historical wrapper set and assemble a duplicate
        // v1 under a batch_seq of its own choosing (honest content, doubled DOGE, two
        // archives able to claim one seq).
        let bus = buildMesh(2, { btcBlock: 500 });
        let follower = bus.nodes[0];
        let outsider = new ValidatorIdentity('99'.repeat(32)).getPubkeyHex().toLowerCase();
        let cp = Object.assign({}, CP_ROW);                       // snapshot_block = 100

        let canonCalls = 0;
        let origCanon = follower.pub.archiveCanonical.bind(follower.pub);
        follower.pub.archiveCanonical = (...a) => { canonCalls++; return origCanon(...a); };

        let mkReq = () => ({ data: {
            checkpoint: cp, election_block: 500, batch_seq: 0, match_count: 1, batch_crc32: '0',
            total_chunks: 1, sig_pubkey: outsider, sig: 'deadbeef'
        }});

        // (1) Election set UNRESOLVED while this follower IS in the snapshot_block signing
        // set - the exact combination the old fall-through admitted.
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [follower.pubkey] : [];
        await follower.pub.handleSignReq(mkReq());
        expect(canonCalls, 'an unresolved election set may not reach the co-sign path').to.equal(0);

        // (2) CONTROL - the SAME request with a resolved election set naming the sender
        // (rank 0) proceeds to the canonical, proving the empty-set gate stopped (1).
        follower.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (Number(blk) === Number(cp.snapshot_block)) ? [follower.pubkey] : [outsider];
        await follower.pub.handleSignReq(mkReq());
        expect(canonCalls, 'a resolved election set naming the sender still co-signs').to.equal(1);
    });
}
