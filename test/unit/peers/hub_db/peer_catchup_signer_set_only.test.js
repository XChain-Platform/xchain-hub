'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const WebSocket = require('ws');
const PeerManager = require('../../../../src/peers/manager');
const ValidatorIdentity = require('../../../../src/validators/identity');
const HubDbPeerCatchup = require('../../../../src/peers/hub_db/peer_catchup.js');

const PEER_URL = 'ws://validator01.example:10002';
const PEER_ID = 'mverifyA';

function makeHub(addr) {
    const manager = new PeerManager({ P2P_VALIDATOR_ADDR: addr, REQUIRE_SIGNATURES: true }, null);
    const keys = ValidatorIdentity.generate();
    manager.setIdentity(new ValidatorIdentity(keys.privkeyHex));
    return { manager, pubkey: keys.pubkeyHex.toLowerCase() };
}

// A testnet-shaped federation: membership is the chain-effective signer set and
// the validators table feeds nothing into validatorPubkeys.
function federation(signerSetHasPeer) {
    const local = makeHub('ws://local.example:10002');
    const remote = makeHub(PEER_ID);
    const members = [local.pubkey];
    if (signerSetHasPeer) members.push(remote.pubkey);
    local.manager.setValidatorPubkeys(new Map());
    local.manager.setEffectiveSignerSet(new Set(members));
    local.manager.peers.set(PEER_URL, {
        ws: { readyState: WebSocket.OPEN, send: () => {} }, state: 'open', lastSeen: null,
        inbound: false, validatorAddr: PEER_ID
    });
    const ws = { _peerAddr: PEER_URL, _remoteIp: '127.0.0.2' };
    return { local, remote, ws };
}

function deliver(f, type, data) {
    const envelope = f.remote.manager.buildEnvelope(type, data);
    f.local.manager.handleInbound(f.ws, JSON.stringify(envelope), PEER_URL);
}

function catchupFor(pm, fetchPage) {
    return new HubDbPeerCatchup({
        db: {}, peerManager: pm, tables: ['state_checkpoints', 'oracle_prices'],
        getVerifier: () => async () => true,
        fetchPage,
        hasRow: async () => false,
        storeRow: async () => ({ affectedRows: 1 }),
        pageSize: 10,
        warnIntervalMs: 60000,
        logger: { warn: sinon.stub(), error: sinon.stub() }
    });
}

describe('hub DB peer catch-up with membership only in the effective signer set', function () {
    it('returns the peer with its URL once it proves its key on an envelope with no api_url', function () {
        const f = federation(true);
        expect(f.local.manager.validatorPubkeys.size).to.equal(0);
        expect(HubDbPeerCatchup.connectedSignerPeers(f.local.manager)).to.deep.equal([]);

        deliver(f, 'CAPABILITY_SELF_TEST', { note: 'no api_url here' });

        const peer = f.local.manager.peers.get(PEER_URL);
        expect(peer.signing_pubkey).to.equal(f.remote.pubkey);
        expect(peer).to.not.have.property('api_url');
        expect(HubDbPeerCatchup.connectedSignerPeers(f.local.manager)).to.deep.equal([
            { addr: PEER_URL, identity: PEER_ID, feedUrl: PEER_URL }
        ]);
        expect(f.local.manager.getHubAdvertisements().map(h => h.signing_pubkey))
            .to.deep.equal([]);
    });

    it('is not a signer peer before any envelope, and fetches every table after one', async function () {
        const f = federation(true);
        const fetched = [];
        const fetchPage = async (peer, table, cursor) => {
            fetched.push(peer + ' ' + table + ' ' + cursor);
            return { table, rows: [] };
        };
        const catchup = catchupFor(f.local.manager, fetchPage);

        await catchup.run();
        expect(fetched).to.deep.equal([]);
        expect(catchup.lastUsablePeerCount).to.equal(0);

        deliver(f, 'HEARTBEAT', f.remote.manager.heartbeatData('test'));
        await catchup.run();

        expect(fetched.map(line => line.split(' ')[0])).to.satisfy(
            list => list.length >= 2 && list.every(url => url === PEER_URL));
        expect([...new Set(fetched.map(line => line.split(' ')[1]))])
            .to.have.members(['state_checkpoints', 'oracle_prices']);
        expect(catchup.lastUsablePeerCount).to.equal(1);
        expect(catchup.isCaughtUp()).to.equal(catchup.state.isCaughtUp());
        expect(catchup.isCaughtUp()).to.equal(true);
    });
});

describe('hub DB peer catch-up signer-set failure paths', function () {
    it('reports not caught up from table state when the peer feed fails', async function () {
        const f = federation(true);
        const catchup = catchupFor(f.local.manager, async () => { throw new Error('feed down'); });
        deliver(f, 'CAPABILITY_SELF_TEST', {});

        await catchup.run();

        expect(catchup.lastUsablePeerCount).to.equal(1);
        expect(catchup.isCaughtUp()).to.equal(false);
    });

    it('skips a peer whose recorded key is outside the signer set', async function () {
        const f = federation(false);
        const peer = f.local.manager.peers.get(PEER_URL);
        peer.signing_pubkey = f.remote.pubkey;
        const fetchPage = sinon.stub().resolves({ rows: [] });
        const catchup = catchupFor(f.local.manager, fetchPage);

        await catchup.run();

        expect(fetchPage.called).to.equal(false);
        expect(catchup.lastUsablePeerCount).to.equal(0);
    });
});
