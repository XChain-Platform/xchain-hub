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
// StateAnchorPublisher: the anchor_reward_attestations row waits for a MINED
// anchor. deferRewardAttestation queues at broadcast time and the drain writes
// only once this hub's own DOGE view proves the anchor buried at the bound txid
// and version.

const { expect }            = require('chai');
const sinon                 = require('sinon');
const StateAnchorPublisher  = require('../../../../../src/anchor/publisher');
const arMod                 = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const { DB_METHODS }        = require('../../../../helpers/mockHub.js');
const { CP_ROW }            = require('../../../../helpers/anchor_mesh.js');

const TXID = 'ab'.repeat(32);
const ATTEST = [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }];

// A publisher whose DB serves CP_ROW for the checkpoint re-SELECT and records every
// write, with a wired (stubbable) DOGE indexer so _verifyAnchorOnChain can run.
function makeRewardPub() {
    const queries = [];
    const broadcast = [];
    const db = { ...DB_METHODS,
        async doQuery(sql, params) {
            queries.push({ sql, params });
            if (sql.indexOf('SELECT * FROM state_checkpoints') === 0) return [Object.assign({}, CP_ROW)];
            if (sql.indexOf('SELECT') === 0) return [{ id: 1, publisher: params[5] }];
            return { affectedRows: 1 };
        }
    };
    const hub = { db, getIdentity: () => null, hubDbBroadcaster: { broadcastRow: (ev) => broadcast.push(ev) } };
    const pub = new StateAnchorPublisher(hub);
    pub.indexers.DOGE = { url: 'http://doge.indexer.invalid', key: '' };
    pub.dogeConfirmations = 60;
    return { pub, queries, broadcast };
}

function entry(extra) {
    return Object.assign({
        chain: CP_ROW.chain, network: CP_ROW.network,
        blockIndex: CP_ROW.block_index, checkpointSeq: CP_ROW.checkpoint_seq,
        txid: TXID, anchorVersion: 0,
        rewardType: 'anchor_bundle', roundReference: CP_ROW.snapshot_block,
        snapshotBlock: CP_ROW.snapshot_block,
        publisher: 'ab'.repeat(32), attestSigs: ATTEST
    }, extra || {});
}

const onChain = (over) => Object.assign({
    exists: true, checkpoint_anchored: true, status: 'valid', version: 0,
    confirmations: 60, txid: TXID,
    block_hash: CP_ROW.block_hash, ledger_hash: CP_ROW.ledger_hash,
    actions_hash: CP_ROW.actions_hash, contract_hash: CP_ROW.contract_hash,
    // A v0 bundle is root-bearing, so verifyAnchorOnChain byte-matches the roots too.
    state_root: CP_ROW.state_root, block_merkle_root: CP_ROW.block_merkle_root
}, over || {});

const inserts = (queries) => queries.filter(q => q.sql.indexOf('INSERT IGNORE INTO anchor_reward_attestations') === 0);

// ── The attestation row waits for a MINED anchor, not a broadcast one ────
// broadcastWithRetry returns on DOGE mempool acceptance, so writing the append-only,
// never-retracted mirror row there minted a permanent COLLECT-spendable reward for an
// anchor that could still be evicted or reorged away. Both producer sites now queue.
describe('StateAnchorPublisher reward attestation confirm-then-write (#4456)', function () {
    afterEach(() => sinon.restore());

    registerQueueGateCases();
    registerConfirmationCases();
    registerRejectionCases();
    registerBoundsCases();
});

// Below the gate nothing queues; above it the publish path queues and a buried anchor writes.
function registerQueueGateCases() {
    it('below the derive gate it queues nothing (the table has no rows at all)', function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
        const { pub } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });

    it('at/above the gate the publish path QUEUES instead of writing (mempool txid)', function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        expect(pub._deferredRewardAttest.size, 'entry queued').to.equal(1);
        expect(inserts(queries).length, 'nothing written at broadcast time').to.equal(0);
    });

    it('writes the row once the anchor is buried at the bound txid AND version', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries, broadcast } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        pub.indexerCall = async () => onChain();
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'confirmed anchor writes the attestation').to.equal(1);
        expect(broadcast.length, 'and streams it to this hub\'s indexer subscribers').to.equal(1);
        expect(pub._deferredRewardAttest.size, 'entry cleared').to.equal(0);
    });
}

// Shallow, absent, unbound or wrong-version anchors do not write.
function registerConfirmationCases() {
    it('does NOT write while the anchor is still shallow (the mempool/reorg window)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        pub.indexerCall = async () => onChain({ confirmations: 3 });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'no reward for an unburied anchor').to.equal(0);
        expect(pub._deferredRewardAttest.size, 'entry retained for retry').to.equal(1);
    });

    it('does NOT write when the anchor is absent, i.e. the tx was evicted and never mined', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        pub.indexerCall = async () => ({ exists: false, checkpoint_anchored: false, confirmations: 0 });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'evicted anchor mints nothing').to.equal(0);
    });

    it('does NOT write when a DIFFERENT anchor confirmed for this checkpoint (txid unbound)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        pub.indexerCall = async () => onChain({ txid: 'cc'.repeat(32) });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length).to.equal(0);
    });

    it('drops on a decided content rejection (a v1 archive head landed, not the attested v0 bundle)', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        pub.indexerCall = async () => onChain({ version: 1 });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'an archive head cannot prove a bundle reward').to.equal(0);
        expect(pub._deferredRewardAttest.size, 'terminal verdict clears the entry').to.equal(0);
    });
}

// rejected:status survives to retry; the TTL expires a never-confirming entry.
function registerRejectionCases() {
    it('retains the entry on rejected:status and still writes once it verifies', async function () {
        // A shallow txid's decoded status can be a reorg-order artifact (e.g. the
        // indexer's CHECKPOINT_SEQ replay guard firing against a competing anchor that
        // has not yet settled), so 'rejected:status' must not be treated as a permanent
        // forgery verdict the way 'rejected:mismatch'/'rejected:version' are: it has to
        // survive to retry, exactly like 'rejected:txid' already does.
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        pub.indexerCall = async () => onChain({ status: 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)' });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'no reward while the status verdict stands').to.equal(0);
        expect(pub._deferredRewardAttest.size, 'entry survives a rejected:status verdict').to.equal(1);

        // The chain resettles: the same txid now decodes valid and is buried deep enough.
        pub.indexerCall = async () => onChain();
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'the attestation is written once it verifies').to.equal(1);
        expect(pub._deferredRewardAttest.size, 'entry cleared on verification').to.equal(0);
    });

    it('expires the entry after the TTL rather than writing on a never-confirming anchor', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.deferRewardAttestation(entry());
        pub._deferredRewardAttest.get([...pub._deferredRewardAttest.keys()][0]).at =
            Date.now() - (pub.announceRetryTtlMs + 1);
        pub.indexerCall = async () => onChain();
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'an expired entry must not write').to.equal(0);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });
}

// The archive leg binds version 1, and the queue is bounded.
function registerBoundsCases() {
    it('binds version 1 for the archive leg, so a v0 bundle head derives nothing', async function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        const archive = () => entry({ anchorVersion: 1, rewardType: 'anchor_archive', roundReference: 42 });
        pub.deferRewardAttestation(archive());
        pub.indexerCall = async () => onChain({ version: 0 });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'a v0 checkpoint bundle cannot prove an archive reward').to.equal(0);
        pub.deferRewardAttestation(archive());
        pub.indexerCall = async () => onChain({ version: 1 });
        await pub.drainDeferredRewardAttest();
        expect(inserts(queries).length, 'the v1 archive head does').to.equal(1);
    });

    it('is bounded: a flood evicts the OLDEST entry and never writes one', function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(true);
        const { pub, queries } = makeRewardPub();
        pub.announceQueueMax = 3;
        for (let i = 0; i < 6; i++)
            pub.deferRewardAttestation(entry({ roundReference: i, txid: (i + 10).toString(16).repeat(32) }));
        expect(pub._deferredRewardAttest.size).to.equal(3);
        expect(inserts(queries).length).to.equal(0);
    });
}
