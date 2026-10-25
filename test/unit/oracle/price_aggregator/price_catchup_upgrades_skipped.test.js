'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub_schema_version.js');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const { peerManager } = require('../../peers/hub_db/helpers/peer_catchup_harness.js');

const CREATED_AT = '2026-01-02 03:04:05';
const PEER_CREATED_AT = '2026-02-03 04:05:06';

function skippedRow() {
    return {
        round_number: 17,
        coin_pair: 'BTC/USD',
        price: null,
        reference_block: 800000,
        reference_chain: 'BTC',
        block_timestamp: 1700000017,
        validator_count: 0,
        consensus_round: 1,
        consensus_proof: '[]',
        status: 'skipped',
        created_at: CREATED_AT,
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: null
    };
}

function peerFinalizedRow() {
    return Object.assign(skippedRow(), {
        id: 91,
        price: '50000',
        reference_block: 800017,
        validator_count: 3,
        consensus_proof: '[{"pubkey":"validator","sig":"proof"}]',
        status: 'finalized',
        created_at: PEER_CREATED_AT
    });
}

function statefulDb(initial) {
    let stored = Object.assign({}, initial);
    return {
        findPriceSnapshotsForRound: sinon.stub().callsFake(async () => [Object.assign({}, stored)]),
        setFinalizedPriceSnapshotRound: sinon.stub().callsFake(async (
            round, prices, referenceBlock, blockTimestamp, validatorCount, proof, admitBlocks
        ) => {
            stored = Object.assign({}, stored, {
                round_number: round,
                coin_pair: prices[0].coinPair,
                price: prices[0].price,
                reference_block: referenceBlock,
                block_timestamp: blockTimestamp,
                validator_count: validatorCount,
                consensus_proof: proof,
                status: 'finalized'
            }, admitBlocks);
        }),
        stored: () => Object.assign({}, stored)
    };
}

function catchupFor(db, peerRow, verifier) {
    const fetchPage = sinon.stub().resolves({
        table: 'price_snapshots', schema_version: HUB_SCHEMA_VERSION, rows: [peerRow]
    });
    return new HubDbPeerCatchup({
        db,
        peerManager: peerManager(true),
        tables: ['price_snapshots'],
        getVerifier: () => verifier,
        fetchPage,
        pageSize: 2,
        logger: { warn: sinon.stub(), error: sinon.stub() }
    });
}

describe('price catch-up upgrades skipped placeholders', function () {
    afterEach(function () { sinon.restore(); });

    it('replaces a skipped row only after the peer-finalized row is verified', async function () {
        const db = statefulDb(skippedRow());
        const peerRow = peerFinalizedRow();
        const verifier = sinon.stub().resolves({ ok: true });

        await catchupFor(db, peerRow, verifier).run();

        expect(verifier.calledOnce).to.equal(true);
        expect(db.setFinalizedPriceSnapshotRound.calledOnce).to.equal(true);
        expect(db.stored()).to.include({
            status: 'finalized',
            price: peerRow.price,
            consensus_proof: peerRow.consensus_proof,
            reference_block: peerRow.reference_block,
            created_at: CREATED_AT
        });
    });

    it('leaves an already finalized row untouched', async function () {
        const local = Object.assign(skippedRow(), {
            price: '49000', consensus_proof: '["local-proof"]', status: 'finalized'
        });
        const db = statefulDb(local);
        const verifier = sinon.stub().resolves({ ok: true });

        await catchupFor(db, peerFinalizedRow(), verifier).run();

        expect(verifier.called).to.equal(false);
        expect(db.setFinalizedPriceSnapshotRound.called).to.equal(false);
        expect(db.stored()).to.deep.equal(local);
    });

    it('leaves the skipped placeholder when verification refuses the peer row', async function () {
        const local = skippedRow();
        const db = statefulDb(local);
        const verifier = sinon.stub().resolves({ ok: false, reason: 'bad proof' });

        await catchupFor(db, peerFinalizedRow(), verifier).run();

        expect(verifier.calledOnce).to.equal(true);
        expect(db.setFinalizedPriceSnapshotRound.called).to.equal(false);
        expect(db.stored()).to.deep.equal(local);
    });
});
