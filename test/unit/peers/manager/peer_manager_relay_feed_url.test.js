'use strict';
const sinon = require('sinon');
const { expect } = require('chai');
const PeerManager = require('../../../../src/peers/manager');
const { DB_METHODS } = require('../../../helpers/mockHub');

const SENDER = 'rValidator01';
const SENDER_FEED = 'ws://validator01.example:10002';
const RELAYERS = ['ws://validator02.example:10002', 'ws://validator03.example:10002'];
const RELAYER_ADDRS = ['rValidator02', 'rValidator03'];

let pm;
let messageSeq = 0;

function envelope(sender) {
    messageSeq += 1;
    return JSON.stringify({ id: 'relay-feed-' + messageSeq, type: 'T', sender, timestamp: Date.now(), data: {} });
}

function outboundPeer(feedUrl, validatorAddr) {
    return { ws: { _peerAddr: feedUrl }, inbound: false, state: 'open', feedUrl, validatorAddr, lastSeen: 0 };
}

// Delivers one message over the outbound connection the hub dialled to that peer.
function deliverOver(feedUrl, sender) {
    pm.handleInbound(pm.peers.get(feedUrl).ws, envelope(sender), feedUrl);
}

function connectsFor(addr) {
    const seen = [];
    pm.on('peer:connect', peerAddr => { if (peerAddr === addr) seen.push(peerAddr); });
    return seen;
}

describe('PeerManager relayed gossip and feed URLs', function () {
    beforeEach(function () {
        pm = new PeerManager({
            P2P_VALIDATOR_ADDR: 'rSelf', P2P_PORT: 0, P2P_HOST: '127.0.0.1', SEED_NODES: [],
            REQUIRE_SIGNATURES: false, P2P_MSG_DEDUP_TTL: 60000, P2P_MAX_PAYLOAD: 1048576,
            P2P_HEARTBEAT_INTERVAL: 15000, P2P_RECONNECT_BASE: 2000, P2P_RECONNECT_MAX: 60000
        }, { ...DB_METHODS, doQuery: sinon.stub().resolves([]) });
        pm.peers.set(SENDER, { ws: { _peerAddr: SENDER }, inbound: true, state: 'open', feedUrl: null,
            validatorAddr: SENDER, lastSeen: 0 });
        RELAYERS.forEach((url, i) => pm.peers.set(url, outboundPeer(url, RELAYER_ADDRS[i])));
    });
    afterEach(function () { sinon.restore(); });

    it('does not give a relayed sender the relaying peer feed URL', function () {
        deliverOver(RELAYERS[0], SENDER);
        expect(pm.validatorFeedUrls.has(SENDER)).to.equal(false);
        expect(pm.peers.get(SENDER).feedUrl).to.equal(null);
    });

    it('emits no peer:connect for a message another peer relayed', function () {
        const connects = connectsFor(SENDER);
        for (const relayer of [RELAYERS[0], RELAYERS[1], RELAYERS[0], RELAYERS[1]]) deliverOver(relayer, SENDER);
        expect(connects).to.deep.equal([]);
        expect(pm.peers.get(SENDER).feedUrl).to.equal(null);
    });

    it('still gives an inbound peer the feed URL of its own outbound connection', function () {
        pm.peers.set(SENDER_FEED, outboundPeer(SENDER_FEED, SENDER));
        const connects = connectsFor(SENDER);
        deliverOver(SENDER_FEED, SENDER);
        expect(pm.validatorFeedUrls.get(SENDER)).to.equal(SENDER_FEED);
        expect(pm.peers.get(SENDER).feedUrl).to.equal(SENDER_FEED);
        expect(connects).to.deep.equal([SENDER]);
    });
});
