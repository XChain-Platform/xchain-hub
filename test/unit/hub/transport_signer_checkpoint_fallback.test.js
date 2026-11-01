'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const XChainHub = require('../../../src/XChainHub.js');
const PeerManager = require('../../../src/peers/manager.js');
const ValidatorIdentity = require('../../../src/validators/identity.js');
const { DB_METHODS } = require('../../helpers/mockHub.js');

const COMMITTED_HEIGHT = 8503;
const CHAIN_HEIGHT = 8612;

function peerManager() {
    const config = {
        HUB_NETWORK: 'regtest',
        P2P_VALIDATOR_ADDR: 'ws://receiver:10001',
        P2P_PORT: 0,
        P2P_HOST: '127.0.0.1',
        SEED_NODES: [],
        REQUIRE_SIGNATURES: true,
        P2P_MSG_DEDUP_TTL: 60000,
        P2P_MAX_PAYLOAD: 1048576,
    };
    const db = { ...DB_METHODS, doQuery: sinon.stub().resolves([]) };
    const manager = new PeerManager(config, db);
    manager.setValidatorPubkeys(new Map());
    return manager;
}

function signedEnvelope(identity) {
    const envelope = {
        id: 'frozen-committed-peer-message',
        type: 'TEST',
        sender: 'ws://peer:10001',
        timestamp: Date.now(),
        data: { checkpoint: COMMITTED_HEIGHT },
        sig_pubkey: identity.getPubkeyHex().toLowerCase(),
    };
    envelope.sig = identity.signEnvelope(envelope);
    return envelope;
}

describe('transport signer checkpoint-height fallback', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('builds the boot signer set at the committed height and accepts a peer message', async function () {
        const identity = new ValidatorIdentity('11'.repeat(32));
        const manager = peerManager();
        const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'regtest' });
        hub.peerManager = manager;
        hub.resolveBtcLatestBlock = sinon.stub().resolves(null);
        hub.resolveBtcCheckpointHeights = sinon.stub().resolves({
            committedHeight: COMMITTED_HEIGHT,
            chainHeight: CHAIN_HEIGHT,
        });
        hub.capabilitySnapshot = {
            getActiveValidatorSnapshot: sinon.stub().resolves({
                validators: [{ pubkey: identity.getPubkeyHex() }],
            }),
        };

        await hub.refreshTransportSignerSet();

        expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.calledOnceWithExactly(
            COMMITTED_HEIGHT)).to.equal(true);
        expect(await hub.resolveBtcLatestBlock(), 'the general tip remains halted').to.equal(null);

        let accepted = null;
        manager.once('message', envelope => { accepted = envelope; });
        const ws = { _peerAddr: 'ws://peer:10001', _remoteIp: '127.0.0.2', send: sinon.stub() };
        manager.handleInbound(ws, JSON.stringify(signedEnvelope(identity)), 'ws://peer:10001');
        expect(accepted).to.include({
            id: 'frozen-committed-peer-message',
            sender: 'ws://peer:10001',
        });
    });

    it('warns once when neither boot height can build a signer set', async function () {
        const warnings = [];
        sinon.stub(console, 'warn').callsFake(line => warnings.push(String(line)));
        const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'regtest' });
        hub.peerManager = { setEffectiveSignerSet: sinon.stub() };
        hub.resolveBtcLatestBlock = sinon.stub().resolves(null);
        hub.resolveBtcCheckpointHeights = sinon.stub().resolves(null);
        hub.capabilitySnapshot = { getActiveValidatorSnapshot: sinon.stub() };

        await hub.refreshTransportSignerSet();
        await hub.refreshTransportSignerSet();

        const bootWarnings = warnings.filter(line => line.includes('no transport signer set available at boot'));
        expect(bootWarnings).to.have.lengthOf(1);
        expect(hub.peerManager.setEffectiveSignerSet.called).to.equal(false);
        expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.equal(false);
    });
});

describe('transport signer checkpoint-height fallback limits', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('keeps a last-known-good set instead of falling back to the committed height', async function () {
        sinon.stub(console, 'warn');
        const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'regtest' });
        const live = new Set(['aa'.repeat(32)]);
        hub.peerManager = { setEffectiveSignerSet: sinon.stub() };
        hub._transportSignerSet = live;
        hub._transportSignerSetAt = Date.now();
        hub.resolveBtcLatestBlock = sinon.stub().resolves(null);
        hub.resolveBtcCheckpointHeights = sinon.stub().resolves({
            committedHeight: 100,
            chainHeight: CHAIN_HEIGHT,
        });
        hub.capabilitySnapshot = { getActiveValidatorSnapshot: sinon.stub() };

        await hub.refreshTransportSignerSet();

        expect(hub.resolveBtcCheckpointHeights.called).to.equal(false);
        expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.equal(false);
        expect(hub.peerManager.setEffectiveSignerSet.called).to.equal(false);
        expect(hub._transportSignerSet).to.equal(live);
    });

    it('builds no set from a committed height of zero', async function () {
        const warnings = [];
        sinon.stub(console, 'warn').callsFake(line => warnings.push(String(line)));
        const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'regtest' });
        hub.peerManager = { setEffectiveSignerSet: sinon.stub() };
        hub.resolveBtcLatestBlock = sinon.stub().resolves(null);
        hub.resolveBtcCheckpointHeights = sinon.stub().resolves({ committedHeight: 0, chainHeight: 0 });
        hub.capabilitySnapshot = { getActiveValidatorSnapshot: sinon.stub() };

        await hub.refreshTransportSignerSet();

        expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.equal(false);
        expect(hub.peerManager.setEffectiveSignerSet.called).to.equal(false);
        expect(warnings.filter(line => line.includes('no transport signer set available at boot')))
            .to.have.lengthOf(1);
    });
});
