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
// StateAnchorPublisher: XANC_BUNDLE_DONE on the receiver: the checkpoint_seq
// keyed stamp, the elected-publisher gate (including a size-1 elected set),
// and the on-chain ANCHOR verification that binds the announced txid, depth,
// decoded status, payload hashes and light-client roots.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const { CP_ROW, buildMesh, v0Order, mkBundleDone, registerMeshHooks } = require('../../../helpers/anchor_mesh.js');

// Build a signed BUNDLE_DONE from the rank-0 (always unlocked) elected publisher
// for the mesh checkpoint, returning {receiver, d}.
function electedBundleDone(bus, txid) {
    let order = v0Order(bus, CP_ROW);
    let publisher = order[0], receiver = order[1];
    return { publisher, receiver, d: mkBundleDone(bus, publisher, txid) };
}
let matching = {
    block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
    actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash,
    // A v0 BUNDLE section is root-bearing by construction, and verifyAnchorOnChain
    // byte-matches the two light-client roots on exactly that version, so an honest
    // indexer answer carries them.
    state_root: CP_ROW.state_root, block_merkle_root: CP_ROW.block_merkle_root
};

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerBundleDoneStampCase();
    registerElectionGateCases();
    registerOnChainVerification();
    registerSizeOneElectedSet();
});

// XANC-V0DONE partial: the peer back-fill UPDATE now keys on checkpoint_seq, exactly like
// the publisher's own stamp, so one V0_DONE cannot mark a DIFFERENT/other seq row at the
// height. (The full suppression fix - verifying the announced txid on-chain - is an open item.)
function registerBundleDoneStampCase() {
    it('handleBundleDone: stamps anchor_txid keyed on checkpoint_seq', async function () {
        let bus = buildMesh(1);
        let nd = bus.nodes[0];
        nd.pub._getActiveOraclePublishPubkeys = async () => [nd.pubkey];
        nd.pub.recordReward = () => {};                     // isolate the UPDATE assertion
        nd.pub.verifyAnchorOnChain = async () => 'verified';  // isolate from the on-chain gate (covered separately)
        let calls = [];
        nd.pub.db.doQuery = async (sql, params) => {
            calls.push({ sql, params });
            // The exact-identity SELECT feeds both the election vet and the on-chain
            // gate, so it must carry the checkpoint hashes + snapshot_block.
            if (sql.startsWith('SELECT * FROM state_checkpoints')) return [Object.assign({}, CP_ROW, { snapshot_block: 100 })];
            if (sql.startsWith('SELECT snapshot_block FROM state_checkpoints')) return [{ snapshot_block: 100 }];
            return [];
        };
        let d = mkBundleDone(bus, nd, 'aa'.repeat(32));

        await nd.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: nd.pubkey, data: d });

        let upd = calls.find(c => c.sql.startsWith('UPDATE state_checkpoints SET anchor_txid'));
        expect(upd, 'UPDATE issued').to.exist;
        expect(upd.sql).to.match(/checkpoint_seq = \?/);
        expect(upd.sql).to.match(/anchor_txid IS NULL/);
        expect(upd.params[4]).to.equal(7);
    });
}

// XANC-V0DONE-SUPPRESS-1 / XANC-REWARD-THEFT-1: a V0_DONE from an oracle_publish member
// that is NOT the rank-unlocked elected v0 publisher for the referenced checkpoint must be
// rejected - otherwise a single Byzantine member forges a txid, stamps anchor_txid (the
// `IS NULL` selector then skips the row fleet-wide, suppressing the real anchor) and mirrors
// itself the reward. The gate re-runs the publisher's own election from the LOCAL
// checkpoint's snapshot_block (no signed-canonical change).
function registerElectionGateCases() {
    it('handleBundleDone: rejects a forged BUNDLE_DONE from a non-elected oracle_publish member', async function () {
        let bus = buildMesh(3);                     // default btcBlock=100 == snapshot_block => since=0, only rank 0 unlocked
        let order = v0Order(bus, CP_ROW);
        let attacker = order[2];                    // a member, but not the elected (rank-0) publisher
        let receiver = order[1];
        let d = mkBundleDone(bus, attacker, 'aa'.repeat(32));

        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: attacker.pubkey, data: d });

        expect(receiver.db.checkpoints[0].anchor_txid, 'forged BUNDLE_DONE must not stamp (suppression blocked)').to.equal(null);
        expect(receiver.rewards.length, 'forged BUNDLE_DONE must not mirror a reward (theft blocked)').to.equal(0);
    });

    it('handleBundleDone: accepts a BUNDLE_DONE from the rank-unlocked elected publisher', async function () {
        let bus = buildMesh(3);
        let order = v0Order(bus, CP_ROW);
        let publisher = order[0];                   // rank 0 is always unlocked
        let receiver  = order[1];
        let d = mkBundleDone(bus, publisher, 'bb'.repeat(32));

        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });

        expect(receiver.db.checkpoints[0].anchor_txid, 'elected publisher BUNDLE_DONE stamps').to.equal('bb'.repeat(32));
        // BELOW the anchor-reward flag-day (outer-suite pin) the hub rows are the
        // reward's only transport, so the mirror still fires (control for the
        // at/above-flag-day skip asserted in the attestation suite).
        expect(receiver.rewards.filter(r => r.type === 'anchor_bundle' && r.round === 100).length,
            'below flag-day the mirror records the reward').to.equal(1);
    });
}

// XANC-ELECTED-FORGE-1 / XANC-V0DONE-SUPPRESS-1 residual: the election gate
// proves the SENDER is an elected v0 publisher but not that the announced
// anchor was ever mined. _verifyAnchorOnChain asks OUR OWN DOGE indexer
// (getanchoraction) for the DECODED anchor at THIS checkpoint and only lets the
// stamp+reward through when it exists, is not decoded-invalid, is buried
// >= XCHAIN_CONFIRMATIONS_DOGE, and its payload hashes byte-match our copy.
function registerOnChainVerification() {
    describe('handleBundleDone on-chain ANCHOR verification', function () {
        registerConfirmedAnchorCases();
        registerTxidBindingCases();
        registerDepthAndStatusCases();
        registerPayloadMatchCases();
    });
}

// A confirmed anchor stamps and mirrors; an absent one abstains.
function registerConfirmedAnchorCases() {
    it('ACCEPTS when the DOGE indexer confirms the anchor at depth with matching hashes', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ab'.repeat(32));
        // Honest indexer: the announced txid is the tx the anchor landed in.
        receiver.pub._indexerCall = async (coin, method, params) => Object.assign(
            { exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
              confirmations: 60, txid: params.txid }, matching);
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'confirmed anchor stamps').to.equal('ab'.repeat(32));
        expect(receiver.rewards.filter(r => r.type === 'anchor_bundle').length, 'confirmed anchor mirrors reward').to.equal(1);
    });

    it('ABSTAINS (no stamp/reward) when the anchor is ABSENT on-chain (phantom txid)', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ac'.repeat(32));
        receiver.pub._indexerCall = async () => ({ exists: false, confirmations: 0 });
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'phantom anchor must not stamp (suppression blocked)').to.equal(null);
        expect(receiver.rewards.length, 'phantom anchor must not mirror a reward').to.equal(0);
    });
}

    // ── XANC-ELECTED-FORGE-1 (v0 half): the announced txid is now BOUND ──────
    // The election gate proves the sender is an elected publisher; it does NOT
    // prove the sender published THIS anchor. Before the txid binding, an elected
    // publisher could announce any txid for a checkpoint that happened to be
    // anchored, stamp it, and suppress the real anchor via `anchor_txid IS NULL`.
function registerTxidBindingCases() {
    it('REJECTS a fabricated txid for a checkpoint that IS anchored (elected-publisher forge)', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ff'.repeat(32));
        // Checkpoint is genuinely anchored, but by a DIFFERENT transaction: the
        // filtered lookup misses, and checkpoint_anchored marks it a positive forge.
        receiver.pub._indexerCall = async () => ({ exists: false, checkpoint_anchored: true, confirmations: 0 });
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'forged txid must not stamp').to.equal(null);
        expect(receiver.rewards.length, 'forged txid must not mirror a reward').to.equal(0);
    });

    it('REJECTS when the indexer returns an anchor whose txid differs from the announced one', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ab'.repeat(32));
        // An indexer that ignored the filter and returned the newest anchor instead.
        receiver.pub._indexerCall = async () => Object.assign(
            { exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
              confirmations: 60, txid: 'cd'.repeat(32) }, matching);
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'unbound anchor must not stamp').to.equal(null);
    });

    it('FAILS CLOSED against an indexer too old to return a txid (roll indexers first)', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ab'.repeat(32));
        // Pre-filter indexer: ignores the txid param, response carries no txid.
        receiver.pub._indexerCall = async () => Object.assign(
            { exists: true, status: 'valid', version: 0, confirmations: 60 }, matching);
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'unbindable anchor must not stamp').to.equal(null);
        expect(receiver.rewards.length, 'unbindable anchor must not mirror a reward').to.equal(0);
    });
}

// The txid filter reaches the indexer; shallow or decoded-invalid anchors abstain.
function registerDepthAndStatusCases() {
    it('passes the announced txid to the indexer as a filter', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ab'.repeat(32));
        let seen = null;
        receiver.pub._indexerCall = async (coin, method, params) => {
            seen = params;
            return Object.assign({ exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
                                   confirmations: 60, txid: params.txid }, matching);
        };
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(seen.txid, 'V0_DONE binds the announced txid').to.equal('ab'.repeat(32));
    });

    it('ABSTAINS when the anchor is SHALLOWER than XCHAIN_CONFIRMATIONS_DOGE', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ad'.repeat(32));
        receiver.pub._indexerCall = async () => Object.assign(
            { exists: true, status: 'valid', version: 0, confirmations: 59 }, matching);
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, '0..59-conf anchor must not stamp').to.equal(null);
        expect(receiver.rewards.length, 'shallow anchor must not mirror a reward').to.equal(0);
    });

    it('REJECTS when the DECODED anchor status is invalid', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ae'.repeat(32));
        receiver.pub._indexerCall = async () => Object.assign(
            { exists: true, status: 'invalid: ledger_hash mismatch', version: 0, confirmations: 60 }, matching);
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'decoded-invalid anchor must not stamp').to.equal(null);
        expect(receiver.rewards.length, 'decoded-invalid anchor must not mirror a reward').to.equal(0);
    });
}

// The light-client roots and payload hashes must byte-match; no indexer abstains.
function registerPayloadMatchCases() {
    // The four core hashes ride every checkpoint version, but the two light-client
    // ROOTS are compared only on the root-bearing wire, which the version restart
    // moved from v7 to v0. Nothing else in the suite drives that branch: every other
    // honest stub agrees on the roots, so pointing the gate at a version the hub can
    // no longer emit would leave a real forge undetected while every suite stayed
    // green. A v0 whose STATE_ROOT diverges is exactly that forge: the four core
    // hashes still match (the announcement wraps our checkpoint), and the rows would
    // be stamped fleet-wide against a bundle committing to a different SPV root.
    it('REJECTS a v0 whose light-client ROOTS diverge, though the core hashes match', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'ba'.repeat(32));
        receiver.pub._indexerCall = async (coin, method, params) => Object.assign(
            {}, matching,
            { exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
              confirmations: 60, txid: params.txid,
              state_root: '1f'.repeat(32) });                // diverges from CP_ROW.state_root
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'a root-mismatched v0 must not stamp').to.equal(null);
        expect(receiver.rewards.length, 'a root-mismatched v0 must not mirror a reward').to.equal(0);
    });

    it('REJECTS a v0 whose BLOCK_MERKLE root diverges (both roots are bound, not just the first)', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'bb'.repeat(32));
        receiver.pub._indexerCall = async (coin, method, params) => Object.assign(
            {}, matching,
            { exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
              confirmations: 60, txid: params.txid,
              block_merkle_root: '2f'.repeat(32) });
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'a merkle-root-mismatched v0 must not stamp').to.equal(null);
    });

    it('REJECTS when the on-chain payload hashes do NOT byte-match our checkpoint', async function () {
        let bus = buildMesh(3);
        let { publisher, receiver, d } = electedBundleDone(bus, 'af'.repeat(32));
        receiver.pub._indexerCall = async () => ({
            exists: true, status: 'valid', version: 0, confirmations: 60,
            block_hash: 'ff'.repeat(32),                         // diverges from CP_ROW.block_hash
            ledger_hash: CP_ROW.ledger_hash, actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash
        });
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(receiver.db.checkpoints[0].anchor_txid, 'hash-mismatched anchor must not stamp').to.equal(null);
        expect(receiver.rewards.length, 'hash-mismatched anchor must not mirror a reward').to.equal(0);
    });

    it('ABSTAINS (no stamp/reward) when no DOGE indexer is wired', async function () {
        let bus = buildMesh(3, { cfg: { DOGE_INDEXER_URL: '' } });   // hub opts out of on-chain verification
        let { publisher, receiver, d } = electedBundleDone(bus, 'ba'.repeat(32));
        let called = 0;
        receiver.pub._indexerCall = async () => { called++; return { exists: true, status: 'valid', confirmations: 60 }; };
        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: publisher.pubkey, data: d });
        expect(called, 'no-indexer short-circuits before any RPC').to.equal(0);
        expect(receiver.db.checkpoints[0].anchor_txid, 'unverifiable anchor must not stamp').to.equal(null);
        expect(receiver.rewards.length, 'unverifiable anchor must not mirror a reward').to.equal(0);
    });
}

// Finding 1205: the v0-publisher election rank/identity check now runs for a
// size-1 elected set too (the old `length > 1` guard skipped it, letting any
// CURRENT oracle_publish member impersonate the sole elected publisher and
// stamp/suppress the anchor + mirror the reward). Rejection is a silent
// return: anchor_txid stays null and no reward is mirrored.
function registerSizeOneElectedSet() {
    describe('handleBundleDone size-1 elected set (finding 1205)', function () {
        registerSizeOneCases();
    });
}

// The rank/identity check runs for a size-1 elected set too.
function registerSizeOneCases() {
    it('rejects a NON-elected current member when the elected set has exactly one member', async function () {
        let bus = buildMesh(2);
        let elected  = bus.nodes[0];             // the SOLE elected publisher (size-1 set)
        let attacker = bus.nodes[1];             // a current oracle_publish member, but not elected
        let receiver = bus.nodes[0];             // holds the checkpoint and processes the done
        // Current membership (null arg) admits BOTH nodes so the attacker clears the
        // membership gate; the snapshot_block election set is exactly [elected].
        receiver.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (blk == null ? bus.nodes.map(nd => nd.pubkey) : [elected.pubkey]);

        let d = mkBundleDone(bus, attacker, 'aa'.repeat(32));

        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: attacker.pubkey, data: d });

        expect(receiver.db.checkpoints[0].anchor_txid, 'non-elected member must not stamp (size-1 set)').to.equal(null);
        expect(receiver.rewards.length, 'non-elected member must not mirror a reward').to.equal(0);
    });

    it("accepts the sole elected publisher's request when the elected set has exactly one member", async function () {
        let bus = buildMesh(2);
        let elected  = bus.nodes[0];             // the SOLE elected publisher (rank 0, always unlocked)
        let receiver = bus.nodes[1];             // a peer that holds the checkpoint
        receiver.pub._getActiveOraclePublishPubkeys = async (blk) =>
            (blk == null ? bus.nodes.map(nd => nd.pubkey) : [elected.pubkey]);

        let d = mkBundleDone(bus, elected, 'bb'.repeat(32));

        await receiver.pub.handleBundleDone({ type: 'XANC_BUNDLE_DONE', sender: elected.pubkey, data: d });

        expect(receiver.db.checkpoints[0].anchor_txid, 'sole elected publisher BUNDLE_DONE stamps').to.equal('bb'.repeat(32));
        expect(receiver.rewards.filter(r => r.type === 'anchor_bundle').length,
            'below flag-day the mirror records the reward').to.equal(1);
    });
}
