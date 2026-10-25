'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const PeerManager = require('../../../../src/peers/manager.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub_schema_version.js');

const LOCAL_ADDR = 'ws://local.example:10002';
const REMOTE_ADDR = 'https://remote.example:10002';
const CREATED_AT = '2026-01-02 03:04:05';

function hub(addr) {
    const manager = new PeerManager({ P2P_VALIDATOR_ADDR: addr, REQUIRE_SIGNATURES: true }, null);
    const identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    manager.setIdentity(identity);
    return { manager, identity, pubkey: identity.getPubkeyHex().toLowerCase() };
}

function connectInbound(source, destination) {
    const ws = { _peerAddr: null, _remoteIp: '127.0.0.2', close: sinon.stub() };
    const envelope = source.manager.buildEnvelope('HEARTBEAT', source.manager.heartbeatData('test'));
    destination.manager.handleInbound(ws, JSON.stringify(envelope), null);
    return ws;
}

function skippedRow() {
    return {
        round_number: 17, coin_pair: 'BTC/USD', price: null, reference_block: 800000,
        reference_chain: 'BTC', block_timestamp: 1700000017, validator_count: 0,
        consensus_round: 1, consensus_proof: '[]', status: 'skipped', created_at: CREATED_AT,
        admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null
    };
}

function finalizedRow() {
    return Object.assign(skippedRow(), {
        id: 91, price: '50000', reference_block: 800017, validator_count: 3,
        consensus_proof: '[{"pubkey":"validator","sig":"proof"}]', status: 'finalized'
    });
}

function upgradingDb() {
    let stored = skippedRow();
    return {
        findPriceSnapshotsForRound: sinon.stub().callsFake(async () => [{ ...stored }]),
        setFinalizedPriceSnapshotRound: sinon.stub().callsFake(async (
            round, prices, referenceBlock, blockTimestamp, validatorCount, proof
        ) => {
            stored = Object.assign({}, stored, {
                round_number: round, coin_pair: prices[0].coinPair, price: prices[0].price,
                reference_block: referenceBlock, block_timestamp: blockTimestamp,
                validator_count: validatorCount, consensus_proof: proof, status: 'finalized'
            });
        }),
        stored: () => ({ ...stored })
    };
}

describe('hub DB peer catch-up from inbound-only peers', function () {
    afterEach(function () { sinon.restore(); });

    it('derives the feed from the verified announced address and upgrades a skipped row', async function () {
        const local = hub(LOCAL_ADDR);
        const remote = hub(REMOTE_ADDR);
        const signerSet = new Set([local.pubkey, remote.pubkey]);
        local.manager.setValidatorPubkeys(new Map());
        remote.manager.setValidatorPubkeys(new Map());
        local.manager.setEffectiveSignerSet(signerSet);
        remote.manager.setEffectiveSignerSet(signerSet);

        connectInbound(remote, local);
        connectInbound(local, remote);

        expect(local.manager.peers.get(REMOTE_ADDR)).to.include({ inbound: true, validatorAddr: REMOTE_ADDR });
        expect(remote.manager.peers.get(LOCAL_ADDR)).to.include({ inbound: true, validatorAddr: LOCAL_ADDR });
        expect(HubDbPeerCatchup.connectedSignerPeers(local.manager)).to.deep.equal([
            { addr: REMOTE_ADDR, identity: REMOTE_ADDR, feedUrl: REMOTE_ADDR }
        ]);
        expect(HubDbPeerCatchup.connectedSignerPeers(remote.manager)).to.deep.equal([
            { addr: LOCAL_ADDR, identity: LOCAL_ADDR, feedUrl: LOCAL_ADDR }
        ]);
        expect(HubDbPeerCatchup.peerFeedUrl(REMOTE_ADDR, 'price_snapshots', 0, 10).href)
            .to.equal('https://remote.example:10002/hub-db/snapshot/price_snapshots?since_id=0&limit=10');

        const db = upgradingDb();
        const verifier = sinon.stub().resolves({ ok: true });
        const fetchPage = sinon.stub().resolves({
            table: 'price_snapshots', schema_version: HUB_SCHEMA_VERSION, rows: [finalizedRow()]
        });
        const catchup = new HubDbPeerCatchup({
            db, peerManager: local.manager, tables: ['price_snapshots'],
            getVerifier: () => verifier, fetchPage, pageSize: 10,
            logger: { warn: sinon.stub(), error: sinon.stub() }
        });

        await catchup.run();

        expect(fetchPage.calledOnceWithExactly(REMOTE_ADDR, 'price_snapshots', 0, 10)).to.equal(true);
        expect(verifier.calledOnce).to.equal(true);
        expect(db.setFinalizedPriceSnapshotRound.calledOnce).to.equal(true);
        expect(db.stored()).to.include({ status: 'finalized', price: '50000', created_at: CREATED_AT });
    });

    it('schedules catch-up only after the first inbound envelope proves the signer', async function () {
        const local = hub(LOCAL_ADDR);
        const remote = hub(REMOTE_ADDR);
        local.manager.setValidatorPubkeys(new Map());
        local.manager.setEffectiveSignerSet(new Set([remote.pubkey]));
        const fetchPage = sinon.stub().resolves({
            table: 'price_snapshots', schema_version: HUB_SCHEMA_VERSION, rows: []
        });
        const catchup = new HubDbPeerCatchup({
            db: {}, peerManager: local.manager, tables: ['price_snapshots'],
            getVerifier: () => async () => true, fetchPage,
            hasRow: async () => false, storeRow: async () => {},
            logger: { warn: sinon.stub(), error: sinon.stub() }
        });
        await catchup.start();

        connectInbound(remote, local);
        await catchup.runningPromise;
        catchup.stop();

        expect(fetchPage.calledOnceWithExactly(REMOTE_ADDR, 'price_snapshots', 0, 10000)).to.equal(true);
    });

    it('keeps the existing warning when an inbound signer announces a non-dialable protocol', async function () {
        const local = hub(LOCAL_ADDR);
        const remote = hub('ftp://remote.example:10002');
        local.manager.setValidatorPubkeys(new Map());
        local.manager.setEffectiveSignerSet(new Set([remote.pubkey]));
        connectInbound(remote, local);
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const fetchPage = sinon.stub();
        const catchup = new HubDbPeerCatchup({
            db: {}, peerManager: local.manager, tables: ['price_snapshots'],
            getVerifier: () => async () => true, fetchPage, logger
        });

        await catchup.run();

        expect(fetchPage.called).to.equal(false);
        expect(logger.warn.calledOnceWithExactly(
            'Hub DB peer catch-up: connected signer-set peer ftp://remote.example:10002 ' +
            'has no fetchable feed URL; skipping')).to.equal(true);
    });
});
